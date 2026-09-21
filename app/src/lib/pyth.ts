import "server-only";

import { getEnv } from "./env";

/**
 * Server side Pyth Hermes client.
 *
 * This module is server only by construction. Pyth's documentation is explicit
 * that a frontend must not embed the API key and should proxy through a backend,
 * and the `server-only` import turns any client component that reaches for this
 * into a build error rather than a leaked credential.
 *
 * Two facts about Hermes shape everything below, both established by probing the
 * live API rather than read from documentation:
 *
 * 1. Authentication has been required since 2026-08-26, using
 *    `Authorization: Bearer`. An `x-api-key` header is rejected with 401.
 * 2. Entitlements are per feed, and a batch request containing even one
 *    unentitled feed is refused **in its entirety** with 403. A naive batch of
 *    mixed feeds therefore returns no prices at all, including for the feeds the
 *    caller is perfectly entitled to read.
 */

const HERMES_LATEST_PATH = "/v2/updates/price/latest";

/** How long a quote may be reused before it is fetched again. */
const CACHE_TTL_MS = 2_000;

export interface PriceQuote {
  feedId: string;
  /** Price in USD, with the Pyth exponent already applied. */
  price: number;
  /** Pyth's own confidence interval, in the same units as `price`. */
  confidence: number;
  exponent: number;
  /** Unix seconds at which the publishers agreed this price. */
  publishTime: number;
  /** Seconds between `publishTime` and when this quote was read. */
  ageSeconds: number;
}

export type FeedResult =
  | { status: "ok"; feedId: string; quote: PriceQuote }
  /** The key is valid but carries no grant covering this feed. */
  | { status: "unentitled"; feedId: string; detail: string }
  /** Hermes accepted the request but returned nothing for this feed. */
  | { status: "missing"; feedId: string }
  | { status: "error"; feedId: string; detail: string };

interface HermesPrice {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

interface HermesParsedEntry {
  id: string;
  price: HermesPrice;
  ema_price?: HermesPrice;
}

interface HermesLatestResponse {
  parsed?: HermesParsedEntry[];
}

const cache = new Map<string, { result: FeedResult; fetchedAt: number }>();

function applyExponent(raw: string, exponent: number): number {
  return Number(raw) * 10 ** exponent;
}

function toQuote(entry: HermesParsedEntry, now: number): PriceQuote {
  const { price, conf, expo, publish_time: publishTime } = entry.price;
  return {
    feedId: entry.id,
    price: applyExponent(price, expo),
    confidence: applyExponent(conf, expo),
    exponent: expo,
    publishTime,
    ageSeconds: Math.max(0, Math.floor(now / 1000) - publishTime),
  };
}

function buildUrl(base: string, feedIds: string[]): string {
  const url = new URL(HERMES_LATEST_PATH, base);
  for (const id of feedIds) {
    url.searchParams.append("ids[]", id);
  }
  return url.toString();
}

/**
 * Requests one batch. Resolves with the raw response and status so the caller
 * can decide how to react, rather than throwing on a 403 that is expected.
 */
async function requestBatch(
  feedIds: string[],
): Promise<{ status: number; body: string }> {
  const env = getEnv();
  const response = await fetch(buildUrl(env.PYTH_HERMES_URL, feedIds), {
    headers: { Authorization: `Bearer ${env.PYTH_API_KEY}` },
    // Prices are re-fetched on our own schedule; Next should never serve a
    // cached HTTP response for a quote.
    cache: "no-store",
  });

  return { status: response.status, body: await response.text() };
}

function classifyFailure(feedId: string, status: number, body: string): FeedResult {
  if (status === 403) {
    return {
      status: "unentitled",
      feedId,
      // Hermes explains which grant is missing, for example
      // "asset type 'equity', instrument type 'spot'". Worth surfacing.
      detail: body.trim() || "no grant covers this feed",
    };
  }

  if (status === 401) {
    return {
      status: "error",
      feedId,
      detail: "Hermes rejected the API key. Check PYTH_API_KEY.",
    };
  }

  return { status: "error", feedId, detail: `http ${status}: ${body.slice(0, 200)}` };
}

/**
 * Fetches quotes for the given feeds.
 *
 * Attempts a single batch first, which is one round trip when every feed is
 * entitled. If that batch is refused, each feed is retried individually so a
 * single unentitled instrument cannot blank out the rest of the portfolio. The
 * fallback costs one request per feed, but only on the unhappy path.
 *
 * Never throws for an unavailable feed. Callers receive a per feed status so the
 * interface can state plainly which prices are live and which are not, rather
 * than rendering a confident number it does not actually have.
 */
export async function fetchQuotes(
  feedIds: string[],
): Promise<Map<string, FeedResult>> {
  const results = new Map<string, FeedResult>();
  const now = Date.now();

  const wanted = [...new Set(feedIds)].filter((id) => {
    const hit = cache.get(id);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
      results.set(id, hit.result);
      return false;
    }
    return true;
  });

