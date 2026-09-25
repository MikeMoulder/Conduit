/**
 * The autopilot's scorecard: how a mandate has done against simply holding SPY.
 *
 * An agent trusted to run money on its own has to show whether it is any good,
 * and the honest comparison is the one any investor would make: what if the
 * same money had just sat in the index?
 *
 * The difficulty is money moving in and out. A deposit makes a portfolio worth
 * more without anyone having done well, and a withdrawal the opposite, so
 * comparing values would credit the agent with the owner's deposits. So the
 * score is kept the way funds report performance, as a time weighted return:
 *
 *   At every cycle, the holdings recorded last time are revalued at today's
 *   prices. That change is performance. Whatever else the value moved by is
 *   money that came in or went out, and it is kept out of the return.
 *
 * Trading is value neutral at the settlement price, so a gap between the book
 * before and after a cycle's trades, at the same prices, is the cost of
 * trading and counts against the agent.
 *
 * SPY is compared two ways. As a return, which ignores flows the same way.
 * And as dollars: every flow is assumed to have bought SPY at that moment
 * instead, so "the same money in SPY would be worth" is a fair sentence.
 *
 * One approximation, stated rather than hidden: a trade made between cycles,
 * outside the autopilot, moves holdings without moving value, and the price
 * difference between that trade and the next cycle is counted as a flow.
 * It is small, and it never flatters the agent more than the market moved in
 * those minutes.
 *
 * Pure: no chain, no clock, no files. The cycle feeds it snapshots.
 */

/** A mandate's book at one moment, in dollars and whole tokens. */
export interface Snapshot {
  at: number;
  /** Cash, where one unit is one dollar. */
  cash: number;
  /** Whole tokens held, by mint. */
  amounts: Record<string, number>;
  /** Dollars per whole token, by mint. */
  prices: Record<string, number>;
  spyPrice: number;
}

export interface ScoreState {
  startedAt: number;
  spyStart: number;
  /** What one dollar left in the mandate since the start is worth now. */
  index: number;
  /** SPY the same money would hold, counting every deposit and withdrawal. */
  shadowSpyUnits: number;
  /** The starting value plus deposits, minus withdrawals. */
  netInvested: number;
  /** The book as it stood after the last cycle. */
  last: Snapshot;
}

export interface Score {
  since: number;
  value: number;
  /** The same money, had it all gone into SPY when it arrived. */
  spyValue: number;
  netInvested: number;
  /** The mandate's time weighted return, in percent. */
  returnPct: number;
  spyReturnPct: number;
  /** returnPct minus spyReturnPct, in percentage points. */
  aheadPts: number;
}

/** Below a cent, a difference is rounding, not money moving. */
const FLOW_TOLERANCE = 0.01;

export function valueOf(snapshot: Snapshot): number {
  let value = snapshot.cash;
  for (const [mint, amount] of Object.entries(snapshot.amounts)) {
    value += amount * (snapshot.prices[mint] ?? 0);
  }
  return value;
}

export function startScore(snapshot: Snapshot): ScoreState {
  const value = valueOf(snapshot);
  return {
    startedAt: snapshot.at,
    spyStart: snapshot.spyPrice,
    index: 1,
    shadowSpyUnits: value / snapshot.spyPrice,
    netInvested: value,
    last: snapshot,
  };
}

/**
 * Brings a score up to now. Market moves on what was held count as
 * performance; anything else the value moved by is money in or out.
 */
export function advanceScore(state: ScoreState, reading: Snapshot): { state: ScoreState; flow: number } {
  const before = valueOf(state.last);

  // A price missing today falls back to the last one, so a gap in a feed
  // reads as no move rather than as the position being withdrawn.
  const now = { ...reading, prices: { ...state.last.prices, ...reading.prices } };

  // What the last recorded book is worth at today's prices.
  let expected = state.last.cash;
  for (const [mint, amount] of Object.entries(state.last.amounts)) {
    expected += amount * (now.prices[mint] ?? 0);
  }

  const index = before > 0 ? state.index * (expected / before) : state.index;
  const raw = valueOf(now) - expected;
  const flow = Math.abs(raw) < FLOW_TOLERANCE ? 0 : raw;

  return {
    flow,
    state: {
      ...state,
      index,
      shadowSpyUnits: state.shadowSpyUnits + flow / now.spyPrice,
      netInvested: state.netInvested + flow,
      last: now,
    },
  };
}

/**
 * Records the book after a cycle traded, valued at the prices it traded
 * against. Any difference from the book before is the cost of trading.
 */
export function recordTrade(state: ScoreState, after: Snapshot): ScoreState {
  const before = valueOf(state.last);
  const index = before > 0 ? state.index * (valueOf(after) / before) : state.index;
  return { ...state, index, last: after };
}

export function summarise(state: ScoreState): Score {
  const returnPct = (state.index - 1) * 100;
  const spyReturnPct = (state.last.spyPrice / state.spyStart - 1) * 100;
  return {
    since: state.startedAt,
    value: valueOf(state.last),
    spyValue: state.shadowSpyUnits * state.last.spyPrice,
    netInvested: state.netInvested,
    returnPct,
    spyReturnPct,
    aheadPts: returnPct - spyReturnPct,
  };
}

function signed(percent: number): string {
  const rounded = Math.round(percent * 100) / 100;
  if (rounded === 0) return "flat";
  return `${rounded > 0 ? "up" : "down"} ${Math.abs(rounded).toFixed(2)}%`;
}

function dollars(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function when(at: number): string {
  const d = new Date(at);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month} ${hh}:${mm} UTC`;
}

/** One sentence a person can read on a phone. */
export function describeScore(score: Score): string {
  const lead = Math.round(score.aheadPts * 100) / 100;
  const verdict =
    lead === 0
      ? "level with SPY"
      : `${lead > 0 ? "ahead of" : "behind"} SPY by ${Math.abs(lead).toFixed(2)} points`;
  return (
    `Since ${when(score.since)}: ${signed(score.returnPct)} against SPY ${signed(score.spyReturnPct)}, ${verdict}. ` +
    `Worth ${dollars(score.value)}; the same money in SPY would be ${dollars(score.spyValue)}.`
  );
}
