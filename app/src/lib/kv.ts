import "server-only";

import { readFileSync } from "fs";
import path from "path";

import { writeJsonAtomic } from "./atomic-write";

/**
 * The one place Conduit keeps records that outlive a request: Telegram links,
 * the autopilot's entries and log, price triggers, the chart cache.
 *
 * Two processes share them once the site runs on Vercel and the background
 * jobs on a worker: the site sets a trigger, the worker fires it. Files on
 * one machine cannot be shared that way, so the records live in Redis, on
 * Upstash, when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set.
 * Without them, a JSON file stands in with the same behaviour, which is what
 * local development and the tests use.
 *
 * Deliberately small: strings with set-if-absent and expiry, hashes and
 * lists. Records are kept one per key or field, never as one document that
 * two processes read, change and write back, because that is how one of them
 * silently loses the other's change.
 */

export interface SetOptions {
  /** Only set when the key does not exist. The basis of every claim and lock. */
  nx?: boolean;
  /** Expire after this many seconds. */
  exSeconds?: number;
}

export interface Kv {
  get(key: string): Promise<string | null>;
  /** True when the value was written; false when nx found the key present. */
  set(key: string, value: string, options?: SetOptions): Promise<boolean>;
  /** Reads and deletes in one step, so a one time value is taken once. */
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<void>;
  hdel(key: string, field: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  lpush(key: string, value: string): Promise<void>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  readonly backend: "upstash" | "file";
}

const prefix = () => process.env.CONDUIT_KV_PREFIX ?? "conduit:";

/* ------------------------------------------------------------------------ */
/* Upstash, over its REST API                                                */
/* ------------------------------------------------------------------------ */

function upstash(url: string, token: string): Kv {
  const k = (key: string) => `${prefix()}${key}`;

  async function cmd(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json().catch(() => ({ error: `http ${response.status}` }))) as {
      result?: unknown;
      error?: string;
    };
    if (body.error) throw new Error(`kv ${String(args[0])}: ${body.error}`);
    return body.result ?? null;
  }

  return {
    backend: "upstash",
    async get(key) {
      return (await cmd(["GET", k(key)])) as string | null;
    },
    async set(key, value, options = {}) {
      const args: (string | number)[] = ["SET", k(key), value];
      if (options.nx) args.push("NX");
      if (options.exSeconds) args.push("EX", Math.max(1, Math.round(options.exSeconds)));
      return (await cmd(args)) === "OK";
    },
    async getdel(key) {
      return (await cmd(["GETDEL", k(key)])) as string | null;
    },
    async del(key) {
      await cmd(["DEL", k(key)]);
    },
    async hget(key, field) {
      return (await cmd(["HGET", k(key), field])) as string | null;
    },
    async hset(key, field, value) {
      await cmd(["HSET", k(key), field, value]);
    },
    async hdel(key, field) {
      await cmd(["HDEL", k(key), field]);
    },
    async hgetall(key) {
      const flat = ((await cmd(["HGETALL", k(key)])) as string[] | null) ?? [];
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
      return out;
    },
    async lpush(key, value) {
      await cmd(["LPUSH", k(key), value]);
    },
    async ltrim(key, start, stop) {
      await cmd(["LTRIM", k(key), start, stop]);
    },
    async lrange(key, start, stop) {
      return ((await cmd(["LRANGE", k(key), start, stop])) as string[] | null) ?? [];
    },
  };
}

/* ------------------------------------------------------------------------ */
/* A file, for local development and tests                                   */
/* ------------------------------------------------------------------------ */

interface FileShape {
  strings: Record<string, { v: string; exp?: number }>;
  hashes: Record<string, Record<string, string>>;
  lists: Record<string, string[]>;
}

/**
 * The same operations over one JSON file. Every call reads, changes and
 * writes the file synchronously, so within one process calls cannot
 * interleave; it is not meant to be shared between processes, which is what
 * Upstash is for.
 */
