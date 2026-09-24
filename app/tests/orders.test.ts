import { describe, it } from "node:test";
import { expect } from "chai";

import {
  bookFrom,
  checkOrder,
  largestOrder,
  planOrder,
  type MandateContext,
} from "../src/lib/orders";

/**
 * Tests for dollar orders.
 *
 * The arithmetic here is the point of the module: turning "buy $10,000 of
 * NVDA" into a share of a portfolio is exactly what a language model gets
 * subtly wrong, so it was taken away from the model and put here, and these
 * tests are what make that worth doing. Every expectation is worked out by hand
 * from the numbers in the test, not read back from the code.
 */

const NVDA = "nvda-mint";
const AAPL = "aapl-mint";
const TSLA = "tsla-mint";

/** A portfolio that has never traded: all cash, every asset at zero units. */
function allCash(cash: number) {
  return bookFrom(cash, [
    { mint: NVDA, units: 0, price: 200 },
    { mint: AAPL, units: 0, price: 250 },
    { mint: TSLA, units: 0, price: 400 },
  ]);
}

function mandate(
  overrides: Partial<MandateContext["constraints"]> = {},
  current: MandateContext["current"] = [],
): MandateContext {
  return {
    constraints: {
      maxPositionBps: 4000,
      minCashBps: 1000,
      maxTurnoverBps: 9000,
      maxAssets: 3,
      ...overrides,
    },
    allowedMints: [NVDA, AAPL, TSLA],
    current,
  };
}

describe("turning dollars into a share of the portfolio", () => {
  it("converts a buy exactly when the numbers divide cleanly", () => {
    const plan = planOrder(allCash(10_000), NVDA, "buy", 3_000);
    if ("error" in plan) throw new Error(plan.error);

    // $3,000 of a $10,000 book is 30 percent, which is 3,000 basis points.
    expect(plan.orderedBps).to.equal(3_000);
    expect(plan.orderedBpsBefore).to.equal(0);
    expect(plan.executedDollars).to.equal(3_000);
    expect(plan.positions).to.deep.equal([{ mint: NVDA, targetBps: 3_000 }]);
  });

  it("moves only the ordered asset", () => {
    // $5,000 cash, $2,000 of AAPL (8 at 250), $3,000 of NVDA (15 at 200).
    const book = bookFrom(5_000, [
      { mint: NVDA, units: 15, price: 200 },
      { mint: AAPL, units: 8, price: 250 },
      { mint: TSLA, units: 0, price: 400 },
    ]);

    const plan = planOrder(book, AAPL, "buy", 1_000);
    if ("error" in plan) throw new Error(plan.error);

    const target = new Map(plan.positions.map((p) => [p.mint, p.targetBps]));
    // AAPL goes from $2,000 to $3,000 of a $10,000 book.
    expect(target.get(AAPL)).to.equal(3_000);
    // NVDA stays at its current value. A dollar order that nudged it back to
    // some older target would be trading something nobody asked for.
    expect(target.get(NVDA)).to.equal(3_000);
    expect(target.has(TSLA)).to.equal(false);
  });

  it("sells a position to nothing by leaving it out", () => {
    const book = bookFrom(7_000, [
      { mint: NVDA, units: 15, price: 200 },
      { mint: AAPL, units: 0, price: 250 },
      { mint: TSLA, units: 0, price: 400 },
    ]);

    const plan = planOrder(book, NVDA, "sell", 3_000);
    if ("error" in plan) throw new Error(plan.error);

    // A zero weight is refused by the program; absence is how a position closes.
    expect(plan.positions).to.deep.equal([]);
    expect(plan.orderedBps).to.equal(0);
    expect(plan.executedDollars).to.equal(3_000);
  });

  it("trades within half a basis point of the book when it cannot be exact", () => {
    // $1,234.56 of a $10,000 book is 1,234.56 basis points, which rounds to
    // 1,235: $1,235 actually trades, 44 cents more than asked.
    const plan = planOrder(allCash(10_000), NVDA, "buy", 1_234.56);
    if ("error" in plan) throw new Error(plan.error);

    expect(plan.orderedBps).to.equal(1_235);
    expect(plan.executedDollars).to.equal(1_235);
    expect(Math.abs(plan.executedDollars - 1_234.56)).to.be.at.most(0.5);
  });

  it("never proposes more than the whole portfolio", () => {
    // Three holdings of a third each round up to 3,333.33 each; a buy on top
    // must not push the total past 10,000.
    const book = bookFrom(1, [
      { mint: NVDA, units: 16.665, price: 200 },
      { mint: AAPL, units: 13.332, price: 250 },
      { mint: TSLA, units: 8.3325, price: 400 },
    ]);

    const plan = planOrder(book, NVDA, "buy", 1);
    if ("error" in plan) throw new Error(plan.error);

    const total = plan.positions.reduce((s, p) => s + p.targetBps, 0);
    expect(total).to.be.at.most(10_000);
  });
});

