import { describe, it } from "node:test";
import { expect } from "chai";

import {
  advanceScore,
  describeScore,
  recordTrade,
  startScore,
  summarise,
  valueOf,
  type Snapshot,
} from "../src/lib/autopilot/scorecard";

/**
 * Tests for the autopilot's scorecard against SPY.
 *
 * What is protected is the honesty of one number. The agent must be credited
 * with what the market did to what it chose to hold, and nothing else: not
 * the owner's deposits, not their withdrawals, not a price feed going quiet.
 * And the cost of its own trading must count against it.
 *
 * The book used throughout: $1,000 cash and 10 NVDA at $100, so $2,000, with
 * SPY at $500.
 */

const T0 = Date.UTC(2026, 8, 25, 8, 10);

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  at: T0,
  cash: 1_000,
  amounts: { NVDA: 10 },
  prices: { NVDA: 100 },
  spyPrice: 500,
  ...over,
});

describe("starting a score", () => {
  it("values the book and treats all of it as money put in", () => {
    const state = startScore(snap());
    expect(valueOf(state.last)).to.equal(2_000);
    expect(state.netInvested).to.equal(2_000);
    expect(state.index).to.equal(1);
    expect(state.shadowSpyUnits).to.equal(4);
  });
});

describe("performance", () => {
  it("credits a market move on what was held", () => {
    const { state, flow } = advanceScore(startScore(snap()), snap({ prices: { NVDA: 110 }, spyPrice: 505 }));
    const score = summarise(state);
    expect(flow).to.equal(0);
    expect(score.returnPct).to.be.closeTo(5, 1e-9);
    expect(score.spyReturnPct).to.be.closeTo(1, 1e-9);
    expect(score.aheadPts).to.be.closeTo(4, 1e-9);
    expect(score.value).to.equal(2_100);
    expect(score.spyValue).to.be.closeTo(2_020, 1e-9);
  });

  it("does not credit a deposit as performance", () => {
    const { state, flow } = advanceScore(startScore(snap()), snap({ cash: 2_000 }));
    expect(flow).to.equal(1_000);
    expect(summarise(state).returnPct).to.equal(0);
    expect(state.netInvested).to.equal(3_000);
  });

  it("does not count a withdrawal as a loss", () => {
    const { state, flow } = advanceScore(startScore(snap()), snap({ cash: 500 }));
    expect(flow).to.equal(-500);
    expect(summarise(state).returnPct).to.equal(0);
  });

  it("separates a deposit from a market move in the same period", () => {
    const { state, flow } = advanceScore(
      startScore(snap()),
      snap({ cash: 2_000, prices: { NVDA: 90 } }),
    );
    expect(flow).to.equal(1_000);
    expect(summarise(state).returnPct).to.be.closeTo(-5, 1e-9);
  });

  it("puts deposits into the SPY comparison at the price of the day", () => {
    const { state } = advanceScore(startScore(snap()), snap({ cash: 2_000, spyPrice: 400 }));
    // 4 units from the start, plus $1,000 at $400.
    expect(state.shadowSpyUnits).to.be.closeTo(6.5, 1e-9);
    expect(summarise(state).spyValue).to.be.closeTo(2_600, 1e-9);
  });

  it("chains periods rather than adding them", () => {
    let state = startScore(snap());
    state = advanceScore(state, snap({ prices: { NVDA: 110 } })).state;
    state = advanceScore(state, snap({ prices: { NVDA: 121 } })).state;
    // 2000 to 2100 is 5%, then 2100 to 2210 is about 5.24%.
    expect(summarise(state).returnPct).to.be.closeTo((2_210 / 2_000 - 1) * 100, 1e-9);
  });

  it("reads a quiet price feed as no move, not as a withdrawal", () => {
    const { state, flow } = advanceScore(startScore(snap()), snap({ prices: {} }));
    expect(flow).to.equal(0);
    expect(summarise(state).returnPct).to.equal(0);
  });

  it("ignores differences below a cent", () => {
    const { flow } = advanceScore(startScore(snap()), snap({ cash: 1_000.004 }));
    expect(flow).to.equal(0);
  });
});

describe("trading", () => {
  it("costs nothing when it fills at the price the book is valued at", () => {
    const state = recordTrade(startScore(snap()), snap({ cash: 500, amounts: { NVDA: 15 } }));
    expect(state.index).to.equal(1);
    expect(state.last.amounts.NVDA).to.equal(15);
  });

  it("counts a worse fill against the agent", () => {
    // $500 of cash bought only $490 of NVDA.
    const state = recordTrade(startScore(snap()), snap({ cash: 500, amounts: { NVDA: 14.9 } }));
    expect(summarise(state).returnPct).to.be.closeTo(-0.5, 1e-9);
  });

  it("measures the next period from the book after the trade", () => {
    let state = recordTrade(startScore(snap()), snap({ cash: 0, amounts: { NVDA: 20 } }));
    state = advanceScore(state, snap({ cash: 0, amounts: { NVDA: 20 }, prices: { NVDA: 110 } })).state;
    // Fully invested now, so a 10% move is a 10% return.
    expect(summarise(state).returnPct).to.be.closeTo(10, 1e-9);
  });
});

describe("what a person is told", () => {
  it("says ahead, with both returns and both values", () => {
    const { state } = advanceScore(startScore(snap()), snap({ prices: { NVDA: 110 }, spyPrice: 505 }));
    expect(describeScore(summarise(state))).to.equal(
      "Since 25 Sep 08:10 UTC: up 5.00% against SPY up 1.00%, ahead of SPY by 4.00 points. Worth $2,100.00; the same money in SPY would be $2,020.00.",
    );
  });

  it("says behind when it is behind", () => {
    const { state } = advanceScore(startScore(snap()), snap({ prices: { NVDA: 95 }, spyPrice: 510 }));
    expect(describeScore(summarise(state))).to.include("down 2.50% against SPY up 2.00%, behind SPY by 4.50 points");
  });

  it("says flat and level on the first cycle", () => {
    expect(describeScore(summarise(startScore(snap())))).to.include("flat against SPY flat, level with SPY");
  });
});
