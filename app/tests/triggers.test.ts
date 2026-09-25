import { beforeEach, describe, it } from "node:test";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  DEFAULT_RUNS,
  describeEvery,
  describeTrigger,
  describeWait,
  expiryFor,
  fireTime,
  isDue,
  isMet,
  nextCheck,
  validateRepeat,
  targetPrice,
  validate,
  type Condition,
  type Trigger,
} from "../src/lib/triggers/rules";
import { activeTriggers, addTrigger, cancelTrigger, listTriggers, transition } from "../src/lib/triggers/state";

/**
 * Tests for price triggers: "when NVDA rises 2.5%, message me and buy $500".
 *
 * What is protected is that a trigger fires exactly when its condition holds
 * and exactly once. A rise must not fire on a fall, a condition already true
 * when it is set is refused rather than fired at once, and a trigger claimed
 * by one pass cannot be fired by another, because a buy placed twice is money
 * the owner did not mean to spend.
 */

let dir: string;
beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(tmpdir(), "triggers-"));
  process.env.KV_FILE = path.join(dir, "kv.json");
});

const at = (condition: Condition, basePrice = 226) => ({ condition, basePrice });

describe("when a condition holds", () => {
  it("fires a 2.5% rise at the target and above, not below it", async () => {
    const t = at({ kind: "rise", percent: 2.5 }, 200);
    expect(targetPrice(t.condition, 200)).to.be.closeTo(205, 1e-9);
    expect(isMet(t, 204.99)).to.equal(false);
    expect(isMet(t, 205)).to.equal(true);
    expect(isMet(t, 230)).to.equal(true);
  });

  it("fires a fall at the target and below", async () => {
    const t = at({ kind: "fall", percent: 10 }, 200);
    expect(isMet(t, 180.01)).to.equal(false);
    expect(isMet(t, 180)).to.equal(true);
  });

  it("never fires a rise on a fall, or a fall on a rise", async () => {
    expect(isMet(at({ kind: "rise", percent: 2.5 }, 200), 150)).to.equal(false);
    expect(isMet(at({ kind: "fall", percent: 2.5 }, 200), 250)).to.equal(false);
  });

  it("fires above and below at fixed prices", async () => {
    expect(isMet(at({ kind: "above", price: 230 }), 229.99)).to.equal(false);
    expect(isMet(at({ kind: "above", price: 230 }), 230)).to.equal(true);
    expect(isMet(at({ kind: "below", price: 220 }), 220.01)).to.equal(false);
    expect(isMet(at({ kind: "below", price: 220 }), 219)).to.equal(true);
  });
});

describe("what can be set", () => {
  it("refuses a price level that is already passed", async () => {
    expect(validate({ kind: "above", price: 200 }, 226)).to.equal("It is already above that: the price is $226.00.");
    expect(validate({ kind: "below", price: 250 }, 226)).to.equal("It is already below that: the price is $226.00.");
  });

  it("refuses a zero or impossible percentage", async () => {
    expect(validate({ kind: "rise", percent: 0 }, 226)).to.not.equal(null);
    expect(validate({ kind: "fall", percent: 100 }, 226)).to.not.equal(null);
  });

  it("refuses a condition with no price to measure from", async () => {
    expect(validate({ kind: "rise", percent: 2 }, 0)).to.not.equal(null);
  });

  it("accepts the ordinary cases", async () => {
    expect(validate({ kind: "rise", percent: 2.5 }, 226)).to.equal(null);
    expect(validate({ kind: "above", price: 240 }, 226)).to.equal(null);
    expect(validate({ kind: "below", price: 210 }, 226)).to.equal(null);
  });

  it("says the whole trigger in one sentence", async () => {
    expect(
      describeTrigger({
        symbol: "NVDA",
        condition: { kind: "rise", percent: 2.5 },
        basePrice: 226,
        action: { kind: "buy", dollars: 500 },
      }),
    ).to.equal("When NVDA rises 2.5% (to $231.65), message you and buy $500.00 of NVDA.");
    expect(
      describeTrigger({ symbol: "SPY", condition: { kind: "above", price: 780 }, basePrice: 769, action: { kind: "notify" } }),
    ).to.equal("When SPY reaches $780.00 or more, message you.");
  });
});

