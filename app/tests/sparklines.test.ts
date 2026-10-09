import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { kv, storeCommands } from "../src/lib/kv";
import { dayLines, forgetDayLines, refreshDayLines } from "../src/lib/sparklines";

/**
 * Tests for how the market cards' day lines spend the shared store.
 *
 * The store's free plan is a monthly allowance of commands, and the minute
 * by minute refresh used to spend most of it reading back what it had just
 * written. What is protected here is the count: a pass with nothing stale
 * sends no command at all, a restart reads each mint once, and a reader asks
 * for any number of lines in one command and not again for a minute.
 */

const MINT = "TestMint1111111111111111111111111111111111";
const POOL = "TestPool1111111111111111111111111111111111";
const HOUR = 3_600;

let dir: string;
const realFetch = globalThis.fetch;
let geckoCalls: string[];

function storePool(at = Date.now()) {
  return kv().set(`spark:pool:v2:${MINT}`, JSON.stringify({ address: POOL, at }));
}

beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(tmpdir(), "spark-"));
  process.env.KV_FILE = path.join(dir, "kv.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  forgetDayLines();

  geckoCalls = [];
  const now = Math.floor(Date.now() / 1000);
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    geckoCalls.push(url);
    // Newest first, as GeckoTerminal sends them.
    const ohlcv_list = [
      [now, 0, 0, 0, 102, 1],
      [now - HOUR, 0, 0, 0, 101, 1],
      [now - 2 * HOUR, 0, 0, 0, 100, 1],
    ];
    return new Response(JSON.stringify({ data: { attributes: { ohlcv_list } } }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("refreshing day lines", () => {
  it("writes a missing line, oldest point first", async () => {
    await storePool();
    await refreshDayLines([MINT]);
    expect(geckoCalls).to.have.length(1);
    expect(geckoCalls[0]).to.include(`/pools/${POOL}/ohlcv/hour`);
    expect(await dayLines([MINT])).to.deep.equal({ [MINT]: [100, 101, 102] });
  });

  it("sends no store command and no request on a pass with nothing stale", async () => {
    await storePool();
    await refreshDayLines([MINT]);
    const before = storeCommands();
    const calls = geckoCalls.length;

    await refreshDayLines([MINT]);
    await refreshDayLines([MINT]);

    expect(storeCommands() - before).to.equal(0);
    expect(geckoCalls.length).to.equal(calls);
  });

  it("reads each mint's stored pool and line once after a restart, then nothing", async () => {
    await storePool();
    await refreshDayLines([MINT]);
    forgetDayLines();

    const before = storeCommands();
    await refreshDayLines([MINT]);
    expect(storeCommands() - before).to.equal(2);
    // Both were fresh in the store, so nothing was fetched again.
    expect(geckoCalls).to.have.length(1);

    await refreshDayLines([MINT]);
    expect(storeCommands() - before).to.equal(2);
  });
});

describe("reading day lines", () => {
  it("asks for any number of lines in one command, then not again for a minute", async () => {
    const mints = ["m1", "m2", "m3", "m4", "m5", "m6"];
    await kv().set("spark:line:m2", JSON.stringify({ points: [1, 2], at: Date.now() }));

    const before = storeCommands();
    const first = await dayLines(mints);
    expect(storeCommands() - before).to.equal(1);
    expect(first.m2).to.deep.equal([1, 2]);
    expect(first.m1).to.deep.equal([]);

    await dayLines(mints);
    await dayLines(["m2"]);
    expect(storeCommands() - before).to.equal(1);
  });

  it("returns empty lines when the store refuses, and asks again next time", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token-not-real";
    let refuse = true;
    globalThis.fetch = (async () =>
      refuse
        ? new Response(JSON.stringify({ error: "ERR max requests limit exceeded" }), { status: 400 })
        : new Response(JSON.stringify({ result: [JSON.stringify({ points: [5, 6], at: Date.now() })] }), {
            status: 200,
          })) as typeof fetch;

    expect(await dayLines(["m1"])).to.deep.equal({ m1: [] });
    refuse = false;
    expect(await dayLines(["m1"])).to.deep.equal({ m1: [5, 6] });
  });
});
