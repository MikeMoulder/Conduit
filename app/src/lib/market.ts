import "server-only";

import {
  feedsOf,
  getAssetBySymbol,
  listAssets,
  type RegisteredAsset,
} from "./assets";
import { fetchJupiterPrices, jupiterSpread, type JupiterResult } from "./jupiter";
import { fetchPreStocks, preStockSpread } from "./prestocks";
import { computeSpread, fetchQuotes, type FeedResult } from "./pyth";
import type { MarketSnapshot } from "./agents/pipeline";

/**
 * Flattens every price provider into the one shape the agent reasons over.
 *
 * The agent must not know or care which provider answered. What it needs is a
 * price, an underlying where one exists, and the spread between them. Anything
 * unavailable arrives as null rather than as a stale or invented number,
 * because a model handed a plausible looking figure will use it.
 *
 * All three providers are asked at once. They are independent, two of them are
 * on the far side of the internet, and doing them in sequence would make the
 * slowest one set the pace for the whole snapshot.
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
    if (asset.priceSource !== "pyth") continue;
    for (const id of feedsOf(asset)) feedIds.add(id);
  }

  /**
   * Jupiter prices the real mint on mainnet. An equity with no `mainnetMint`
   * recorded cannot be priced there, which is a registry gap rather than a
   * provider failure, and is reported as such below.
   */
  const jupiterMints = assets
    .filter((a) => a.priceSource === "jupiter")
    .map((a) => a.mainnetMint)
    .filter((m): m is string => Boolean(m));

  const needsPreStocks = assets.some((a) => a.priceSource === "prestocks");

  const [quotes, jupiter, preStocks] = await Promise.all([
    feedIds.size > 0
      ? fetchQuotes([...feedIds])
      : Promise.resolve(new Map<string, FeedResult>()),
    jupiterMints.length > 0
      ? fetchJupiterPrices(jupiterMints)
      : Promise.resolve({
          status: "ok" as const,
          quotes: new Map(),
          fetchedAt: Date.now(),
        } satisfies JupiterResult),
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
    const nothing = { ...base, price: null, referencePrice: null, spreadBps: null };

    if (asset.priceSource === "jupiter") {
      if (!asset.mainnetMint) return nothing;

      const quote =
        jupiter.status === "ok" ? jupiter.quotes.get(asset.mainnetMint) : undefined;
      if (!quote) return nothing;

      const spread = jupiterSpread(quote);
      return {
        ...base,
        price: quote.price,
        referencePrice: quote.underlyingPrice,
        spreadBps: spread?.basisPoints ?? null,
      };
    }

    if (asset.priceSource === "prestocks") {
      const record =
        preStocks.status === "ok" ? preStocks.assets.get(asset.symbol) : undefined;
      if (!record) return nothing;

      return {
        ...base,
        price: record.tokenPrice,
        referencePrice: record.markPrice,
        spreadBps: preStockSpread(record).basisPoints,
      };
    }

    if (!asset.feeds) return nothing;

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
