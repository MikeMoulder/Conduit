import { describe, it } from "node:test";
import { expect } from "chai";

import {
  applyPreIpoRules,
  describeGap,
  preIpoBrief,
  readPreIpo,
  signalOf,
  type PreIpoQuote,
} from "../src/lib/autopilot/pre-ipo";

/**
 * Tests for the pre IPO strategy.
 *
 * The spreads are the ones PreStocks returned on 25 September 2026: SpaceX's
 * token 21% below its mark, OpenAI's 31% above, Neuralink's 34% above, Anduril
 * close to its mark. KALSHI is set to a 20% premium to cover the band between
 * rich and stretched, which no name happened to sit in that day.
 *
 * What is protected is money going where the gap says it should not: new money
 * into a premium, a stretched premium left untouched, and a sleeve of illiquid
 * private companies growing past the cap its owner chose.
 */

const quote = (symbol: string, spreadBps: number | null, assetClass = "preipo"): PreIpoQuote => ({
  symbol,
  assetClass,
  price: spreadBps === null ? null : 100 + spreadBps / 100,
  referencePrice: 100,
  spreadBps,
});

const MARKET: PreIpoQuote[] = [
  quote("SPACEX", -2_140),
  quote("OPENAI", 3_110),
  quote("NEURALINK", 3_380),
  quote("ANDURIL", 230),
  quote("KALSHI", 2_000),
  quote("NVDA", -3_000, "equity"),
];

describe("reading the gap", () => {
  it("names each band", () => {
    expect(signalOf(-2_140)).to.equal("discount");
    expect(signalOf(-1_000)).to.equal("discount");
    expect(signalOf(-999)).to.equal("fair");
    expect(signalOf(230)).to.equal("fair");
    expect(signalOf(1_500)).to.equal("rich");
    expect(signalOf(3_000)).to.equal("stretched");
    expect(signalOf(null)).to.equal("unpriced");
  });

  it("says the gap in words", () => {
    expect(describeGap(-2_140)).to.equal("21% below its mark");
    expect(describeGap(3_110)).to.equal("31% above its mark");
    expect(describeGap(20)).to.equal("in line with its mark");
  });

  it("reads only pre IPO names, never an equity", () => {
    // NVDA has a 30% discount here on purpose: a tokenized equity's spread is
    // a different thing, and this strategy must not act on it.
    const symbols = readPreIpo(MARKET, []).map((r) => r.symbol);
    expect(symbols).to.not.include("NVDA");
    expect(symbols).to.have.length(5);
  });

  it("halves a stretched name, holds a rich one, frees a discount", () => {
    const current = [
      { symbol: "OPENAI", targetBps: 800 },
      { symbol: "KALSHI", targetBps: 300 },
    ];
    const reads = new Map(readPreIpo(MARKET, current).map((r) => [r.symbol, r.ceilingBps]));
    expect(reads.get("OPENAI")).to.equal(400);
    expect(reads.get("KALSHI")).to.equal(300);
    expect(reads.get("SPACEX")).to.equal(10_000);
  });
});