describe("refusing what cannot be done at all", () => {
  it("refuses a buy larger than the cash", () => {
    const plan = planOrder(allCash(10_000), NVDA, "buy", 12_000);
    expect(plan).to.have.property("error").that.includes("$10,000");
  });

  it("refuses a sale larger than the holding", () => {
    const book = bookFrom(7_000, [
      { mint: NVDA, units: 15, price: 200 },
      { mint: AAPL, units: 0, price: 250 },
      { mint: TSLA, units: 0, price: 400 },
    ]);
    const plan = planOrder(book, NVDA, "sell", 5_000);
    expect(plan).to.have.property("error").that.includes("$3,000");
  });

  it("refuses zero, negatives and nonsense", () => {
    for (const amount of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planOrder(allCash(10_000), NVDA, "buy", amount)).to.have.property("error");
    }
  });

  it("refuses an empty portfolio rather than dividing by it", () => {
    expect(planOrder(allCash(0), NVDA, "buy", 1)).to.have.property("error");
  });
});

describe("checking an order against the mandate", () => {
  it("accepts an order inside every limit", () => {
    const checked = checkOrder(allCash(10_000), NVDA, "buy", 3_000, mandate());
    if ("error" in checked) throw new Error(checked.error);
    expect(checked.evaluation.compliant).to.equal(true);
  });

  it("names the concentration cap when a buy breaks it", () => {
    // $5,000 of a $10,000 book is 50 percent, past a 40 percent cap.
    const checked = checkOrder(allCash(10_000), NVDA, "buy", 5_000, mandate());
    if ("error" in checked) throw new Error(checked.error);
    expect(checked.evaluation.compliant).to.equal(false);
    expect(checked.evaluation.firstRefusal).to.equal("PositionExceedsMaxSize");
  });
});

describe("the largest order that fits", () => {
  it("stops at the concentration cap", () => {
    // 40 percent of $10,000.
    expect(largestOrder(allCash(10_000), NVDA, "buy", mandate())).to.equal(4_000);
  });

  it("stops at the cash floor when that binds first", () => {
    // $2,000 cash in a $10,000 book with a 10 percent floor leaves $1,000 to
    // spend, even though the cap would allow far more.
    const book = bookFrom(2_000, [
      { mint: NVDA, units: 0, price: 200 },
      { mint: AAPL, units: 16, price: 250 },
      { mint: TSLA, units: 10, price: 400 },
    ]);
    const current = [
      { mint: AAPL, targetBps: 4_000 },
      { mint: TSLA, targetBps: 4_000 },
    ];
    expect(
      largestOrder(book, NVDA, "buy", mandate({ maxPositionBps: 5_000 }, current)),
    ).to.equal(1_000);
  });

  it("stops at the turnover limit when that binds first", () => {
    // From all cash, turnover equals the share bought: 20 percent of $10,000.
    expect(
      largestOrder(allCash(10_000), NVDA, "buy", mandate({ maxTurnoverBps: 2_000 })),
    ).to.equal(2_000);
  });

  it("is exact: the answer fits and one dollar more does not", () => {
    const book = allCash(10_000);
    const m = mandate({ maxTurnoverBps: 2_345 });
    const largest = largestOrder(book, NVDA, "buy", m);

    const at = checkOrder(book, NVDA, "buy", largest, m);
    const over = checkOrder(book, NVDA, "buy", largest + 1, m);
    if ("error" in at || "error" in over) throw new Error("unexpected");

    expect(at.evaluation.compliant).to.equal(true);
    expect(over.evaluation.compliant).to.equal(false);
  });

  it("is zero when the portfolio is already at its asset limit", () => {
    // Holding two names under a two asset limit, a third cannot be bought for
    // any price. Zero is the honest answer, not a small number.
    const book = bookFrom(6_000, [
      { mint: NVDA, units: 0, price: 200 },
      { mint: AAPL, units: 8, price: 250 },
      { mint: TSLA, units: 5, price: 400 },
    ]);
    const current = [
      { mint: AAPL, targetBps: 2_000 },
      { mint: TSLA, targetBps: 2_000 },
    ];
    expect(
      largestOrder(book, NVDA, "buy", mandate({ maxAssets: 2 }, current)),
    ).to.equal(0);
  });
});
