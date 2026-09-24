import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate, fetchPortfolio } from "@/lib/accounts";
import { cashUnits, parseAddress, sendAsAgent, signers } from "@/lib/agent-actions";
import { portfolioPda } from "@/lib/chain";
import { openTokenAccounts } from "@/lib/faucet";
import { associatedTokenAddress, desk, fetchHoldings } from "@/lib/holdings";
import { fetchMainWallet, fetchWalletBalances, walletAddress } from "@/lib/main-wallet";
import { codecProgram } from "@/lib/program-client";
import { getConnection } from "@/lib/rpc";
import { TOKEN_PROGRAM } from "@/lib/token-instructions";

/**
 * Moves cash from a person's main wallet into one of their mandates.
 *
 * This is how an autonomous investment gets its money: "put $20,000 into my
 * growth mandate". The agent signs, and the program checks the mandate
 * belongs to the same person as the main wallet, so money can only move
 * between one person's own wallets.
 *
 * Going the other way, out of a mandate into the main wallet, is not offered
 * here. The program allows it only with the owner's own signature, because the
 * main wallet has no limits and an agent able to move money there could step
 * around every rule a mandate sets.
 *
 * Every token account the mandate's settlements will need is opened in the
 * same transaction, paid by the faucet, so the mandate can settle straight
 * after funding without another round of housekeeping.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z.object({
  owner: z.string().min(32).max(44),
  mandate: z.string().min(32).max(44),
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
  const mandateKey = parseAddress(parsed.data.mandate);
  if (!owner || !mandateKey) {
    return Response.json({ error: "owner and mandate must be valid addresses" }, { status: 400 });
  }

  const connection = getConnection();
  const [wallet, mandate] = await Promise.all([
    fetchMainWallet(connection, owner),
    fetchMandate(connection, mandateKey),
  ]);

  if (!wallet) return Response.json({ error: "this person has no main wallet yet" }, { status: 404 });
  if (!mandate) return Response.json({ error: "no mandate at that address" }, { status: 404 });
  if (wallet.agent !== keys.agent.publicKey.toBase58()) {
    return Response.json({ error: "this wallet names a different agent" }, { status: 403 });
  }
  // Checked by the program as well. Said here so the answer is a sentence.
  if (mandate.owner !== owner.toBase58()) {
    return Response.json(
      { error: "that mandate belongs to someone else", onChainError: "WalletOwnerMismatch" },
      { status: 403 },
    );
  }

  const portfolioKey = portfolioPda(mandateKey);
  if (!(await fetchPortfolio(connection, portfolioKey))) {
    return Response.json({ error: "the mandate has no portfolio yet" }, { status: 404 });
  }

  const walletKey = walletAddress(owner);
  const cashMint = new PublicKey(desk.cashMint);

  const move = await codecProgram.methods
    .moveToMandate(new BN(cashUnits(parsed.data.dollars).toString()))
    .accountsStrict({
      wallet: walletKey,
      signer: keys.agent.publicKey,
      portfolio: portfolioKey,
      from: associatedTokenAddress(walletKey, cashMint),
      to: associatedTokenAddress(portfolioKey, cashMint),
      tokenProgram: TOKEN_PROGRAM,
    })
    .instruction();

  const sent = await sendAsAgent(
    connection,
    [
      ...openTokenAccounts(keys.payer.publicKey, portfolioKey, [
        cashMint,
        ...mandate.allowedAssets.map((a) => new PublicKey(a.mint)),
      ]),
      move,
    ],
    keys,
  );

  if (!sent.ok) return Response.json({ moved: false, ...sent });

  const [walletAfter, mandateAfter] = await Promise.all([
    fetchWalletBalances(connection, walletKey),
    fetchHoldings(connection, portfolioKey, mandate),
  ]);

  return Response.json({
    moved: true,
    signature: sent.signature,
    slot: sent.slot,
    dollars: parsed.data.dollars,
    walletCashAfter: walletAfter.cash?.uiAmount ?? 0,
    mandateCashAfter: mandateAfter.cash?.uiAmount ?? 0,
  });
}
