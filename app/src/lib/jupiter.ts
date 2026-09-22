import "server-only";

/**
 * Jupiter price source for the tokenized equity sleeve.
 *
 * Why this exists rather than Pyth
 * --------------------------------
 * Pyth publishes feeds for both the xStock tokens and their underlying shares,
 * and refuses almost all of them to our key with an explicit `Not entitled`.
 * Of the fourteen equity feeds the registry references, one is served. That is
 * a commercial tier, not an outage, so waiting will not fix it.
 *
 * Jupiter prices the same instruments with no credential at all, and does it
 * from a better vantage point. Pyth reports an oracle's view of what a token is
 * worth. Jupiter reports what the token actually changed hands for on Solana,
 * at a named block. For an asset a mandate says is held, the traded price of
 * the thing held is the more honest number of the two.
 *
 * One request returns both legs
 * -----------------------------
 *   usdPrice             what the xStock token trades at
 *   stockData.price      the underlying share, from the issuer
 *
 * Those map onto the registry's `primary` and `reference` exactly as the Pyth
 * pair did, so nothing above this layer had to learn a new idea.
 *
 * Checked rather than trusted
 * ---------------------------
 * TSLA is the one equity Pyth does serve us, which makes it a control. Pyth put
 * `Equity.US.TSLA/USD` at 376.17 while Jupiter put the underlying at 376.30,
 * about three and a half basis points apart. Two independent providers agreeing
 * that closely is the reason this source is trusted for the other six.
 *
 * Mainnet prices, devnet holdings
 * -------------------------------
 * The mints priced here are the real xStock mints on mainnet. Our devnet mints
 * represent the same instruments, which is why the registry has carried a
 * `mainnetMint` field since the sleeve was built. This is the same relationship
 * Pyth and PreStocks already have with our holdings: the price is of the real
 * instrument, and the devnet token stands for it.
 */

const JUPITER_PRICE_API = "https://lite-api.jup.ag/price/v3";

/**
 * Shorter than the PreStocks cache. These are order book prices on a liquid
 * venue and they do move, so a stale one is misleading in a way a private
 * company mark is not.
 */
const CACHE_TTL_MS = 10_000;

/** Jupiter takes a list, so the whole sleeve costs one request. */
const MAX_IDS = 50;

export interface JupiterQuote {
  mint: string;
  /** Traded price of the token itself, in USD. */
  price: number;
  /** The underlying share, when the issuer publishes one. */
  underlyingPrice: number | null;
  /** Pool depth in USD. Absent rather than zero when Jupiter omits it. */
  liquidity: number | null;
  /** Percent move over 24 hours, as reported. */
  change24h: number | null;
  /** The block the price was observed at, which makes it checkable. */
  blockId: number | null;
}

export type JupiterResult =
  | { status: "ok"; quotes: Map<string, JupiterQuote>; fetchedAt: number }
  | { status: "unavailable"; reason: string };

interface RawQuote {
  usdPrice?: unknown;
  liquidity?: unknown;
  priceChange24h?: unknown;
  blockId?: unknown;
  stockData?: { price?: unknown } | null;
}

let cache: { key: string; result: JupiterResult; fetchedAt: number } | null = null;

function asNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Converts one raw record, or rejects it.
 *
 * A record with no usable price is dropped rather than defaulted, for the same
 * reason it is in the other two providers: an asset that silently arrives at
 * zero flows into an allocation as though it were free, and a visibly absent
 * asset is far safer than a quietly wrong one.
 *
 * The underlying is allowed to be missing on its own. Jupiter serves plenty of
 * tokens that are not equities, and for those there is no share price to have.
 * That is the same shape crypto already has under Pyth.
 */
function mapQuote(mint: string, raw: RawQuote): JupiterQuote | null {
  const price = asNumber(raw.usdPrice);
  if (price === null || price <= 0) return null;

  const underlying = asNumber(raw.stockData?.price);

  return {
    mint,
    price,
    underlyingPrice: underlying !== null && underlying > 0 ? underlying : null,
    liquidity: asNumber(raw.liquidity),
    change24h: asNumber(raw.priceChange24h),
    blockId: asNumber(raw.blockId),
  };
}

/**
 * Prices a set of mainnet mints.
 *
 * Never throws. A failure comes back as a status so one unreachable provider
 * costs its own sleeve and not the whole portfolio.
 */
export async function fetchJupiterPrices(
  mints: string[],
): Promise<JupiterResult> {
  const wanted = [...new Set(mints)].filter((m) => m.length > 0);

  if (wanted.length === 0) {
    return { status: "ok", quotes: new Map(), fetchedAt: Date.now() };
  }

  if (wanted.length > MAX_IDS) {
    return {
      status: "unavailable",
      reason: `asked for ${wanted.length} mints, which is more than jupiter takes in one request`,
    };
  }

  const key = [...wanted].sort().join(",");
  const now = Date.now();

  if (cache && cache.key === key && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.result;
  }

  let result: JupiterResult;

  try {
    const response = await fetch(`${JUPITER_PRICE_API}?ids=${key}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      result = {
        status: "unavailable",
        reason: `jupiter responded http ${response.status}`,
      };
    } else {
      const body: unknown = await response.json();

      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        result = {
          status: "unavailable",
          reason: "jupiter returned an unexpected shape",
        };
      } else {
        const quotes = new Map<string, JupiterQuote>();
        for (const [mint, raw] of Object.entries(body as Record<string, RawQuote>)) {
          const mapped = mapQuote(mint, raw);
          if (mapped) quotes.set(mint, mapped);
        }

        // A partial answer is still an answer. Jupiter omits a mint it has no
        // price for rather than erroring, and the caller reports the gap per
        // asset, so an empty map is the only genuinely useless case.
        result =
          quotes.size > 0
            ? { status: "ok", quotes, fetchedAt: now }
            : { status: "unavailable", reason: "jupiter priced none of the requested mints" };
      }
    }
  } catch (error) {
    result = { status: "unavailable", reason: String(error) };
  }

  cache = { key, result, fetchedAt: now };
  return result;
}

export interface JupiterSpread {
  /** Token over underlying, as a fraction. Negative means a discount. */
  fraction: number;
  basisPoints: number;
}

/**
 * Premium or discount of the token against the share it represents.
 *
 * Null when there is no underlying to compare against, rather than zero. A
 * spread of zero means the two prices agree, which is a different and much more
 * interesting claim than not knowing.
 */
export function jupiterSpread(quote: JupiterQuote): JupiterSpread | null {
  if (quote.underlyingPrice === null) return null;
  const fraction = (quote.price - quote.underlyingPrice) / quote.underlyingPrice;
  return { fraction, basisPoints: Math.round(fraction * 10_000) };
}

/** Clears the cache. Intended for tests. */
export function resetJupiterCache(): void {
  cache = null;
}