describe("timed triggers", () => {
  const setAt = 1_000_000;
  const timed = (minutes: number) => ({ condition: { kind: "after", minutes } as Condition, basePrice: 338.68, createdAt: setAt });

  it("fires at its time and not a moment before, whatever the price", async () => {
    const t = timed(2);
    expect(isMet(t, 338.68, setAt + 119_999)).to.equal(false);
    expect(isMet(t, 338.68, setAt + 120_000)).to.equal(true);
    expect(isMet(t, 1, setAt + 180_000)).to.equal(true);
    expect(isMet(t, 9_999, setAt + 180_000)).to.equal(true);
  });

  it("never fires without knowing when it was set", async () => {
    expect(isMet({ condition: { kind: "after", minutes: 2 }, basePrice: 338.68 }, 338.68, Date.now() + 1e12)).to.equal(false);
  });

  it("knows when it is due, and a price trigger has no time", async () => {
    expect(fireTime({ condition: { kind: "after", minutes: 2 }, createdAt: setAt })).to.equal(setAt + 120_000);
    expect(fireTime({ condition: { kind: "rise", percent: 2 }, createdAt: setAt })).to.equal(null);
  });

  it("expires ten minutes after its time rather than days later", async () => {
    expect(expiryFor({ kind: "after", minutes: 2 }, setAt)).to.equal(setAt + 120_000 + 600_000);
    expect(expiryFor({ kind: "rise", percent: 2 }, setAt, 7)).to.equal(setAt + 7 * 86_400_000);
  });

  it("refuses a wait under a minute or over thirty days", async () => {
    expect(validate({ kind: "after", minutes: 0.5 }, 338.68)).to.not.equal(null);
    expect(validate({ kind: "after", minutes: 30 * 1440 + 1 }, 338.68)).to.not.equal(null);
    expect(validate({ kind: "after", minutes: 2 }, 338.68)).to.equal(null);
  });

  it("says the wait in plain words", async () => {
    expect(describeWait(1)).to.equal("1 minute");
    expect(describeWait(2)).to.equal("2 minutes");
    expect(describeWait(90)).to.equal("1 hour 30 minutes");
    expect(describeWait(1440 * 3)).to.equal("3 days");
    expect(
      describeTrigger({ symbol: "AAPL", condition: { kind: "after", minutes: 2 }, basePrice: 338.68, action: { kind: "buy", dollars: 50 } }),
    ).to.equal("2 minutes after it is set, message you and buy $50.00 of AAPL.");
    expect(
      describeTrigger({ symbol: "TSLA", condition: { kind: "after", minutes: 30 }, basePrice: 376, action: { kind: "notify" } }),
    ).to.equal("30 minutes after it is set, message you the price of TSLA.");
  });

  it("is kept and claimed once like any other trigger", async () => {
    const now = Date.now();
    const t = await addTrigger({
      owner: "owner-a",
      symbol: "AAPL",
      condition: { kind: "after", minutes: 2 },
      basePrice: 338.68,
      action: { kind: "buy", dollars: 50 },
      createdAt: now,
      expiresAt: expiryFor({ kind: "after", minutes: 2 }, now),
    });
    expect(fireTime(t)).to.equal(now + 120_000);
    expect(await transition(t.id, "active", "firing")).to.not.equal(null);
    expect(await transition(t.id, "active", "firing")).to.equal(null);
  });
});