describe("the rules applied to a proposal", () => {
  const CAP = 1_000;

  it("buys a discount inside the cap and says so", () => {
    const outcome = applyPreIpoRules({
      proposed: [{ symbol: "SPACEX", targetBps: 600 }, { symbol: "NVDA", targetBps: 3_000 }],
      current: [],
      market: MARKET,
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([
      { symbol: "SPACEX", targetBps: 600 },
      { symbol: "NVDA", targetBps: 3_000 },
    ]);
    expect(outcome.sleeveBps).to.equal(600);
    expect(outcome.notes).to.deep.equal(["SPACEX trades 21% below its mark: holding 6%."]);
  });

  it("never buys into a premium", () => {
    const outcome = applyPreIpoRules({
      proposed: [{ symbol: "OPENAI", targetBps: 500 }, { symbol: "KALSHI", targetBps: 300 }],
      current: [],
      market: MARKET,
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([]);
    expect(outcome.notes).to.include("OPENAI trades 31% above its mark, so it was not bought.");
    expect(outcome.notes).to.include("KALSHI trades 20% above its mark, so it was not bought.");
  });

  it("trims a stretched premium even when the analysis would keep it", () => {
    const outcome = applyPreIpoRules({
      proposed: [{ symbol: "NEURALINK", targetBps: 800 }],
      current: [{ symbol: "NEURALINK", targetBps: 800 }],
      market: MARKET,
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([{ symbol: "NEURALINK", targetBps: 400 }]);
    expect(outcome.notes[0]).to.equal("NEURALINK trades 34% above its mark, so it was trimmed from 8% to 4%.");
  });

  it("holds a rich premium where it is instead of raising it", () => {
    const outcome = applyPreIpoRules({
      proposed: [{ symbol: "KALSHI", targetBps: 700 }],
      current: [{ symbol: "KALSHI", targetBps: 300 }],
      market: MARKET,
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([{ symbol: "KALSHI", targetBps: 300 }]);
  });

  it("lets the analysis cut a premium further than the rules require", () => {
    const outcome = applyPreIpoRules({
      proposed: [],
      current: [{ symbol: "OPENAI", targetBps: 800 }],
      market: MARKET,
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([]);
  });

  it("scales the whole sleeve down to the cap, keeping the proportions", () => {
    const outcome = applyPreIpoRules({
      proposed: [
        { symbol: "SPACEX", targetBps: 1_200 },
        { symbol: "ANDURIL", targetBps: 400 },
        { symbol: "NVDA", targetBps: 2_000 },
      ],
      current: [],
      market: MARKET,
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([
      { symbol: "SPACEX", targetBps: 750 },
      { symbol: "ANDURIL", targetBps: 250 },
      { symbol: "NVDA", targetBps: 2_000 },
    ]);
    expect(outcome.sleeveBps).to.equal(1_000);
    expect(outcome.notes).to.include("The pre IPO names came to 16%, above the 10% cap, so each was scaled down to fit.");
  });

  it("leaves equities alone however large they are", () => {
    const outcome = applyPreIpoRules({
      proposed: [{ symbol: "NVDA", targetBps: 4_000 }],
      current: [],
      market: MARKET,
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([{ symbol: "NVDA", targetBps: 4_000 }]);
  });

  it("reports a discount the analysis passed over", () => {
    const outcome = applyPreIpoRules({ proposed: [], current: [], market: MARKET, capBps: CAP });
    expect(outcome.notes).to.deep.equal([
      "SPACEX trades 21% below its mark, a buy signal, but the analysis left it out.",
    ]);
  });

  it("never grows a name it cannot price", () => {
    const outcome = applyPreIpoRules({
      proposed: [{ symbol: "FIGUREAI", targetBps: 500 }],
      current: [{ symbol: "FIGUREAI", targetBps: 200 }],
      market: [quote("FIGUREAI", null)],
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([{ symbol: "FIGUREAI", targetBps: 200 }]);
  });

  it("drops a position the rules cut to zero rather than sending a zero weight", () => {
    const outcome = applyPreIpoRules({
      proposed: [{ symbol: "OPENAI", targetBps: 100 }],
      current: [{ symbol: "OPENAI", targetBps: 1 }],
      market: MARKET,
      capBps: CAP,
    });
    expect(outcome.positions).to.deep.equal([]);
  });
});

describe("what the analysis is told", () => {
  it("says nothing when no pre IPO name is in play", () => {
    expect(preIpoBrief([quote("NVDA", 100, "equity")], [])).to.equal(null);
  });

  it("gives the signals without limits when there is no cap", () => {
    const brief = preIpoBrief(MARKET, [])!;
    expect(brief).to.include("SPACEX: token 21% below its mark");
    expect(brief).to.not.include("Limit:");
    expect(brief).to.not.include("must total");
  });

  it("states the limits and the cap when there is one", () => {
    const brief = preIpoBrief(MARKET, [{ symbol: "OPENAI", targetBps: 800 }], 1_000)!;
    expect(brief).to.include("OPENAI: token 31% above its mark");
    expect(brief).to.include("Limit: at most 400 bps (half of the 800 bps held)");
    expect(brief).to.include("must total no more than 1000 bps (10%)");
  });
});
