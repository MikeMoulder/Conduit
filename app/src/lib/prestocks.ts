import "server-only";

/**
 * PreStocks price source for the pre IPO sleeve.
 *
 * PreStocks issues tokens backed one to one by SPV exposure to a private
 * company. Each record carries two prices, and the difference between them is
 * the whole point of including this sleeve:
 *
 *   markPrice   what the SPV exposure is marked at, the underlying
 *   tokenPrice  what the token actually changes hands for
 *
 * Those map onto the registry's `reference` and `primary` without inventing a
 * new concept. The gap between them is routinely double digit, far wider than
 * anything in tokenized equities, which makes it a real allocation signal rather
 * than a rounding difference.
 *
 * Unlike Pyth, this endpoint requires no credential, so the pre IPO sleeve stays
 * priced regardless of how Pyth entitlements resolve. It is still server side
 * only, to keep one path for outbound market data rather than some in the
 * browser and some not.
 */

const PRESTOCKS_API = "https://prestocks.com/api/prestocks";

/**
 * Longer than the Pyth cache. These are private company marks, not an order
 * book, so they do not move second to second and hammering the endpoint would be
 * rude without being useful.
 */
const CACHE_TTL_MS = 30_000;

export interface PreStock {
  symbol: string;
  name: string;
  description: string;
  imageUrl: string;
  externalUrl: string;
  /**
   * The issuer's mint on Solana mainnet.
   *
   * Recorded rather than used on devnet. These are Token-2022 mints, which is a
   * different program from classic SPL Token and supports extensions such as
   * transfer hooks, so any mainnet interaction must account for that.
   */
  mainnetMint: string;
  /** Mark of the underlying SPV exposure, in USD. */
  markPrice: number;
  /** Traded price of the token itself, in USD. */
  tokenPrice: number;
  markValuation: number;
  impliedValuation: number;
  supply: number;
}

export type PreStocksResult =
  | { status: "ok"; assets: Map<string, PreStock>; fetchedAt: number }
  | { status: "unavailable"; reason: string };

/** Raw shape returned by the endpoint. Mapped rather than used directly. */
interface RawPreStock {
  name?: unknown;
  symbol?: unknown;
  description?: unknown;
  image?: unknown;
  external_url?: unknown;
  contract_address?: unknown;
  markPrice?: unknown;
  markValuation?: unknown;
  tokenPrice?: unknown;
  impliedValuation?: unknown;
  supply?: unknown;
}

let cache: { result: PreStocksResult; fetchedAt: number } | null = null;

function asNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Converts one raw record, or rejects it.
 *
 * A record missing a symbol, a mint or either price is dropped rather than
 * defaulted. A pre IPO asset with a silently zeroed price would flow into an
 * allocation decision as though it were free, which is the kind of quiet failure
 * that is much worse than a visibly absent asset.
 */
function mapRecord(raw: RawPreStock): PreStock | null {
  const symbol = asString(raw.symbol);
  const mainnetMint = asString(raw.contract_address);
  const markPrice = asNumber(raw.markPrice);
  const tokenPrice = asNumber(raw.tokenPrice);

  if (!symbol || !mainnetMint) return null;
  if (markPrice === null || tokenPrice === null) return null;
  if (markPrice <= 0 || tokenPrice <= 0) return null;

  return {
    symbol: symbol.toUpperCase(),
    name: asString(raw.name) ?? symbol,
    description: asString(raw.description) ?? "",
    imageUrl: asString(raw.image) ?? "",
    externalUrl: asString(raw.external_url) ?? "",
    mainnetMint,
    markPrice,
    tokenPrice,
    markValuation: asNumber(raw.markValuation) ?? 0,
    impliedValuation: asNumber(raw.impliedValuation) ?? 0,
    supply: asNumber(raw.supply) ?? 0,
  };
}

/**
 * Fetches the pre IPO universe.
 *
 * Never throws. A failure is returned as a status so a caller can render the
 * rest of a portfolio rather than losing the page to one unreachable provider.
 */
export async function fetchPreStocks(): Promise<PreStocksResult> {
  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.result;
  }

  let result: PreStocksResult;

  try {
    const response = await fetch(PRESTOCKS_API, { cache: "no-store" });

    if (!response.ok) {
      result = {
        status: "unavailable",
        reason: `prestocks responded http ${response.status}`,
      };
    } else {
      const body: unknown = await response.json();

      if (!Array.isArray(body)) {
        result = {
          status: "unavailable",
          reason: "prestocks returned an unexpected shape",
        };
      } else {
        const assets = new Map<string, PreStock>();
        for (const raw of body as RawPreStock[]) {
          const mapped = mapRecord(raw);
          if (mapped) assets.set(mapped.symbol, mapped);
        }

        result =
          assets.size > 0
            ? { status: "ok", assets, fetchedAt: now }
            : { status: "unavailable", reason: "prestocks returned no usable records" };
      }
    }
  } catch (error) {
    result = { status: "unavailable", reason: String(error) };
  }

  cache = { result, fetchedAt: now };
  return result;
}

export interface PreStockSpread {
  /** Token price over mark, as a fraction. Negative means trading at a discount. */
  fraction: number;
  basisPoints: number;
}

/**
 * Premium or discount of the token against the SPV mark.
 *
 * A negative figure means the market values the token below the underlying
 * exposure it represents, which is the case worth surfacing to an allocator.
 */
export function preStockSpread(asset: PreStock): PreStockSpread {
  const fraction = (asset.tokenPrice - asset.markPrice) / asset.markPrice;
  return { fraction, basisPoints: Math.round(fraction * 10_000) };
}

/** Clears the cache. Intended for tests. */
export function resetPreStocksCache(): void {
  cache = null;
}
