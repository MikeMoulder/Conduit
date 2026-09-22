import {
  assetRegistry,
  feedsOf,
  getAssetBySymbol,
  listAssets,
  type RegisteredAsset,
} from "@/lib/assets";
import { computeSpread, fetchQuotes, type FeedResult } from "@/lib/pyth";
import {
  fetchPreStocks,
  preStockSpread,
  type PreStock,
  type PreStocksResult,
} from "@/lib/prestocks";
import {
  fetchJupiterPrices,
  jupiterSpread,
  type JupiterResult,
} from "@/lib/jupiter";

/**
 * Live prices for the registry.
 *
 * Three providers sit behind this one route. Jupiter prices the tokenized
 * equities from what they actually trade at on Solana. Pyth prices crypto, and
 * publishes the equity feeds it will not serve to our key. PreStocks prices its
 * own pre IPO tokens, which no oracle covers because a private company has no
 * public market to observe. Callers are given one uniform shape and do not need
 * to know which provider answered.
 *
 * The route also exists so no market data credential reaches a browser. Both
 * provider modules are marked server only, so a client component reaching for
 * one fails the build rather than leaking a key.
 *
 * Query parameters:
 *   symbols  optional comma separated filter, for example `?symbols=AAPL,SPACEX`
 */

// Quotes are live market data. Serving a cached response would mean showing a
// stale price as though it were current.
export const dynamic = "force-dynamic";

interface LegPayload {
  available: boolean;
  /** Identifier at the provider: a Pyth feed id, or a PreStocks symbol. */
  ref: string;
  price?: number;
  confidence?: number;
  ageSeconds?: number;
  /** Present only when the price could not be read. */
  unavailableReason?: string;
}

function pythLeg(feedId: string, result: FeedResult | undefined): LegPayload {
  if (!result) {
    return { available: false, ref: feedId, unavailableReason: "not requested" };
  }

  if (result.status === "ok") {
    return {
      available: true,
      ref: feedId,
      price: result.quote.price,
      confidence: result.quote.confidence,
      ageSeconds: result.quote.ageSeconds,
    };
  }

  if (result.status === "unentitled") {
    return {
      available: false,
      ref: feedId,
      // Stated plainly rather than collapsed into a generic failure. An
      // entitlement gap is a billing question, not an outage, and the two
      // deserve different reactions from whoever is looking at this.
      unavailableReason: `not entitled: ${result.detail}`,
    };
  }

  if (result.status === "missing") {
    return { available: false, ref: feedId, unavailableReason: "no price published" };
  }

  return { available: false, ref: feedId, unavailableReason: result.detail };
}

function priced(ref: string, price: number, ageSeconds: number): LegPayload {
  return { available: true, ref, price, ageSeconds };
}

function unavailable(ref: string, reason: string): LegPayload {
  return { available: false, ref, unavailableReason: reason };
}

