import registryData from "./registry.devnet.json";

/**
 * The Pyth feeds that price one instrument.
 *
 * The split between `primary` and `reference` is the important part. `primary`
 * prices the thing actually sitting in the portfolio. `reference` prices the
 * instrument it derives from, where one exists.
 *
 * For a tokenized equity those are two different numbers, and the gap between
 * them is information rather than noise: a token trading below its underlying is
 * a discount worth acting on, and a persistently wide gap is a liquidity warning
 * that should shrink the position size a mandate will tolerate.
 *
 * Crypto has no underlying listing, so it carries `primary` alone rather than
 * duplicating one feed into both fields and inventing a spread of zero.
 */
export interface AssetFeeds {
  /** Prices what is held, for example `Crypto.AAPLX/USD` or `Crypto.BTC/USD`. */
  primary: string;
  /** The underlying listing, for example `Equity.US.AAPL/USD`. Equities only. */
  reference?: string;
  /** A second tokenized representation where one exists, the Ondo series. */
  alternate?: string;
}

export type AssetClass = "equity" | "crypto" | "preipo";

/**
 * Which provider prices an asset.
 *
 * Three, because no one of them covers the whole registry.
 *
 * Pyth covers crypto, where it is served to everyone. It also publishes the
 * equity feeds, and refuses almost all of them to our key on tier grounds, so
 * the equity sleeve does not rely on it.
 *
 * Jupiter covers the tokenized equities by pricing the real xStock mints on
 * mainnet, and returns the underlying share alongside the token in the same
 * response. No credential, and the price is what the token actually traded at
 * rather than an oracle's view of it.
 *
 * PreStocks prices its own pre IPO tokens and is the only source that can: a
 * private company has no public market for anyone to observe.
 */
export type PriceSource = "pyth" | "jupiter" | "prestocks";

export interface RegisteredAsset {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  priceSource: PriceSource;
  /** SPL mint on this cluster. */
  mint: string;
  decimals: number;
  /**
   * Who issued the mint on this cluster.
   *
   * On mainnet this is the real issuer, Backed for the xStock series or Ondo for
   * theirs. On devnet those issuers publish nothing, so CONDUIT issues the
   * entry itself. Nothing above this layer branches on the field: the program
   * stores a mint address and prices it from the feeds recorded here, and has no
   * opinion about provenance. Moving to mainnet is a registry change.
   */
  issuer: string;
  /**
   * Pyth feeds, where the instrument has them.
   *
   * Kept on the equities even though they are priced by Jupiter. They cost
   * nothing, they record what the instrument actually is, and they become
   * usable the day the entitlement position changes.
   */
  feeds?: AssetFeeds;
  /**
   * Local path to the issuer's logo, under `public/assets`.
   *
   * Downloaded rather than hotlinked by `npm run logos`. Eighteen external
   * requests from three hosts on first render is not worth risking for a
   * decorative asset, and having them local means the interface works with no
   * network at all.
   */
  logo?: string;
  /**
   * The issuer's mint on mainnet, where one exists.
   *
   * Recorded so switching to mainnet is a registry change rather than research.
   * The PreStocks mints use Token-2022, a different program from classic SPL
   * Token, which any mainnet interaction must account for.
   */
  mainnetMint?: string;
}

export interface AssetRegistry {
  cluster: string;
  generatedAt: string;
  /** Authority that issued the devnet mints. */
  mintAuthority: string;
  assets: RegisteredAsset[];
}

export const assetRegistry = registryData as AssetRegistry;

const bySymbol = new Map(assetRegistry.assets.map((a) => [a.symbol, a]));
const byMint = new Map(assetRegistry.assets.map((a) => [a.mint, a]));

export function listAssets(): RegisteredAsset[] {
  return assetRegistry.assets;
}

export function listAssetsOfClass(assetClass: AssetClass): RegisteredAsset[] {
  return assetRegistry.assets.filter((a) => a.assetClass === assetClass);
}

export function getAssetBySymbol(symbol: string): RegisteredAsset | undefined {
  return bySymbol.get(symbol.toUpperCase());
}

export function getAssetByMint(mint: string): RegisteredAsset | undefined {
  return byMint.get(mint);
}

/**
 * Every Pyth feed id an asset references, in a stable order.
 *
 * Empty for assets priced elsewhere, so a caller can collect feed ids across the
 * whole registry without first filtering by provider.
 */
export function feedsOf(asset: RegisteredAsset): string[] {
  if (!asset.feeds) return [];
  const ids = [asset.feeds.primary];
  if (asset.feeds.reference) ids.push(asset.feeds.reference);
  if (asset.feeds.alternate) ids.push(asset.feeds.alternate);
  return ids;
}

export function listAssetsBySource(source: PriceSource): RegisteredAsset[] {
  return assetRegistry.assets.filter((a) => a.priceSource === source);
}

/**
 * Every feed id the registry references, de-duplicated.
 *
 * Useful for warming a price cache in one pass rather than per asset.
 */
export function allFeedIds(): string[] {
  const ids = new Set<string>();
  for (const asset of assetRegistry.assets) {
    for (const id of feedsOf(asset)) ids.add(id);
  }
  return [...ids];
}
