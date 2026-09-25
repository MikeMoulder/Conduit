import { bpsToPercent } from "../chain";

/**
 * The pre IPO strategy: trade the gap between what a token costs and what the
 * company behind it is marked at.
 *
 * PreStocks publishes two prices for every private company it wraps. The mark
 * is what the underlying SPV exposure is valued at. The token price is what the
 * wrapper actually changes hands for. On the most liquid equities those two
 * agree to a fraction of a percent. Here they routinely disagree by twenty or
 * thirty percent, in both directions, and that gap is the most decision
 * relevant fact available about these names.
 *
 * A token well below its mark buys the company for less than it is marked at,
 * so it is a reason to buy. A token well above its mark means paying a premium
 * for exposure the mark says is worth less, so it is a reason to stop adding,
 * and past a point a reason to take some off.
 *
 * The analysis is told all of this and decides. These rules are the backstop:
 * whatever the analysis proposes, a cycle never adds to a name at a rich
 * premium, trims a name at a stretched one, and keeps the whole pre IPO sleeve
 * under the cap the owner chose. Private companies are illiquid, rarely priced
 * and can go years without a market, so the sleeve is capped whatever the
 * signals say.
 *
 * Pure on purpose. Nothing here fetches or signs, so every rule is tested
 * directly and the same function decides in a test as on devnet.
 */

/** Token at least this far below its mark is a buy signal. */
export const DISCOUNT_BPS = 1_000;
/** Token at least this far above its mark gets no new money. */
export const RICH_PREMIUM_BPS = 1_500;
/** Token at least this far above its mark is trimmed to half each cycle. */
export const STRETCHED_PREMIUM_BPS = 3_000;
/** The sleeve cap when the owner has not chosen one: 10 percent of the book. */
export const DEFAULT_PRE_IPO_CAP_BPS = 1_000;

export type PreIpoSignal = "discount" | "fair" | "rich" | "stretched" | "unpriced";

export interface PreIpoQuote {
  symbol: string;
  assetClass: string;
  /** What the token trades for. */
  price: number | null;
  /** What the underlying is marked at. */
  referencePrice: number | null;
  /** Token against mark, in basis points. Negative is a discount. */
  spreadBps: number | null;
}

export interface Weight {
  symbol: string;
  targetBps: number;
}

export interface PreIpoRead {
  symbol: string;
  signal: PreIpoSignal;
  spreadBps: number | null;
  /** The most this name may hold after this cycle, before the sleeve cap. */
  ceilingBps: number;
}

export interface PreIpoOutcome {
  /** The proposal with the rules applied. What is taken off goes to cash. */
  positions: Weight[];
  /** One plain line per pre IPO name the rules or the signals touched. */
  notes: string[];
  /** Total pre IPO weight after the rules. */
  sleeveBps: number;
  capBps: number;
}

export function isPreIpo(quote: Pick<PreIpoQuote, "assetClass">): boolean {
  return quote.assetClass === "preipo";
}

export function signalOf(spreadBps: number | null): PreIpoSignal {
  if (spreadBps === null) return "unpriced";
  if (spreadBps <= -DISCOUNT_BPS) return "discount";
  if (spreadBps >= STRETCHED_PREMIUM_BPS) return "stretched";
  if (spreadBps >= RICH_PREMIUM_BPS) return "rich";
  return "fair";
}

/** "21% below its mark", "31% above its mark". */
export function describeGap(spreadBps: number): string {
  const percent = Math.round(Math.abs(spreadBps) / 100);
  if (percent === 0) return "in line with its mark";
  return `${percent}% ${spreadBps < 0 ? "below" : "above"} its mark`;
}

function weightOf(weights: Weight[], symbol: string): number {
  return weights.find((w) => w.symbol === symbol)?.targetBps ?? 0;
}

/**
 * Reads every pre IPO name in the market and sets its ceiling for this cycle.
 *
 * A discount or a fair price leaves the name to the analysis. A rich premium
 * holds it where it is. A stretched premium halves it. A name with no price
 * cannot be judged, so it cannot grow either.
 */
export function readPreIpo(market: PreIpoQuote[], current: Weight[]): PreIpoRead[] {
  return market.filter(isPreIpo).map((quote) => {
    const signal = signalOf(quote.price === null ? null : quote.spreadBps);
    const held = weightOf(current, quote.symbol);
    const ceilingBps =
      signal === "stretched"
        ? Math.floor(held / 2)
        : signal === "rich" || signal === "unpriced"
          ? held
          : 10_000;
    return { symbol: quote.symbol, signal, spreadBps: quote.spreadBps, ceilingBps };
  });
}