/** Shape returned for one asset, whichever provider priced it. */
function describeAsset(
  asset: RegisteredAsset,
  quotes: Map<string, FeedResult>,
  jupiter: JupiterResult,
  preStocks: PreStocksResult,
) {
  const base = {
    symbol: asset.symbol,
    name: asset.name,
    assetClass: asset.assetClass,
    priceSource: asset.priceSource,
    mint: asset.mint,
    mainnetMint: asset.mainnetMint ?? null,
    decimals: asset.decimals,
    issuer: asset.issuer,
  };

  if (asset.priceSource === "prestocks") {
    if (preStocks.status !== "ok") {
      return {
        ...base,
        primary: unavailable(asset.symbol, preStocks.reason),
        reference: unavailable(asset.symbol, preStocks.reason),
        alternate: null,
        spread: null,
      };
    }

    const record: PreStock | undefined = preStocks.assets.get(asset.symbol);
    if (!record) {
      return {
        ...base,
        primary: unavailable(asset.symbol, "not present in the PreStocks response"),
        reference: unavailable(asset.symbol, "not present in the PreStocks response"),
        alternate: null,
        spread: null,
      };
    }

    const age = Math.max(0, Math.floor((Date.now() - preStocks.fetchedAt) / 1000));

    return {
      ...base,
      // The token is what the portfolio holds, so it is the primary leg. The SPV
      // mark is what it derives from, so it is the reference. Same shape as a
      // tokenized equity against its listing.
      primary: priced(asset.symbol, record.tokenPrice, age),
      reference: priced(asset.symbol, record.markPrice, age),
      alternate: null,
      spread: preStockSpread(record),
      valuation: {
        implied: record.impliedValuation,
        mark: record.markValuation,
        supply: record.supply,
      },
    };
  }

  if (asset.priceSource === "jupiter") {
    const ref = asset.mainnetMint;

    if (!ref) {
      const reason = "no mainnet mint recorded, so there is nothing to price";
      return {
        ...base,
        primary: unavailable(asset.symbol, reason),
        reference: null,
        alternate: null,
        spread: null,
      };
    }

    if (jupiter.status !== "ok") {
      return {
        ...base,
        primary: unavailable(ref, jupiter.reason),
        reference: null,
        alternate: null,
        spread: null,
      };
    }

    const quote = jupiter.quotes.get(ref);
    if (!quote) {
      return {
        ...base,
        primary: unavailable(ref, "jupiter returned no price for this mint"),
        reference: null,
        alternate: null,
        spread: null,
      };
    }

    const age = Math.max(0, Math.floor((Date.now() - jupiter.fetchedAt) / 1000));

    return {
      ...base,
      // The token is what a portfolio holds, so it is the primary leg. The share
      // it represents is the reference. Same shape as the pre IPO sleeve.
      primary: priced(ref, quote.price, age),
      reference:
        quote.underlyingPrice !== null
          ? priced(`${asset.symbol} underlying`, quote.underlyingPrice, age)
          : null,
      alternate: null,
      spread: jupiterSpread(quote),
      liquidity: quote.liquidity,
      blockId: quote.blockId,
    };
  }

  if (!asset.feeds) {
    const reason = "registry entry has no Pyth feeds";
    return {
      ...base,
      primary: unavailable(asset.symbol, reason),
      reference: null,
      alternate: null,
      spread: null,
    };
  }

  const primary = quotes.get(asset.feeds.primary);
  const reference = asset.feeds.reference
    ? quotes.get(asset.feeds.reference)
    : undefined;

  return {
    ...base,
    primary: pythLeg(asset.feeds.primary, primary),
    reference: asset.feeds.reference
      ? pythLeg(asset.feeds.reference, reference)
      : null,
    alternate: asset.feeds.alternate
      ? pythLeg(asset.feeds.alternate, quotes.get(asset.feeds.alternate))
      : null,
    // Null for crypto, which has no underlying listing to diverge from.
    spread: computeSpread(reference, primary),
  };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const filter = url.searchParams.get("symbols");

  let assets: RegisteredAsset[];

  if (filter) {
    const requested = filter
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const resolved = requested.map((symbol) => ({
      symbol,
      asset: getAssetBySymbol(symbol),
    }));

    const unknown = resolved.filter((r) => !r.asset).map((r) => r.symbol);
    if (unknown.length > 0) {
      return Response.json(
        {
          error: "unknown symbols",
          unknown,
          known: listAssets().map((a) => a.symbol),
        },
        { status: 400 },
      );
    }

    assets = resolved.map((r) => r.asset as RegisteredAsset);
  } else {
    assets = listAssets();
  }

  const feedIds = new Set<string>();
  for (const asset of assets) {
    // The equities keep their Pyth feeds recorded but are priced by Jupiter.
    // Requesting them anyway would spend a round trip collecting the same
    // entitlement refusals every time.
    if (asset.priceSource !== "pyth") continue;
    for (const id of feedsOf(asset)) feedIds.add(id);
  }

  const jupiterMints = assets
    .filter((a) => a.priceSource === "jupiter")
    .map((a) => a.mainnetMint)
    .filter((m): m is string => Boolean(m));

  const needsPreStocks = assets.some((a) => a.priceSource === "prestocks");

  // Providers are independent, so one slow or unreachable provider should not
  // serialise behind the other. Neither call rejects: both report failure in
  // their return value.
  const [quotes, jupiter, preStocks] = await Promise.all([
    feedIds.size > 0
      ? fetchQuotes([...feedIds])
      : Promise.resolve(new Map<string, FeedResult>()),
    jupiterMints.length > 0
      ? fetchJupiterPrices(jupiterMints)
      : Promise.resolve({
          status: "ok",
          quotes: new Map(),
          fetchedAt: Date.now(),
        } as JupiterResult),
    needsPreStocks
      ? fetchPreStocks()
      : Promise.resolve({
          status: "unavailable",
          reason: "not requested",
        } as PreStocksResult),
  ]);

  const payload = assets.map((asset) =>
    describeAsset(asset, quotes, jupiter, preStocks),
  );
  const live = payload.filter((a) => a.primary.available).length;

  return Response.json({
    cluster: assetRegistry.cluster,
    fetchedAt: new Date().toISOString(),
    assets: payload,
    availability: {
      assets: payload.length,
      priced: live,
      unpriced: payload.length - live,
      pythFeedsRequested: feedIds.size,
      pythFeedsLive: [...quotes.values()].filter((q) => q.status === "ok").length,
      jupiter: jupiter.status,
      preStocks: preStocks.status,
    },
  });
}
