import "server-only";

import { PublicKey, type Connection } from "@solana/web3.js";

import { fetchMandate, type MandateView } from "../accounts";
import { portfolioPda } from "../chain";
import { desk, fetchHoldings, type PortfolioHoldings } from "../holdings";
import { readAssetPrice, readSettlementPrices } from "../settlement-prices";
import { advanceScore, summarise, type Score, type Snapshot } from "./scorecard";
import { getScore } from "./state";

/**
 * Reads a mandate's book for the scorecard.
 *
 * Valued at the prices settlement reads on chain, not the ones the chat
 * quotes, so a score and a settlement can never disagree about what the same
 * holdings were worth. SPY comes from the same place whether or not the
 * mandate holds it.
 *
 * Returns null when any price cannot be read or is stale. A score advanced on
 * a partial reading would book the missing part as a withdrawal, so no score
 * is better than a wrong one; the next cycle picks it up.
 */

const SPY = desk.settleable.find((a) => a.symbol === "SPY");

/** A snapshot of holdings at prices already read. */
export function snapshotFrom(
  holdings: PortfolioHoldings,
  prices: Record<string, number>,
  spyPrice: number,
  at: number,
): Snapshot {
  const amounts: Record<string, number> = {};
  for (const asset of holdings.assets) {
    if (asset.uiAmount > 0) amounts[asset.mint] = asset.uiAmount;
  }
  return { at, cash: holdings.cash?.uiAmount ?? 0, amounts, prices, spyPrice };
}

export async function takeSnapshot(
  connection: Connection,
  mandate: MandateView,
  holdings: PortfolioHoldings,
  at = Date.now(),
): Promise<Snapshot | null> {
  if (!SPY || !holdings.settleable) return null;

  const [read, spy] = await Promise.all([
    readSettlementPrices(connection, mandate),
    readAssetPrice(connection, SPY),
  ]);
  if (!read.ok || !spy.ok) return null;

  const prices: Record<string, number> = {};
  for (const [mint, price] of read.prices) prices[mint] = price.price;

  return snapshotFrom(holdings, prices, spy.price.price, at);
}

/**
 * A mandate's score as of now, for "how am I doing" between cycles.
 *
 * Read only: the saved score is advanced in memory and not written back. The
 * next cycle advances from the saved one and, with no money moved in between,
 * arrives at the same number, because the periods multiply.
 */
export async function scoreNow(connection: Connection, mandateAddress: string): Promise<Score | null> {
  const saved = await getScore(mandateAddress);
  if (!saved) return null;

  const key = new PublicKey(mandateAddress);
  const mandate = await fetchMandate(connection, key);
  if (!mandate) return summarise(saved);

  const holdings = await fetchHoldings(connection, portfolioPda(key), mandate);
  const reading = await takeSnapshot(connection, mandate, holdings);
  return summarise(reading ? advanceScore(saved, reading).state : saved);
}
