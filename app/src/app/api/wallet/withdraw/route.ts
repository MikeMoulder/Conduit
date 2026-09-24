import { BN } from "@coral-xyz/anchor";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate } from "@/lib/accounts";
import {
  assetBySymbol,
  assetUnits,
  cashUnits,
  parseAddress,
  sendAsAgent,
  signers,
} from "@/lib/agent-actions";
import { portfolioPda } from "@/lib/chain";
import { openTokenAccounts } from "@/lib/faucet";
import { associatedTokenAddress, desk } from "@/lib/holdings";
import { fetchMainWallet, fetchWalletBalances, walletAddress } from "@/lib/main-wallet";
import { codecProgram } from "@/lib/program-client";
import { getConnection } from "@/lib/rpc";
import { TOKEN_PROGRAM } from "@/lib/token-instructions";

/**
 * Sends money back to the person, from their main wallet or from a mandate.
 *
 * Signed by the agent, so "withdraw $5,000" happens without a wallet prompt,
 * and safe for exactly that reason: the program checks the destination is a
 * token account the owner holds. The agent can carry out a withdrawal and can
 * never redirect one. The destination is also derived here from the owner's
 * key, so there is no request field an attacker could point elsewhere.
 *
 * Cash is withdrawn in dollars. An asset is withdrawn in whole tokens, or all
 * of it, and lands in the person's own wallet as the token itself.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z.object({
  owner: z.string().min(32).max(44),
  /** Omitted for the main wallet; a mandate address to withdraw from it. */
  mandate: z.string().min(32).max(44).optional(),
  symbol: z.string().min(1).max(16).default("CASH"),
  /** Dollars for cash, whole tokens for an asset. Ignored when `all` is set. */
  amount: z.number().positive().finite().optional(),
  all: z.boolean().default(false),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (!parsed.data.all && parsed.data.amount === undefined)) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  const keys = signers();
  if ("error" in keys) return Response.json(keys, { status: 409 });

  const owner = parseAddress(parsed.data.owner);
  if (!owner) return Response.json({ error: "owner is not a valid address" }, { status: 400 });

  const isCash = parsed.data.symbol.toUpperCase() === "CASH";
  const asset = isCash ? null : assetBySymbol(parsed.data.symbol);
  if (!isCash && !asset) {
    return Response.json({ error: `nothing called ${parsed.data.symbol} to withdraw` }, { status: 404 });
  }

  const mint = new PublicKey(isCash ? desk.cashMint : asset!.mint);
  const decimals = isCash ? desk.cashDecimals : asset!.decimals;

  const connection = getConnection();
  const agentKey = keys.agent.publicKey.toBase58();

  // Where the money is, and the program instruction that may move it.
  let source: PublicKey;
  let buildInstruction: (
    amount: BN,
    from: PublicKey,
    destination: PublicKey,
  ) => Promise<TransactionInstruction>;

  if (parsed.data.mandate) {
    const mandateKey = parseAddress(parsed.data.mandate);
    if (!mandateKey) return Response.json({ error: "mandate is not a valid address" }, { status: 400 });

    const mandate = await fetchMandate(connection, mandateKey);
    if (!mandate) return Response.json({ error: "no mandate at that address" }, { status: 404 });
    if (mandate.owner !== owner.toBase58()) {
      return Response.json({ error: "that mandate belongs to someone else" }, { status: 403 });
    }
    if (mandate.agent !== agentKey) {
      return Response.json({ error: "that mandate names a different agent" }, { status: 403 });
    }

    const portfolioKey = portfolioPda(mandateKey);
    source = associatedTokenAddress(portfolioKey, mint);
    buildInstruction = (amount, from, destination) =>
      codecProgram.methods
        .withdrawFromMandate(amount)
        .accountsStrict({
          mandate: mandateKey,
          portfolio: portfolioKey,
          signer: keys.agent.publicKey,
          from,
          destination,
          tokenProgram: TOKEN_PROGRAM,
        })
        .instruction();
  } else {
    const wallet = await fetchMainWallet(connection, owner);
    if (!wallet) return Response.json({ error: "this person has no main wallet yet" }, { status: 404 });
    if (wallet.agent !== agentKey) {
      return Response.json({ error: "this wallet names a different agent" }, { status: 403 });
    }

    const walletKey = walletAddress(owner);
    source = associatedTokenAddress(walletKey, mint);
    buildInstruction = (amount, from, destination) =>
      codecProgram.methods
        .withdraw(amount)
        .accountsStrict({
          wallet: walletKey,
          signer: keys.agent.publicKey,
          from,
          destination,
          tokenProgram: TOKEN_PROGRAM,
        })
        .instruction();
  }

  const held = await connection
    .getTokenAccountBalance(source)
    .then((r) => BigInt(r.value.amount))
    .catch(() => BigInt(0));

  const amount = parsed.data.all
    ? held
    : isCash
      ? cashUnits(parsed.data.amount!)
      : assetUnits(parsed.data.amount!, decimals);

  if (amount <= BigInt(0)) {
    return Response.json({ withdrawn: false, error: "there is nothing to withdraw" }, { status: 409 });
  }
  if (amount > held) {
    return Response.json(
      {
        withdrawn: false,
        error: `only ${Number(held) / 10 ** decimals} ${isCash ? "in cash" : asset!.symbol} is there`,
        onChainError: "InsufficientBalance",
      },
      { status: 409 },
    );
  }

  // Derived from the owner, never taken from the request.
  const destination = associatedTokenAddress(owner, mint);

  const sent = await sendAsAgent(
    connection,
    [
      ...openTokenAccounts(keys.payer.publicKey, owner, [mint]),
      await buildInstruction(new BN(amount.toString()), source, destination),
    ],
    keys,
  );

  if (!sent.ok) return Response.json({ withdrawn: false, ...sent });

  const personal = await fetchWalletBalances(connection, owner);

  return Response.json({
    withdrawn: true,
    signature: sent.signature,
    slot: sent.slot,
    symbol: isCash ? "CASH" : asset!.symbol,
    amount: Number(amount) / 10 ** decimals,
    from: parsed.data.mandate ? "mandate" : "wallet",
    personalAfter: personal,
  });
}