describe("repeating triggers", () => {
  const setAt = 1_000_000;
  const every10 = { everyMinutes: 10, maxRuns: 5 };

  it("acts at each check time when there is no price condition", async () => {
    const t = { condition: { kind: "always" } as Condition, basePrice: 300, createdAt: setAt, repeat: every10, nextAt: setAt + 600_000 };
    expect(isDue(t, 300, setAt + 599_999)).to.equal(false);
    expect(isDue(t, 300, setAt + 600_000)).to.equal(true);
  });

  it("acts at a check time only while the price condition holds", async () => {
    const t = { condition: { kind: "above", price: 180 } as Condition, basePrice: 175, createdAt: setAt, repeat: every10, nextAt: setAt };
    expect(isDue(t, 179.99, setAt)).to.equal(false);
    expect(isDue(t, 180, setAt)).to.equal(true);
    // Between checks, even a price that holds does nothing.
    expect(isDue({ ...t, nextAt: setAt + 600_000 }, 200, setAt + 1)).to.equal(false);
  });

  it("allows a level that already holds, since it acts while it holds", async () => {
    expect(validate({ kind: "above", price: 180 }, 200, true)).to.equal(null);
    expect(validate({ kind: "above", price: 180 }, 200)).to.not.equal(null);
  });

  it("stays on its grid, and restarts from now after a long gap instead of catching up", async () => {
    expect(nextCheck(setAt, 10, setAt + 30_000)).to.equal(setAt + 600_000);
    expect(nextCheck(setAt, 10, setAt + 700_000)).to.equal(setAt + 700_000 + 600_000);
  });

  it("refuses a repeat that is too fast, too many, or also delayed", async () => {
    expect(validateRepeat({ kind: "always" }, undefined)).to.not.equal(null);
    expect(validateRepeat({ kind: "always" }, { everyMinutes: 0.5, maxRuns: 5 })).to.not.equal(null);
    expect(validateRepeat({ kind: "always" }, { everyMinutes: 10, maxRuns: 201 })).to.not.equal(null);
    expect(validateRepeat({ kind: "always" }, { everyMinutes: 10, maxRuns: 2.5 })).to.not.equal(null);
    expect(validateRepeat({ kind: "after", minutes: 5 }, every10)).to.not.equal(null);
    expect(validateRepeat({ kind: "always" }, { everyMinutes: 1440, maxRuns: 40 })).to.not.equal(null);
    expect(validateRepeat({ kind: "always" }, every10)).to.equal(null);
    expect(validateRepeat({ kind: "rise", percent: 2 }, undefined)).to.equal(null);
  });

  it("ends a plain schedule after its last run, and a conditional one after its days", async () => {
    expect(expiryFor({ kind: "always" }, setAt, 7, every10)).to.equal(setAt + 4 * 600_000 + 600_000);
    expect(expiryFor({ kind: "above", price: 180 }, setAt, 7, every10)).to.equal(setAt + 7 * 86_400_000);
  });

  it("reports its next check as its fire time", async () => {
    expect(fireTime({ condition: { kind: "always" }, createdAt: setAt, repeat: every10, nextAt: setAt + 600_000 })).to.equal(setAt + 600_000);
  });

  it("says the schedule and the most it can spend", async () => {
    expect(describeEvery(10)).to.equal("every 10 minutes");
    expect(describeEvery(60)).to.equal("every hour");
    expect(
      describeTrigger({ symbol: "AAPL", condition: { kind: "always" }, basePrice: 338.68, action: { kind: "buy", dollars: 20 }, repeat: { everyMinutes: 10, maxRuns: DEFAULT_RUNS } }),
    ).to.equal("Every 10 minutes, buy $20.00 of AAPL, 10 times at most, $200.00 in all.");
    expect(
      describeTrigger({ symbol: "NVDA", condition: { kind: "above", price: 180 }, basePrice: 175, action: { kind: "buy", dollars: 100 }, repeat: every10 }),
    ).to.equal("Every 10 minutes, if NVDA reaches $180.00 or more, buy $100.00 of NVDA, 5 times at most, $500.00 in all.");
  });

  it("goes back to watching after a run, with its count and next check", async () => {
    const now = Date.now();
    const t = await addTrigger({
      owner: "owner-a",
      symbol: "AAPL",
      condition: { kind: "always" },
      basePrice: 338.68,
      action: { kind: "buy", dollars: 20 },
      createdAt: now,
      expiresAt: expiryFor({ kind: "always" }, now, 7, every10),
      repeat: every10,
      runs: 0,
      nextAt: now,
    });
    expect(await transition(t.id, "active", "firing")).to.not.equal(null);
    const back = await transition(t.id, "firing", "active", { runs: 1, nextAt: nextCheck(now, 10, now) });
    expect(back?.runs).to.equal(1);
    expect(back?.nextAt).to.equal(now + 600_000);
    expect(await activeTriggers()).to.have.length(1);
    // And can still be cancelled between runs.
    expect((await cancelTrigger("owner-a", t.id))?.status).to.equal("cancelled");
  });
});

describe("keeping triggers", () => {
  const base = (owner = "owner-a"): Omit<Trigger, "id" | "status"> => ({
    owner,
    symbol: "NVDA",
    condition: { kind: "rise", percent: 2.5 },
    basePrice: 226,
    action: { kind: "buy", dollars: 500 },
    createdAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
  });

  it("starts a trigger active and lists it for its owner only", async () => {
    const t = await addTrigger(base());
    expect(t.status).to.equal("active");
    expect(await listTriggers("owner-a")).to.have.length(1);
    expect(await listTriggers("owner-b")).to.have.length(0);
  });

  it("lets a trigger be claimed for firing once", async () => {
    const t = await addTrigger(base());
    expect(await transition(t.id, "active", "firing")).to.not.equal(null);
    // A second pass finds it already claimed.
    expect(await transition(t.id, "active", "firing")).to.equal(null);
    expect(await activeTriggers()).to.have.length(0);
  });

  it("cannot cancel a trigger that has fired", async () => {
    const t = await addTrigger(base());
    await transition(t.id, "active", "firing");
    await transition(t.id, "firing", "fired", { result: "Bought." });
    expect(await cancelTrigger("owner-a", t.id)).to.equal(null);
    expect((await listTriggers("owner-a"))[0].status).to.equal("fired");
  });

  it("lets exactly one of a cancel and a fire win when they race", async () => {
    // The site cancelling while the worker claims the same trigger: one of
    // them must see it already moved, or a cancelled trigger would still buy.
    const t = await addTrigger(base());
    const [cancelled, claimed] = await Promise.all([
      cancelTrigger("owner-a", t.id),
      transition(t.id, "active", "firing"),
    ]);
    expect([cancelled, claimed].filter((x) => x !== null)).to.have.length(1);
  });

  it("cancels only the owner's own trigger", async () => {
    const t = await addTrigger(base());
    expect(await cancelTrigger("owner-b", t.id)).to.equal(null);
    expect((await cancelTrigger("owner-a", t.id))?.status).to.equal("cancelled");
    expect(await activeTriggers()).to.have.length(0);
  });
});
