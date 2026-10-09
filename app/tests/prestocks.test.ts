import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "chai";

import { fetchPreStocks, resetPreStocksCache } from "../src/lib/prestocks";

/**
 * Tests for reading PreStocks while its firewall refuses some callers.
 *
 * Seen live on 2026-10-09: PreStocks, behind Vercel's firewall, answered the
 * server 403 for rounds at a time and sometimes refused the site too. A
 * failure was cached for thirty seconds like a success, so one refusal
 * blanked every pre IPO price. What is protected: a failure is never cached,
 * the last good read stands in for three minutes with its real fetch time,
 * and nothing older is passed off as current.
 */

const realFetch = globalThis.fetch;
const realNow = Date.now;
const OPENAI = { symbol: "OPENAI", contract_address: "Mint1111", markPrice: 1055, tokenPrice: 1320 };

let answers: Response[];
function answer(...responses: Response[]) {
  answers = responses;
  globalThis.fetch = (async () => answers.shift() ?? new Response("Forbidden", { status: 403 })) as typeof fetch;
}
const ok = () => new Response(JSON.stringify([OPENAI]), { status: 200 });
const refused = () => new Response("Forbidden", { status: 403 });

beforeEach(() => resetPreStocksCache());
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

describe("reading PreStocks through refusals", () => {
  it("serves the last good read, with its real fetch time, while refused", async () => {
    answer(ok(), refused());
    const first = await fetchPreStocks();
    expect(first.status).to.equal("ok");
    const fetchedAt = first.status === "ok" ? first.fetchedAt : 0;

    Date.now = () => realNow() + 40_000;
    const second = await fetchPreStocks();
    expect(second.status).to.equal("ok");
    expect(second.status === "ok" && second.fetchedAt).to.equal(fetchedAt);
    expect(second.status === "ok" && second.assets.get("OPENAI")?.tokenPrice).to.equal(1320);
  });

  it("never caches a refusal, so the next call tries again", async () => {
    answer(refused(), ok());
    expect((await fetchPreStocks()).status).to.equal("unavailable");
    expect((await fetchPreStocks()).status).to.equal("ok");
  });

  it("stops standing in after three minutes rather than pass an old read off as current", async () => {
    answer(ok(), refused());
    await fetchPreStocks();
    Date.now = () => realNow() + 4 * 60_000;
    const late = await fetchPreStocks();
    expect(late.status).to.equal("unavailable");
  });
});
