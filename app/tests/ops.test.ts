import { describe, it } from "node:test";
import { expect } from "chai";

import { AlertBook, REMIND_MS } from "../src/lib/ops/alerts";
import { findProblems, type HealthReading } from "../src/lib/ops/health";

/**
 * Tests for knowing when Conduit is broken and saying so.
 *
 * Written after the store refused every command for a day and a half while
 * the worker's log said "alive". What is protected: each kind of failure the
 * product depends on is found and explained in words that say what stopped,
 * and the operator hears about it once, is reminded while it lasts, and hears
 * when it is over, rather than every five minutes or never again.
 */

const healthy: HealthReading = {
  store: { ok: true },
  prices: [
    { symbol: "AAPL", ageSeconds: 60 },
    { symbol: "NVDA", ageSeconds: 120 },
  ],
  balances: [
    { name: "faucet", sol: 2 },
    { name: "agent", sol: 0.3 },
    { name: "publisher", sol: 3 },
  ],
  telegram: { enabled: true, lastPollAgoSeconds: 20, upSeconds: 3600 },
};

const keys = (r: HealthReading) => findProblems(r).map((p) => p.key);

describe("finding what is broken", () => {
  it("finds nothing when everything works", () => {
    expect(findProblems(healthy)).to.deep.equal([]);
  });

  it("says what stops when the store refuses", () => {
    const [problem] = findProblems({ ...healthy, store: { ok: false, error: "max requests limit exceeded" } });
    expect(problem.key).to.equal("store");
    expect(problem.text).to.include("max requests limit exceeded");
    expect(problem.text).to.include("Price triggers");
  });

  it("names the stale prices, and calls it a stopped publisher when every price is stale", () => {
    const one = findProblems({ ...healthy, prices: [{ symbol: "AAPL", ageSeconds: 60 }, { symbol: "SPACEX", ageSeconds: 3600 }] });
    expect(one[0].key).to.equal("prices:SPACEX");
    expect(one[0].text).to.include("SPACEX (60 minutes old)");

    const all = findProblems({ ...healthy, prices: [{ symbol: "AAPL", ageSeconds: 900 }, { symbol: "NVDA", ageSeconds: null }] });
    expect(all[0].key).to.equal("prices:all");
    expect(all[0].text).to.include("publisher looks stopped");
  });

  it("warns at eight minutes, before the program's ten minute refusal", () => {
    expect(keys({ ...healthy, prices: [{ symbol: "AAPL", ageSeconds: 7 * 60 }, { symbol: "NVDA", ageSeconds: 60 }] })).to.deep.equal([]);
    expect(keys({ ...healthy, prices: [{ symbol: "AAPL", ageSeconds: 9 * 60 }, { symbol: "NVDA", ageSeconds: 60 }] })).to.deep.equal(["prices:AAPL"]);
  });

  it("flags a key running out of SOL, and ignores one this process does not hold", () => {
    const problems = findProblems({
      ...healthy,
      balances: [
        { name: "faucet", sol: 0.04 },
        { name: "agent", sol: null },
        { name: "publisher", sol: 3 },
      ],
    });
    expect(problems.map((p) => p.key)).to.deep.equal(["balance:faucet"]);
    expect(problems[0].text).to.include("0.040 SOL");
  });

  it("flags a Telegram listener gone quiet, counting from start when it never polled", () => {
    expect(keys({ ...healthy, telegram: { enabled: true, lastPollAgoSeconds: 600, upSeconds: 3600 } })).to.deep.equal(["telegram"]);
    expect(keys({ ...healthy, telegram: { enabled: true, lastPollAgoSeconds: null, upSeconds: 60 } })).to.deep.equal([]);
    expect(keys({ ...healthy, telegram: { enabled: true, lastPollAgoSeconds: null, upSeconds: 600 } })).to.deep.equal(["telegram"]);
    expect(keys({ ...healthy, telegram: { enabled: false, lastPollAgoSeconds: null, upSeconds: 9999 } })).to.deep.equal([]);
  });

  it("flags a silent worker from the site, but not when the store is down and the heartbeat unreadable", () => {
    expect(keys({ ...healthy, telegram: undefined, workerHeartbeatAgoSeconds: 20 * 60 })).to.deep.equal(["worker"]);
    expect(keys({ ...healthy, telegram: undefined, workerHeartbeatAgoSeconds: null })).to.deep.equal(["worker"]);
    expect(keys({ ...healthy, telegram: undefined, workerHeartbeatAgoSeconds: 60 })).to.deep.equal([]);
    expect(keys({ ...healthy, telegram: undefined, store: { ok: false, error: "down" } })).to.deep.equal(["store"]);
  });
});

describe("when to tell the operator", () => {
  const store = { key: "store", text: "The shared store is refusing commands." };

  it("tells once when a problem appears, not on every check", () => {
    const book = new AlertBook();
    expect(book.update([store], 0)).to.have.length(1);
    expect(book.update([store], 5 * 60_000)).to.deep.equal([]);
    expect(book.update([store], 10 * 60_000)).to.deep.equal([]);
  });

  it("reminds while it lasts", () => {
    const book = new AlertBook();
    book.update([store], 0);
    const reminder = book.update([store], REMIND_MS);
    expect(reminder).to.have.length(1);
    expect(reminder[0]).to.match(/^Still broken after 6 hours/);
    expect(book.update([store], REMIND_MS + 5 * 60_000)).to.deep.equal([]);
  });

  it("says when it is over, and starts afresh if it comes back", () => {
    const book = new AlertBook();
    book.update([store], 0);
    const recovered = book.update([], 36 * 60_000);
    expect(recovered).to.deep.equal(["Recovered after 36 minutes: The shared store is refusing commands."]);
    expect(book.size).to.equal(0);
    expect(book.update([store], 40 * 60_000)[0]).to.match(/^Conduit problem:/);
  });

  it("keeps separate problems separate", () => {
    const book = new AlertBook();
    const prices = { key: "prices:SPACEX", text: "Stale on chain prices: SPACEX." };
    expect(book.update([store, prices], 0)).to.have.length(2);
    expect(book.update([prices], 60_000)).to.deep.equal([`Recovered after 1 minute: ${store.text}`]);
  });
});
