import "server-only";

import type { PublicKey } from "@solana/web3.js";

import { assetBySymbol } from "../agent-actions";
import { fetchMainWallet } from "../main-wallet";
import { getConnection } from "../rpc";
import { readAssetPrice } from "../settlement-prices";
import { validate, type Condition, type TriggerAction } from "./rules";

/**
 * Everything that must be true for a trigger to be set, checked twice: when
 * the copilot prepares it, so a card is never offered for one that cannot
 * work, and again when the owner approves it, because the price and the
 * wallet can both change in between.
 *
 * Returns the current price, which a rise or fall is measured from. Read at
 * approval, not preparation, so "rises 2.5%" means from the moment the owner
 * agreed.
 */
export async function checkTrigger(input: {
  owner: PublicKey;
  symbol: string;
  condition: Condition;
  action: TriggerAction;
}): Promise<{ ok: true; symbol: string; basePrice: number } | { ok: false; error: string }> {
  const asset = assetBySymbol(input.symbol);
  if (!asset) return { ok: false, error: `${input.symbol} is not on the desk, so it cannot be watched or traded.` };

  const connection = getConnection();
  const price = await readAssetPrice(connection, asset);
  if (!price.ok) return { ok: false, error: price.reason };

  const invalid = validate(input.condition, price.price.price);
  if (invalid) return { ok: false, error: invalid };

  if (input.action.kind !== "notify") {
    if (!(input.action.dollars > 0)) return { ok: false, error: "The amount must be above zero." };
    const wallet = await fetchMainWallet(connection, input.owner);
    if (!wallet) {
      return { ok: false, error: "A trigger that trades needs a main wallet to trade from. Open one first." };
    }
  }

  return { ok: true, symbol: asset.symbol, basePrice: price.price.price };
}