function file(filePath: string): Kv {
  const load = (): FileShape => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<FileShape>;
      return { strings: parsed.strings ?? {}, hashes: parsed.hashes ?? {}, lists: parsed.lists ?? {} };
    } catch {
      return { strings: {}, hashes: {}, lists: {} };
    }
  };
  const save = (data: FileShape) => {
    const now = Date.now();
    for (const [key, entry] of Object.entries(data.strings)) {
      if (entry.exp !== undefined && entry.exp <= now) delete data.strings[key];
    }
    writeJsonAtomic(filePath, data);
  };
  const live = (data: FileShape, key: string) => {
    const entry = data.strings[key];
    return entry && (entry.exp === undefined || entry.exp > Date.now()) ? entry : null;
  };
  const k = (key: string) => `${prefix()}${key}`;

  return {
    backend: "file",
    async get(key) {
      return live(load(), k(key))?.v ?? null;
    },
    async set(key, value, options = {}) {
      const data = load();
      if (options.nx && live(data, k(key))) return false;
      data.strings[k(key)] = {
        v: value,
        ...(options.exSeconds ? { exp: Date.now() + options.exSeconds * 1000 } : {}),
      };
      save(data);
      return true;
    },
    async getdel(key) {
      const data = load();
      const entry = live(data, k(key));
      if (!entry) return null;
      delete data.strings[k(key)];
      save(data);
      return entry.v;
    },
    async del(key) {
      const data = load();
      delete data.strings[k(key)];
      delete data.hashes[k(key)];
      delete data.lists[k(key)];
      save(data);
    },
    async hget(key, field) {
      return load().hashes[k(key)]?.[field] ?? null;
    },
    async hset(key, field, value) {
      const data = load();
      (data.hashes[k(key)] ??= {})[field] = value;
      save(data);
    },
    async hdel(key, field) {
      const data = load();
      if (data.hashes[k(key)]) delete data.hashes[k(key)][field];
      save(data);
    },
    async hgetall(key) {
      return { ...(load().hashes[k(key)] ?? {}) };
    },
    async lpush(key, value) {
      const data = load();
      (data.lists[k(key)] ??= []).unshift(value);
      save(data);
    },
    async ltrim(key, start, stop) {
      const data = load();
      const list = data.lists[k(key)] ?? [];
      data.lists[k(key)] = list.slice(start, stop < 0 ? list.length + stop + 1 : stop + 1);
      save(data);
    },
    async lrange(key, start, stop) {
      const list = load().lists[k(key)] ?? [];
      return list.slice(start, stop < 0 ? list.length + stop + 1 : stop + 1);
    },
  };
}

/* ------------------------------------------------------------------------ */

/** The store, chosen by configuration each time so tests can switch it. */
export function kv(): Kv {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) return upstash(url, token);
  // Vercel's disk is read only and not shared between requests, so a file
  // store there would fail on the first write, or worse, seem to work and
  // forget. Said plainly instead.
  if (process.env.VERCEL) {
    throw new Error(
      "On Vercel the shared store must be Upstash: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  }
  return file(process.env.KV_FILE ?? path.join(process.cwd(), ".data", "kv.json"));
}

/* JSON helpers, since every record here is an object. */

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await kv().get(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function hgetJson<T>(key: string, field: string): Promise<T | null> {
  const raw = await kv().hget(key, field);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function hsetJson(key: string, field: string, value: unknown): Promise<void> {
  await kv().hset(key, field, JSON.stringify(value));
}

export async function hvaluesJson<T>(key: string): Promise<T[]> {
  return Object.values(await kv().hgetall(key)).map((raw) => JSON.parse(raw) as T);
}

/**
 * Runs `work` while holding a short lock on `name`, or returns null when
 * someone else holds it.
 *
 * For the few changes that must read, decide and write as one step across
 * processes, such as a trigger being cancelled from the site while the worker
 * is firing it. The lock expires on its own, so a process that dies holding
 * it cannot block the record for ever.
 */
export async function withLock<T>(name: string, work: () => Promise<T>, seconds = 60): Promise<T | null> {
  const key = `lock:${name}`;
  if (!(await kv().set(key, String(Date.now()), { nx: true, exSeconds: seconds }))) return null;
  try {
    return await work();
  } finally {
    await kv().del(key);
  }
}
