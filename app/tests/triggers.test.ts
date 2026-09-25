import { beforeEach, describe, it } from "node:test";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  describeTrigger,
  isMet,
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
