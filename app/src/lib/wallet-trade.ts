import "server-only";

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { assetBySymbol, cashUnits, sendAsAgent, signers } from "./agent-actions";
import type { ExecutionResult } from "./agent-execution";
import { openTokenAccounts } from "./faucet";
import { associatedTokenAddress, desk } from "./holdings";
import { deskAssetAddress, fetchMainWallet, fetchWalletBalances, walletAddress } from "./main-wallet";
import { codecProgram } from "./program-client";
import { getConnection } from "./rpc";
import { readAssetPrice } from "./settlement-prices";
import { TOKEN_PROGRAM } from "./token-instructions";

/**
 * A trade in a person's main wallet, on their word, signed by the agent.
 *
 * Lifted out of the trade route unchanged so a price trigger can place the
 * order it was set up to place, with no HTTP round trip to itself. The route
 * is now a wrapper around this.
 *
 * No mandate and no wallet prompt: the person asked for it and approved it.
 * What keeps that safe is on chain, not here. The program prices the trade
 * from the feed the desk bound to this mint, lands both legs in this wallet or
 * the desk, and rounds against the wallet. This can pick the asset and the
 * amount; it cannot pick the price or the destination.
 */
export async function executeWalletTrade(input: {
  owner: PublicKey;
  side: "buy" | "sell";
  symbol: string;
  dollars: number;
}): Promise<ExecutionResult> {
  const result = (body: Record<string, unknown>, status = 200): ExecutionResult => ({ status, body });

  const keys = signers();
  if ("error" in keys) return result(keys, 409);

  const asset = assetBySymbol(input.symbol);
  if (!asset) return result({ error: `the desk does not trade ${input.symbol}` }, 404);

  const connection = getConnection();
  const wallet = await fetchMainWallet(connection, input.owner);
  if (!wallet) return result({ error: "this person has no main wallet yet" }, 404);
  if (wallet.agent !== keys.agent.publicKey.toBase58()) {
    return result({ error: "this wallet names a different agent", onChainError: "UnauthorizedWalletSigner" }, 403);
  }

  const price = await readAssetPrice(connection, asset);
  if (!price.ok) return result({ error: price.reason }, 503);

  const walletKey = walletAddress(input.owner);
  const mint = new PublicKey(asset.mint);
  const cashMint = new PublicKey(desk.cashMint);
  const before = await fetchWalletBalances(connection, walletKey);

  const amount = cashUnits(input.dollars);
  const buying = input.side === "buy";

  const trade = await codecProgram.methods
    .trade(buying, new BN(amount.toString()))
    .accountsStrict({
      wallet: walletKey,
      signer: keys.agent.publicKey,
      desk: new PublicKey(desk.desk),
      deskAsset: deskAssetAddress(mint),
      price: new PublicKey(asset.priceAccount),
      mint,
      cashMint,
      walletCash: associatedTokenAddress(walletKey, cashMint),
      walletAsset: associatedTokenAddress(walletKey, mint),
      deskCash: new PublicKey(desk.deskCash),
      deskHolding: new PublicKey(asset.deskTokenAccount),
      tokenProgram: TOKEN_PROGRAM,
    })
    .instruction();

  const sent = await sendAsAgent(
    connection,
    // The wallet's account for this asset is opened on first use, paid by the
    // faucet, so the owner never signs for housekeeping.
    [...openTokenAccounts(keys.payer.publicKey, walletKey, [cashMint, mint]), trade],
    keys,
  );

  if (!sent.ok) return result({ traded: false, ...sent });

  const after = await fetchWalletBalances(connection, walletKey);

  return result({
    traded: true,
    signature: sent.signature,
    slot: sent.slot,
    symbol: asset.symbol,
    side: input.side,
    price: price.price.price,
    before,
    after,
  });
}
