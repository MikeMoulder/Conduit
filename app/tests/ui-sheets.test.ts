import { describe, it } from "node:test";
import { expect } from "chai";

import { todayMove } from "../src/lib/ui-sheets";

/**
 * Tests for the portfolio panel's day move.
 *
 * What is protected is the arithmetic behind "-$3.77 today": a holding worth
 * $534.67 after a 0.70% fall was worth $534.67 / 0.993 a day ago.
 */

describe("the day's move in dollars", () => {
  it("works back from today's value and the percent change", () => {
    const move = todayMove({ holdings: [{ symbol: "AAPL", amount: 1.59, value: 534.67, changePct: -0.7 }] });
    expect(move).to.be.closeTo(-3.77, 0.005);
  });

  it("adds up holdings, skipping one with no day line or no price", () => {
    const move = todayMove({
      holdings: [
        { symbol: "AAPL", amount: 1, value: 100, changePct: 0 },
        { symbol: "NVDA", amount: 1, value: 200, changePct: 100 },
        { symbol: "BTC", amount: 1, value: 50, changePct: null },
        { symbol: "OURA", amount: 1, value: null, changePct: 5 },
      ],
    });
    expect(move).to.be.closeTo(100, 1e-9);
  });

  it("says nothing rather than zero when no holding has a day line", () => {
    expect(todayMove({ holdings: [{ symbol: "BTC", amount: 1, value: 50 }] })).to.equal(null);
  });
});
