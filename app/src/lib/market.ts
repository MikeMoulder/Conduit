import "server-only";

import { feedsOf, getAssetBySymbol, listAssets, type RegisteredAsset } from "./assets";
import { fetchPreStocks, preStockSpread } from "./prestocks";
import { computeSpread, fetchQuotes, type FeedResult } from "./pyth";
import type { MarketSnapshot } from "./agents/pipeline";

/**
 * Flattens both price providers into the one shape the agent reasons over.
 *
 * The agent must not know or care which provider answered. What it needs is a
 * price, an underlying where one exists, and the spread between them. Anything
 * unavailable arrives as null rather than as a stale or invented number, because
 * a model handed a plausible looking figure will use it.
 */
export async function snapshotMarket(
  symbols?: string[],
): Promise<MarketSnapshot[]> {
  const assets: RegisteredAsset[] = symbols
    ? symbols
        .map((s) => getAssetBySymbol(s))
        .filter((a): a is RegisteredAsset => Boolean(a))
    : listAssets();

  const feedIds = new Set<string>();
  for (const asset of assets) {
    for (const id of feedsOf(asset)) feedIds.add(id);
  }

  const needsPreStocks = assets.some((a) => a.priceSource === "prestocks");

  const [quotes, preStocks] = await Promise.all([
    feedIds.size > 0
      ? fetchQuotes([...feedIds])
      : Promise.resolve(new Map<string, FeedResult>()),
    needsPreStocks
      ? fetchPreStocks()
      : Promise.resolve({ status: "unavailable" as const, reason: "not requested" }),
  ]);

  return assets.map((asset): MarketSnapshot => {
    const base = {
      symbol: asset.symbol,
      name: asset.name,
      assetClass: asset.assetClass,
      priceSource: asset.priceSource,
    };

    if (asset.priceSource === "prestocks") {
      const record =
        preStocks.status === "ok" ? preStocks.assets.get(asset.symbol) : undefined;

      if (!record) {
        return { ...base, price: null, referencePrice: null, spreadBps: null };
      }

      return {
        ...base,
        price: record.tokenPrice,
        referencePrice: record.markPrice,
        spreadBps: preStockSpread(record).basisPoints,
      };
    }

    if (!asset.feeds) {
      return { ...base, price: null, referencePrice: null, spreadBps: null };
    }

    const primary = quotes.get(asset.feeds.primary);
    const reference = asset.feeds.reference
      ? quotes.get(asset.feeds.reference)
      : undefined;
    const spread = computeSpread(reference, primary);

    return {
      ...base,
      price: primary?.status === "ok" ? primary.quote.price : null,
      referencePrice: reference?.status === "ok" ? reference.quote.price : null,
      spreadBps: spread?.basisPoints ?? null,
    };
  });
}

/** Symbols that currently have a usable price, which is what an agent can act on. */
export function pricedSymbols(snapshot: MarketSnapshot[]): string[] {
  return snapshot.filter((s) => s.price !== null).map((s) => s.symbol);
}
