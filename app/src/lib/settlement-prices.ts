import "server-only";

import { Connection, PublicKey } from "@solana/web3.js";

import type { MandateView } from "./accounts";
import { settleableAsset } from "./holdings";
import { codecProgram } from "./program-client";

/**
 * The prices a settlement will run at, read from the accounts the program
 * reads.
 *
 * Not the prices the interface shows elsewhere. Those come from Jupiter and
 * PreStocks over HTTP, and track these closely without being them. A dollar
 * order previewed at one price and settled at another would buy a different
 * amount than the person approved, so the preview reads the same accounts the
 * program will.
 *
 * Published prices only. The Pyth path is still readable by the program, but
 * nothing in the desk points at it by default, and parsing it here as well
 * would be a second copy of a layout the program already owns.
 */

/** The program refuses a price older than this, in seconds. */
export const MAX_PRICE_AGE_SECONDS = 600;

export interface SettlementPrice {
  mint: string;
  /** Dollars per whole token. */
  price: number;
  publishTime: number;
  source: string;
  ageSeconds: number;
}

export type PriceRead =
  | { ok: true; prices: Map<string, SettlementPrice> }
  | { ok: false; reason: string };

export async function readSettlementPrices(
  connection: Connection,
  mandate: MandateView,
): Promise<PriceRead> {
  const assets = mandate.allowedAssets.map((a) => settleableAsset(a.mint));

  const missing = mandate.allowedAssets.filter((_, i) => !assets[i]);
  if (missing.length > 0) {
    return { ok: false, reason: "This mandate permits an asset with no on chain price." };
  }

  if (assets.some((a) => a!.source !== "published")) {
    return {
      ok: false,
      reason:
        "An asset in this mandate is priced from Pyth, which dollar orders do not read yet. Place the order as a percentage instead.",
    };
  }

  const accounts = await connection.getMultipleAccountsInfo(
    assets.map((a) => new PublicKey(a!.priceAccount)),
  );

  const now = Math.floor(Date.now() / 1000);
  const prices = new Map<string, SettlementPrice>();

  for (let i = 0; i < assets.length; i += 1) {
    const asset = assets[i]!;
    const info = accounts[i];

    if (!info) {
      return {
        ok: false,
        reason: `No price has been published for ${asset.symbol} yet.`,
      };
    }

    const decoded = codecProgram.coder.accounts.decode(
      "publishedPrice",
      info.data,
    ) as {
      price: { toString(): string };
      exponent: number;
      publishTime: { toNumber(): number };
      source: string;
    };

    const publishTime = decoded.publishTime.toNumber();
    const ageSeconds = now - publishTime;

    // Refused here rather than discovered at settlement. A stale price means
    // the publisher has stopped, and the honest thing to say is that, not to
    // preview an order the program will turn down.
    if (ageSeconds > MAX_PRICE_AGE_SECONDS) {
      return {
        ok: false,
        reason: `The ${asset.symbol} price is ${Math.round(ageSeconds / 60)} minutes old, past the ten minutes the program accepts. The price publisher has likely stopped.`,
      };
    }

    prices.set(asset.mint, {
      mint: asset.mint,
      price: Number(decoded.price.toString()) * 10 ** decoded.exponent,
      publishTime,
      source: decoded.source,
      ageSeconds,
    });
  }

  return { ok: true, prices };
}