  if (wanted.length === 0) return results;

  const record = (result: FeedResult) => {
    results.set(result.feedId, result);
    cache.set(result.feedId, { result, fetchedAt: now });
  };

  let batch: { status: number; body: string };
  try {
    batch = await requestBatch(wanted);
  } catch (error) {
    for (const id of wanted) {
      record({ status: "error", feedId: id, detail: String(error) });
    }
    return results;
  }

  if (batch.status === 200) {
    const parsed = (JSON.parse(batch.body) as HermesLatestResponse).parsed ?? [];
    const seen = new Set<string>();

    for (const entry of parsed) {
      seen.add(entry.id);
      record({ status: "ok", feedId: entry.id, quote: toQuote(entry, now) });
    }

    for (const id of wanted) {
      if (!seen.has(id)) record({ status: "missing", feedId: id });
    }

    return results;
  }

  // The batch was refused. A single feed request cannot be ambiguous about which
  // feed caused it, so retry individually to find out exactly what is available.
  if (wanted.length === 1) {
    record(classifyFailure(wanted[0], batch.status, batch.body));
    return results;
  }

  const individual = await Promise.all(
    wanted.map(async (id) => {
      try {
        const single = await requestBatch([id]);
        if (single.status !== 200) {
          return classifyFailure(id, single.status, single.body);
        }
        const parsed =
          (JSON.parse(single.body) as HermesLatestResponse).parsed ?? [];
        const entry = parsed.find((p) => p.id === id);
        return entry
          ? ({ status: "ok", feedId: id, quote: toQuote(entry, now) } as FeedResult)
          : ({ status: "missing", feedId: id } as FeedResult);
      } catch (error) {
        return { status: "error", feedId: id, detail: String(error) } as FeedResult;
      }
    }),
  );

  for (const result of individual) record(result);
  return results;
}

export interface Spread {
  /** Held price minus underlying price, as a fraction of the underlying. */
  fraction: number;
  /** The same figure in basis points, rounded, for on chain style comparisons. */
  basisPoints: number;
}

/**
 * The premium or discount of a held instrument against what it derives from.
 *
 * Negative means the token trades below its underlying listing, which is exactly
 * the case an agent building a position wants to know about.
 *
 * Returns null whenever either leg is unavailable, or when the asset has no
 * underlying at all, as crypto does not. A spread computed against a missing or
 * imaginary leg is worse than no spread, because it looks like a number.
 */
export function computeSpread(
  reference: FeedResult | undefined,
  primary: FeedResult | undefined,
): Spread | null {
  if (reference?.status !== "ok" || primary?.status !== "ok") return null;
  if (reference.quote.price === 0) return null;

  const fraction =
    (primary.quote.price - reference.quote.price) / reference.quote.price;

  return { fraction, basisPoints: Math.round(fraction * 10_000) };
}

/** Clears the quote cache. Intended for tests. */
export function resetQuoteCache(): void {
  cache.clear();
}
