import { PublicKey, Transaction } from "@solana/web3.js";
import { z } from "zod";

import { parseAddress } from "@/lib/agent-actions";
import { extractProgramError } from "@/lib/chain";
import { confirmSignature } from "@/lib/confirm";
import {
  FUND_UNITS,
  createAssociatedTokenAccountIdempotent,
  getFaucetKeypair,
  topUpAmount,
  transferTokens,
} from "@/lib/faucet";
import { associatedTokenAddress, desk } from "@/lib/holdings";
import { getConnection } from "@/lib/rpc";

/**
 * Tops a person's own wallet up with devnet demo cash.
 *
 * Into the wallet they connected, not into Conduit. From there they deposit
 * into their main wallet or a mandate themselves, which keeps the deposit a
 * real step with a real signature, the way it would be with money that
 * mattered. Nothing here has value, and it is labelled that way wherever it
 * surfaces.
 *
 * Unauthenticated on purpose: sending worthless cash to anyone harms nobody.
 * What bounds it is that the amount is a top up to a fixed figure, so repeated
 * calls send nothing, and that the faucet can only give away the float it was
 * stocked with.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z.object({
  owner: z.string().min(32).max(44),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  const faucet = getFaucetKeypair();
  if (!faucet) {
    return Response.json(
      { error: "no faucet configured", detail: "FAUCET_SECRET_KEY is not set on the server." },
      { status: 409 },
    );
  }

  const owner = parseAddress(parsed.data.owner);
  if (!owner) return Response.json({ error: "owner is not a valid address" }, { status: 400 });

  const connection = getConnection();
  const cashMint = new PublicKey(desk.cashMint);
  const ownerCash = associatedTokenAddress(owner, cashMint);
  const faucetCash = associatedTokenAddress(faucet.publicKey, cashMint);
  const target = BigInt(FUND_UNITS) * BigInt(10) ** BigInt(desk.cashDecimals);

  const held = await connection
    .getTokenAccountBalance(ownerCash)
    .then((r) => BigInt(r.value.amount))
    .catch(() => BigInt(0));
  const amount = topUpAmount(held, target);

  if (amount === BigInt(0)) {
    return Response.json({
      funded: true,
      signature: null,
      slot: null,
      sent: 0,
      balance: Number(held) / 10 ** desk.cashDecimals,
    });
  }

  const float = await connection
    .getTokenAccountBalance(faucetCash)
    .then((r) => BigInt(r.value.amount))
    .catch(() => BigInt(0));
  if (float < amount) {
    return Response.json(
      {
        error: "the faucet is out of demo cash",
        detail: "It needs restocking from the build host with npm run faucet.",
      },
      { status: 503 },
    );
  }

  let signature: string;
  let lastValidBlockHeight: number;
  try {
    const latest = await connection.getLatestBlockhash("confirmed");
    lastValidBlockHeight = latest.lastValidBlockHeight;
    const transaction = new Transaction({
      feePayer: faucet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight,
    }).add(
      createAssociatedTokenAccountIdempotent(faucet.publicKey, ownerCash, owner, cashMint),
      transferTokens(faucetCash, ownerCash, faucet.publicKey, amount),
    );
    transaction.sign(faucet);
    signature = await connection.sendRawTransaction(transaction.serialize());
  } catch (error) {
    const programError = extractProgramError(error);
    return Response.json({
      funded: false,
      programError,
      detail: programError?.message ?? (error instanceof Error ? error.message : String(error)),
    });
  }

  const outcome = await confirmSignature(connection, signature, {
    lastValidBlockHeight,
    timeoutMs: 90_000,
  });
  if (outcome.status !== "confirmed") {
    return Response.json({ funded: false, signature, outcome: outcome.status });
  }

  return Response.json({
    funded: true,
    signature,
    slot: outcome.slot,
    sent: Number(amount) / 10 ** desk.cashDecimals,
    balance: FUND_UNITS,
  });
}
