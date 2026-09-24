import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import {
  assetBySymbol,
  cashUnits,
  parseAddress,
  sendAsAgent,
  signers,
} from "@/lib/agent-actions";
import { openTokenAccounts } from "@/lib/faucet";
import { associatedTokenAddress, desk } from "@/lib/holdings";
import {
  deskAssetAddress,
  fetchMainWallet,
  fetchWalletBalances,
  walletAddress,
} from "@/lib/main-wallet";
import { codecProgram } from "@/lib/program-client";
import { getConnection } from "@/lib/rpc";
import { readAssetPrice } from "@/lib/settlement-prices";
import { TOKEN_PROGRAM } from "@/lib/token-instructions";

/**
 * A trade in a person's main wallet, on their word, signed by the agent.
 *
 * No mandate and no wallet prompt: the person asked for it in chat and pressed
 * approve. What keeps that safe is on chain, not here. The program prices the
 * trade from the feed the desk bound to this mint, lands both legs in this
 * wallet or the desk, and rounds against the wallet. This route can pick the
 * asset and the amount; it cannot pick the price or the destination.
 *
 * Unauthenticated, like the other agent routes, and bounded the same way:
 * anyone who calls it can at worst trade someone's main wallet at market
 * prices, which moves no value out of it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z.object({
  owner: z.string().min(32).max(44),
  side: z.enum(["buy", "sell"]),
  symbol: z.string().min(1).max(16),
  dollars: z.number().positive().finite(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  const keys = signers();
  if ("error" in keys) return Response.json(keys, { status: 409 });

  const owner = parseAddress(parsed.data.owner);
  if (!owner) return Response.json({ error: "owner is not a valid address" }, { status: 400 });

  const asset = assetBySymbol(parsed.data.symbol);
  if (!asset) {
    return Response.json({ error: `the desk does not trade ${parsed.data.symbol}` }, { status: 404 });
  }

  const connection = getConnection();
  const wallet = await fetchMainWallet(connection, owner);
  if (!wallet) {
    return Response.json({ error: "this person has no main wallet yet" }, { status: 404 });
  }
  if (wallet.agent !== keys.agent.publicKey.toBase58()) {
    return Response.json(
      { error: "this wallet names a different agent", onChainError: "UnauthorizedWalletSigner" },
      { status: 403 },
    );
  }

  const price = await readAssetPrice(connection, asset);
  if (!price.ok) return Response.json({ error: price.reason }, { status: 503 });

  const walletKey = walletAddress(owner);
  const mint = new PublicKey(asset.mint);
  const cashMint = new PublicKey(desk.cashMint);
  const before = await fetchWalletBalances(connection, walletKey);

  const amount = cashUnits(parsed.data.dollars);
  const buying = parsed.data.side === "buy";

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

  if (!sent.ok) {
    return Response.json({ traded: false, ...sent });
  }

  const after = await fetchWalletBalances(connection, walletKey);

  return Response.json({
    traded: true,
    signature: sent.signature,
    slot: sent.slot,
    symbol: asset.symbol,
    side: parsed.data.side,
    price: price.price.price,
    before,
    after,
  });
}
