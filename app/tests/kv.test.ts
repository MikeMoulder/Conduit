import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { getJson, hsetJson, hvaluesJson, kv, withLock } from "../src/lib/kv";

/**
 * Tests for the shared store behind every record that outlives a request.
 *
 * What is protected is the behaviour the records rely on across two
 * processes: set-if-absent is what makes a claim or a one time code safe,
 * expiry is what keeps codes and locks from living for ever, and read-and-
 * delete is what lets a code be redeemed once. The file backend is tested
 * directly; the Upstash backend is tested for the exact commands it sends.
 */

let dir: string;
beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(tmpdir(), "kv-"));
  process.env.KV_FILE = path.join(dir, "kv.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("the file store", () => {
  it("is chosen when Upstash is not configured", () => {
    expect(kv().backend).to.equal("file");
  });

  it("sets only when absent with nx", async () => {
    expect(await kv().set("a", "1", { nx: true })).to.equal(true);
    expect(await kv().set("a", "2", { nx: true })).to.equal(false);
    expect(await kv().get("a")).to.equal("1");
  });

  it("expires a value", async () => {
    await kv().set("short", "x", { exSeconds: 0.05 });
    await new Promise((r) => setTimeout(r, 80));
    expect(await kv().get("short")).to.equal(null);
    // Expired counts as absent for nx too.
    expect(await kv().set("short", "y", { nx: true })).to.equal(true);
  });

  it("takes a value once with getdel", async () => {
    await kv().set("code", "wallet-a");
    expect(await kv().getdel("code")).to.equal("wallet-a");
    expect(await kv().getdel("code")).to.equal(null);
  });

  it("keeps hashes by field", async () => {
    await hsetJson("h", "x", { n: 1 });
    await hsetJson("h", "y", { n: 2 });
    await kv().hdel("h", "x");
    expect(await hvaluesJson("h")).to.deep.equal([{ n: 2 }]);
  });

  it("keeps lists newest first and trims them", async () => {
    for (const v of ["1", "2", "3", "4"]) await kv().lpush("l", v);
    await kv().ltrim("l", 0, 2);
    expect(await kv().lrange("l", 0, -1)).to.deep.equal(["4", "3", "2"]);
  });

  it("reads JSON back", async () => {
    await kv().set("j", JSON.stringify({ ok: true }));
    expect(await getJson("j")).to.deep.equal({ ok: true });
  });
});

describe("locks", () => {
  it("lets one holder in and turns a second away", async () => {
    let inner: string | null = "not run";
    const outer = await withLock("x", async () => {
      inner = await withLock("x", async () => "second");
      return "first";
    });
    expect(outer).to.equal("first");
    expect(inner).to.equal(null);
  });

  it("releases after the work, even when it throws", async () => {
    await withLock("y", async () => {
      throw new Error("boom");
    }).catch(() => null);
    expect(await withLock("y", async () => "again")).to.equal("again");
  });
});

describe("the Upstash store", () => {
  const realFetch = globalThis.fetch;
  let sent: unknown[][];
  let reply: unknown;

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token-not-real";
    sent = [];
    reply = "OK";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).to.equal("Bearer test-token-not-real");
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ result: reply }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is chosen when both settings are present", () => {
    expect(kv().backend).to.equal("upstash");
  });

  it("sends SET with NX and EX, prefixed", async () => {
    expect(await kv().set("code:abc", "wallet-a", { nx: true, exSeconds: 600 })).to.equal(true);
    expect(sent[0]).to.deep.equal(["SET", "conduit:code:abc", "wallet-a", "NX", "EX", 600]);
  });

  it("reads a refused NX as false", async () => {
    reply = null;
    expect(await kv().set("k", "v", { nx: true })).to.equal(false);
  });

  it("turns HGETALL's flat reply into an object", async () => {
    reply = ["a", "1", "b", "2"];
    expect(await kv().hgetall("h")).to.deep.equal({ a: "1", b: "2" });
  });

  it("raises an error Upstash reports rather than returning nothing", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "WRONGPASS" }), { status: 401 })) as typeof fetch;
    let caught = "";
    await kv().get("k").catch((e: Error) => (caught = e.message));
    expect(caught).to.include("WRONGPASS");
  });
});