/**
 * What the analysis is told before it decides.
 *
 * Without a cap this is information only, which is what the chat's own
 * analysis gets. With one, the ceilings are stated as limits, so the manager
 * proposes inside them rather than having the backstop cut its proposal after.
 */
export function preIpoBrief(market: PreIpoQuote[], current: Weight[], capBps?: number): string | null {
  const reads = readPreIpo(market, current);
  if (reads.length === 0) return null;

  const lines = reads.map((r) => {
    if (r.signal === "unpriced") return `- ${r.symbol}: no price, cannot be judged.`;
    const gap = describeGap(r.spreadBps ?? 0);
    const held = weightOf(current, r.symbol);
    const limit =
      capBps === undefined
        ? ""
        : r.signal === "stretched"
          ? ` Limit: at most ${r.ceilingBps} bps (half of the ${held} bps held).`
          : r.signal === "rich"
            ? ` Limit: at most ${r.ceilingBps} bps, no new money.`
            : "";
    const reading =
      r.signal === "discount"
        ? "the token buys the company for less than it is marked at, a buy signal"
        : r.signal === "stretched"
          ? "a stretched premium over the mark, take some off"
          : r.signal === "rich"
            ? "a rich premium over the mark, do not add"
            : "close to its mark, no edge from the gap";
    return `- ${r.symbol}: token ${gap}, ${reading}.${limit}`;
  });

  const header = [
    "Pre IPO names. Each token has a traded price and a mark for the private company behind it. The gap between them is the signal:",
    `- ${DISCOUNT_BPS / 100}% or more below the mark: favour it, sized modestly.`,
    `- ${RICH_PREMIUM_BPS / 100}% or more above: hold, add nothing.`,
    `- ${STRETCHED_PREMIUM_BPS / 100}% or more above: trim to half.`,
  ];
  if (capBps !== undefined) {
    header.push(`- All pre IPO names together must total no more than ${capBps} bps (${bpsToPercent(capBps)}). They are illiquid and can go years without a market.`);
  }

  return [...header, ...lines].join("\n");
}

/**
 * Applies the rules to a proposal. The backstop behind the brief.
 *
 * Ceilings first, then the sleeve cap, scaling every pre IPO weight down
 * together so the analysis's relative preference survives. Anything cut goes
 * to cash, which the mandate always permits more of. A weight cut to zero is
 * dropped, because the program refuses a zero weight position.
 */
export function applyPreIpoRules(input: {
  proposed: Weight[];
  current: Weight[];
  market: PreIpoQuote[];
  capBps: number;
}): PreIpoOutcome {
  const { proposed, current, market, capBps } = input;
  const reads = new Map(readPreIpo(market, current).map((r) => [r.symbol, r]));
  const notes: string[] = [];

  let positions = proposed.map((p) => {
    const read = reads.get(p.symbol);
    if (!read || p.targetBps <= read.ceilingBps) return p;
    const held = weightOf(current, p.symbol);
    const gap = read.spreadBps === null ? "has no price" : `trades ${describeGap(read.spreadBps)}`;
    notes.push(
      held === 0
        ? `${p.symbol} ${gap}, so it was not bought.`
        : read.signal === "stretched"
          ? `${p.symbol} ${gap}, so it was trimmed from ${bpsToPercent(held)} to ${bpsToPercent(read.ceilingBps)}.`
          : `${p.symbol} ${gap}, so it was held at ${bpsToPercent(held)} instead of raised.`,
    );
    return { ...p, targetBps: read.ceilingBps };
  });

  const sleeve = () => positions.filter((p) => reads.has(p.symbol)).reduce((sum, p) => sum + p.targetBps, 0);

  const before = sleeve();
  if (before > capBps) {
    positions = positions.map((p) =>
      reads.has(p.symbol) ? { ...p, targetBps: Math.floor((p.targetBps * capBps) / before) } : p,
    );
    notes.push(`The pre IPO names came to ${bpsToPercent(before)}, above the ${bpsToPercent(capBps)} cap, so each was scaled down to fit.`);
  }

  positions = positions.filter((p) => p.targetBps > 0);

  // Discounts are the reason the strategy exists, so say what happened to
  // each one, bought or not.
  for (const read of reads.values()) {
    if (read.signal !== "discount" || read.spreadBps === null) continue;
    const weight = weightOf(positions, read.symbol);
    notes.push(
      weight > 0
        ? `${read.symbol} trades ${describeGap(read.spreadBps)}: holding ${bpsToPercent(weight)}.`
        : `${read.symbol} trades ${describeGap(read.spreadBps)}, a buy signal, but the analysis left it out.`,
    );
  }

  return { positions, notes, sleeveBps: sleeve(), capBps };
}
