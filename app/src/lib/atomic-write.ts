import "server-only";

import { mkdirSync, renameSync, writeFileSync } from "fs";
import path from "path";

/**
 * Writes JSON so a reader never sees half a file.
 *
 * The value goes to a temporary file first and is renamed over the real one,
 * which is atomic on every filesystem the app runs on. On Windows the rename
 * can still be refused for a moment after the write, because antivirus or the
 * search indexer opens the fresh temporary file to look at it. That refusal
 * is transient, so it is retried with a short backoff. Anything else, or a
 * refusal that outlasts the retries, is thrown as it was.
 */

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Waits between attempts, in milliseconds. Five retries, about 310ms in all. */
const BACKOFF_MS = [10, 20, 40, 80, 160];

/**
 * Blocks the thread without spinning. The stores are synchronous by design,
 * so the wait has to be too, and this only ever runs on a refused rename.
 */
function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

type Rename = (from: string, to: string) => void;

export function writeJsonAtomic(
  file: string,
  value: unknown,
  /** Injected by tests to simulate a locked file. */
  rename: Rename = renameSync,
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));

  for (let attempt = 0; ; attempt++) {
    try {
      rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT.has(code) || attempt >= BACKOFF_MS.length) {
        throw error;
      }
      sleep(BACKOFF_MS[attempt]);
    }
  }
}
