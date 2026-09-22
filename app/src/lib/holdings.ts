import { Connection, PublicKey } from "@solana/web3.js";

import deskConfig from "./desk.devnet.json";
import { getAssetByMint } from "./assets";
import type { MandateView } from "./accounts";

/**
 * What a portfolio actually holds, as opposed to what it targets.
 *
 * This distinction is the whole reason this file exists, and the interface was
 * wrong about it for a long time. `Portfolio.positions` is policy: a list of
 * weights the program has accepted and will enforce. It is not custody, and
 * calling it "held" said something untrue.
 *
 * Holdings are token account balances. They are the only thing in the system
 * that cannot be a claim about itself: a mandate states what it permits and a
 * portfolio states what it targets, but a token account simply is what it is.
 *
 * Not every mandate can have holdings. Settlement needs a price the program can
 * verify on chain, which exists for the crypto sleeve on devnet and not for the
 * tokenized equities or the pre IPO names. A mandate permitting any of those is
 * policy only, and saying so plainly is better than implying custody that does
 * not exist.
 */

export interface DeskAsset {
  symbol: string;
  mint: string;
  decimals: number;
  feedId: string;
  priceAccount: string;
  deskTokenAccount: string;
}

export interface DeskConfig {
  cluster: string;
  cashMint: string;
  cashDecimals: number;
  desk: string;
  deskCash: string;
  settleable: DeskAsset[];
}

export const desk = deskConfig as DeskConfig;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/**
 * Derives an associated token account.
 *
 * Done here rather than by adding `@solana/spl-token` to the browser bundle.
 * The derivation is three seeds and the balance sits at a fixed offset, which
 * is less code than the dependency and consistent with how the Pyth account is
 * already read in the program.
 */
export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

/** The SPL token account layout, as far as the balance. */
function readTokenAmount(data: Buffer | Uint8Array): bigint | null {
  // mint 32, owner 32, then amount as a little endian u64.
  if (data.length < 72) return null;
  const view = new DataView(
    data.buffer as ArrayBuffer,
    data.byteOffset + 64,
    8,
  );
  return view.getBigUint64(0, true);
}

export function settleableAsset(mint: string): DeskAsset | undefined {
  return desk.settleable.find((a) => a.mint === mint);
}

/**
 * Whether every asset a mandate permits can be settled on chain.
 *
 * All or nothing on purpose. Settlement values the whole portfolio to work out
 * what any one weight is a share of, so a single asset the program cannot price
 * makes the arithmetic for every other asset wrong. A mandate is either
 * settleable or it is policy only.
 */
export function isSettleable(mandate: MandateView): boolean {
  return (
    mandate.allowedAssets.length > 0 &&
    mandate.allowedAssets.every((a) => Boolean(settleableAsset(a.mint)))
  );
}

export interface AssetHolding {
  symbol: string;
  mint: string;
  decimals: number;
  /** Base units. A string because these exceed what a number holds safely. */
  amount: string;
  /** Whole tokens, for display only. */
  uiAmount: number;
  /** False when the token account has never been created. */
  exists: boolean;
}

export interface PortfolioHoldings {
  settleable: boolean;
  cash: AssetHolding | null;
  assets: AssetHolding[];
  /** True once anything has actually been bought. */
  funded: boolean;
}

function toUi(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/**
 * Reads the balances a portfolio actually holds.
 *
 * Returns `settleable: false` and nothing else for a mandate the program cannot
 * price, rather than an empty set of holdings, because those are different
 * claims. No holdings means the portfolio owns nothing. Not settleable means
 * the question does not apply.
 */
export async function fetchHoldings(
  connection: Connection,
  portfolio: PublicKey,
  mandate: MandateView,
): Promise<PortfolioHoldings> {
  if (!isSettleable(mandate)) {
    return { settleable: false, cash: null, assets: [], funded: false };
  }

  const cashMint = new PublicKey(desk.cashMint);
  const wanted = mandate.allowedAssets
    .map((a) => settleableAsset(a.mint))
    .filter((a): a is DeskAsset => Boolean(a));

  const addresses = [
    associatedTokenAddress(portfolio, cashMint),
    ...wanted.map((a) => associatedTokenAddress(portfolio, new PublicKey(a.mint))),
  ];

  const accounts = await connection.getMultipleAccountsInfo(addresses);

  const read = (index: number): { amount: bigint; exists: boolean } => {
    const account = accounts[index];
    if (!account) return { amount: BigInt(0), exists: false };
    return { amount: readTokenAmount(account.data) ?? BigInt(0), exists: true };
  };

  const cashRead = read(0);
  const cash: AssetHolding = {
    symbol: "CASH",
    mint: desk.cashMint,
    decimals: desk.cashDecimals,
    amount: cashRead.amount.toString(),
    uiAmount: toUi(cashRead.amount, desk.cashDecimals),
    exists: cashRead.exists,
  };

  const assets = wanted.map((asset, i) => {
    const { amount, exists } = read(i + 1);
    return {
      symbol: getAssetByMint(asset.mint)?.symbol ?? asset.symbol,
      mint: asset.mint,
      decimals: asset.decimals,
      amount: amount.toString(),
      uiAmount: toUi(amount, asset.decimals),
      exists,
    };
  });

  return {
    settleable: true,
    cash,
    assets,
    funded:
      cashRead.amount > BigInt(0) || assets.some((a) => a.amount !== "0"),
  };
}

export interface ValuedHolding extends AssetHolding {
  /** Null when no price was available for this asset. */
  value: number | null;
  /** Share of the portfolio, in basis points. Null without a price. */
  weightBps: number | null;
}

export interface ValuedHoldings {
  assets: ValuedHolding[];
  cashValue: number;
  cashWeightBps: number;
  total: number;
}

/**
 * Prices holdings for display.
 *
 * Uses the same off chain prices the rest of the interface shows, which are not
 * the accounts the program settles against. They track each other closely and
 * they are not the same number, so this is a view of the portfolio rather than
 * a statement about what a settlement would do. Anything the program decides is
 * decided from the accounts it reads itself.
 */
export function valueHoldings(
  holdings: PortfolioHoldings,
  priceOf: (symbol: string) => number | null,
): ValuedHoldings | null {
  if (!holdings.settleable || !holdings.cash) return null;

  const cashValue = holdings.cash.uiAmount;
  let total = cashValue;

  const priced = holdings.assets.map((asset) => {
    const price = priceOf(asset.symbol);
    const value = price === null ? null : asset.uiAmount * price;
    if (value !== null) total += value;
    return { ...asset, value, weightBps: null as number | null };
  });

  if (total <= 0) {
    return { assets: priced, cashValue, cashWeightBps: 0, total: 0 };
  }

  for (const asset of priced) {
    asset.weightBps =
      asset.value === null ? null : Math.round((asset.value / total) * 10_000);
  }

  return {
    assets: priced,
    cashValue,
    cashWeightBps: Math.round((cashValue / total) * 10_000),
    total,
  };
}
