import {
  assetRegistry,
  feedsOf,
  getAssetBySymbol,
  listAssets,
  type RegisteredAsset,
} from "@/lib/assets";
import { computeSpread, fetchQuotes, type FeedResult } from "@/lib/pyth";

/**
 * Live prices for the registry, read from Pyth.
 *
 * This route exists so the Pyth key never reaches a browser. Pyth's own
 * documentation requires frontends to proxy rather than embed, and `lib/pyth`
 * is marked server only so the constraint is enforced at build time rather than
 * by convention.
 *
 * Query parameters:
 *   symbols  optional comma separated filter, for example `?symbols=AAPL,NVDA`
 */

// Quotes are live market data. Serving a cached response would mean showing a
// stale price as though it were current.
export const dynamic = "force-dynamic";

interface LegPayload {
  available: boolean;
  feedId: string;
  price?: number;
  confidence?: number;
  ageSeconds?: number;
  /** Present only when the price could not be read. */
  unavailableReason?: string;
}

function toLeg(feedId: string, result: FeedResult | undefined): LegPayload {
  if (!result) {
    return { available: false, feedId, unavailableReason: "not requested" };
  }

  if (result.status === "ok") {
    return {
      available: true,
      feedId,
      price: result.quote.price,
      confidence: result.quote.confidence,
      ageSeconds: result.quote.ageSeconds,
    };
  }

  if (result.status === "unentitled") {
    return {
      available: false,
      feedId,
      // Stated plainly rather than collapsed into a generic failure. An
      // entitlement gap is a billing question, not an outage, and the two
      // deserve different reactions from whoever is looking at this.
      unavailableReason: `not entitled: ${result.detail}`,
    };
  }

  if (result.status === "missing") {
    return { available: false, feedId, unavailableReason: "no price published" };
  }

  return { available: false, feedId, unavailableReason: result.detail };
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
    for (const id of feedsOf(asset)) feedIds.add(id);
  }

  let quotes: Map<string, FeedResult>;
  try {
    quotes = await fetchQuotes([...feedIds]);
  } catch (error) {
    // Reaching here means configuration failed, not that a feed was refused,
    // since fetchQuotes reports per feed problems rather than throwing.
    return Response.json(
      { error: "price service unavailable", detail: String(error) },
      { status: 503 },
    );
  }

  const payload = assets.map((asset) => {
    const primary = quotes.get(asset.feeds.primary);
    const reference = asset.feeds.reference
      ? quotes.get(asset.feeds.reference)
      : undefined;

    return {
      symbol: asset.symbol,
      name: asset.name,
      assetClass: asset.assetClass,
      mint: asset.mint,
      decimals: asset.decimals,
      issuer: asset.issuer,
      primary: toLeg(asset.feeds.primary, primary),
      reference: asset.feeds.reference
        ? toLeg(asset.feeds.reference, reference)
        : null,
      alternate: asset.feeds.alternate
        ? toLeg(asset.feeds.alternate, quotes.get(asset.feeds.alternate))
        : null,
      // Null for crypto, which has no underlying listing to diverge from.
      spread: computeSpread(reference, primary),
    };
  });

  const statuses = [...quotes.values()];

  return Response.json({
    cluster: assetRegistry.cluster,
    fetchedAt: new Date().toISOString(),
    assets: payload,
    availability: {
      total: statuses.length,
      live: statuses.filter((s) => s.status === "ok").length,
      unentitled: statuses.filter((s) => s.status === "unentitled").length,
      missing: statuses.filter((s) => s.status === "missing").length,
      failed: statuses.filter((s) => s.status === "error").length,
    },
  });
}
