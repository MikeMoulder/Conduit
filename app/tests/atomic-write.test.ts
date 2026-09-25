import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { writeJsonAtomic } from "../src/lib/atomic-write";

/**
 * Tests for the atomic JSON writer the autopilot and Telegram stores share.
 *
 * The rename is injected so a locked file can be simulated on any platform.
 * On Windows antivirus or the indexer can refuse the rename for a moment
 * after the write, and that is the case these exist for.
 */

function refusing(code: string, times: number) {
  let calls = 0;
  const rename = (from: string, to: string) => {
    calls += 1;
    if (calls <= times) {
      throw Object.assign(new Error(`${code}: simulated`), { code });
    }
    renameSync(from, to);
  };
  return { rename, calls: () => calls };
}

describe("atomic JSON writes", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "atomic-"));
    file = path.join(dir, "nested", "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the value and leaves no temporary file behind", () => {
    writeJsonAtomic(file, { a: 1 });
    expect(JSON.parse(readFileSync(file, "utf8"))).to.deep.equal({ a: 1 });
    expect(existsSync(`${file}.tmp`)).to.equal(false);
  });

  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    it(`retries a rename refused with ${code} and then succeeds`, () => {
      const lock = refusing(code, 2);
      writeJsonAtomic(file, { b: 2 }, lock.rename);
      expect(lock.calls()).to.equal(3);
      expect(JSON.parse(readFileSync(file, "utf8"))).to.deep.equal({ b: 2 });
    });
  }

  it("gives up after five retries and throws the original error", () => {
    const lock = refusing("EPERM", Infinity);
    expect(() => writeJsonAtomic(file, { c: 3 }, lock.rename)).to.throw("EPERM");
    expect(lock.calls()).to.equal(6);
  });

  it("does not retry an error that is not transient", () => {
    const lock = refusing("ENOENT", Infinity);
    expect(() => writeJsonAtomic(file, { d: 4 }, lock.rename)).to.throw("ENOENT");
    expect(lock.calls()).to.equal(1);
  });
});
