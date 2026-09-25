import { describe, it } from "node:test";
import { expect } from "chai";

import { describeBrake, isTripped, towardCash } from "../src/lib/autopilot/brakes";
import { turnoverBetween } from "../src/lib/proposal";
import {
  advanceScore,
  drawdownBps,
  recordTrade,
  resetPeak,
  startScore,
  summarise,
  type ScoreState,
  type Snapshot,
} from "../src/lib/autopilot/scorecard";

/**
 * Tests for the autopilot's safety brake.
 *
 * What is protected is the one promise the brake makes: a fall of the size
 * the owner chose stops the agent, and nothing else does. A withdrawal must
 * not trip it, a new high must move the point it measures from, and the
 * allocation it sends must be one the program accepts, or the brake does
 * nothing at the moment it matters.
 *
 * The book: fully invested, 20 NVDA at $100, so $2,000.
 */

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  at: 0,
  cash: 0,
  amounts: { NVDA: 20 },
  prices: { NVDA: 100 },
  spyPrice: 500,
  ...over,
});

const at = (price: number, state: ScoreState, cash = 0): ScoreState =>
  advanceScore(state, snap({ prices: { NVDA: price }, cash })).state;

describe("measuring the fall", () => {
  it("measures from the best point, not the start", () => {
    let state = startScore(snap());
    state = at(120, state);
    state = at(108, state);
    // 120 to 108 is a 10% fall, though the book is still up 8% overall.
    expect(drawdownBps(state)).to.equal(1_000);
    expect(summarise(state).returnPct).to.be.closeTo(8, 1e-9);
    expect(summarise(state).drawdownPct).to.equal(10);
  });

  it("is zero at a new high", () => {
    expect(drawdownBps(at(130, at(110, startScore(snap()))))).to.equal(0);
  });

  it("is not moved by a withdrawal", () => {
    const state = advanceScore(startScore(snap()), snap({ amounts: { NVDA: 10 } })).state;
    expect(drawdownBps(state)).to.equal(0);
  });

  it("counts the cost of trading toward the fall", () => {
    const state = recordTrade(startScore(snap()), snap({ amounts: { NVDA: 19.8 } }));
    expect(drawdownBps(state)).to.equal(100);
  });

  it("reads a score saved before the brake existed from the better of 1 and its index", () => {
    const old = { ...startScore(snap()), index: 0.95 };
    delete old.peakIndex;
    expect(drawdownBps(old)).to.equal(500);
  });

  it("starts again from today when the owner resumes", () => {
    const fallen = at(80, startScore(snap()));
    expect(drawdownBps(fallen)).to.equal(2_000);
    expect(drawdownBps(resetPeak(fallen))).to.equal(0);
  });
});

describe("when it trips", () => {
  const fallen = at(90, startScore(snap()));

  it("trips at the limit", () => {
    expect(isTripped(fallen, 1_000)).to.equal(true);
  });

  it("does not trip short of it", () => {
    expect(isTripped(fallen, 1_001)).to.equal(false);
  });

  it("never trips when switched off", () => {
    expect(isTripped(at(10, startScore(snap())), 0)).to.equal(false);
  });
});

describe("going to cash", () => {
  const book = [
    { symbol: "NVDA", targetBps: 4_500 },
    { symbol: "AAPL", targetBps: 3_500 },
    { symbol: "SPACEX", targetBps: 1_000 },
  ];
  const turnover = (after: { symbol: string; targetBps: number }[]) =>
    turnoverBetween(
      book.map((p) => ({ id: p.symbol, targetBps: p.targetBps })),
      after.map((p) => ({ id: p.symbol, targetBps: p.targetBps })),
      10_000 - after.reduce((sum, p) => sum + p.targetBps, 0),
    );

  it("empties the book when the turnover limit allows", () => {
    expect(towardCash(book, 9_000)).to.deep.equal([]);
    expect(turnover([])).to.equal(9_000);
  });

  it("cuts every position by the same fraction under a tight limit", () => {
    const after = towardCash(book, 3_000);
    expect(after).to.deep.equal([
      { symbol: "NVDA", targetBps: 3_000 },
      { symbol: "AAPL", targetBps: 2_334 },
      { symbol: "SPACEX", targetBps: 667 },
    ]);
  });

  it("never asks for more turnover than the mandate allows", () => {
    for (const limit of [1, 500, 1_234, 3_000, 4_999, 8_999]) {
      expect(turnover(towardCash(book, limit))).to.be.at.most(limit);
    }
  });

  it("does nothing to a book already in cash", () => {
    expect(towardCash([], 5_000)).to.deep.equal([]);
  });
});

describe("what the owner is told", () => {
  it("says everything went to cash and the autopilot stopped", () => {
    expect(describeBrake({ drawdownBps: 1_040, brakeBps: 1_000, after: [] })).to.equal(
      "Safety brake: the mandate fell 10.40% from its best point, past your 10% limit. Moved everything to cash, and paused the autopilot. Nothing more is traded until you switch it back on.",
    );
  });

  it("says what is still invested when the limit held it back", () => {
    const text = describeBrake({
      drawdownBps: 1_200,
      brakeBps: 1_000,
      after: [{ symbol: "NVDA", targetBps: 3_000 }],
    });
    expect(text).to.include("30% is still invested");
  });
});
