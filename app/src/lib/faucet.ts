import "server-only";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import { parseSecret } from "./agent-identity";

/**
 * The devnet faucet: how somebody who is not us finishes the flow.
 *
 * A browser wallet can create a mandate and a portfolio, but the portfolio
 * starts empty and only the cash mint authority can create cash. That
 * authority is the build host wallet, and it stays off this server on purpose:
 * a key that can mint without limit does not belong behind an HTTP route.
 *
 * So the faucet is a separate key holding a finite float of demo cash. It can
 * hand out what it has and nothing more, which makes the worst case of any bug
 * in the route an empty float rather than unlimited money. It is also not the
 * agent key. The agent has exactly one power and paying people is not it.
 *
 * It does two jobs, because a fresh portfolio needs both before it can settle:
 * it creates the portfolio's token accounts, one for cash and one per asset the
 * mandate permits, and it tops the cash account up to a fixed amount.
 */

/** Whole units of demo cash a portfolio is topped up to. */
export const FUND_UNITS = 10_000;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

let cached: Keypair | null = null;

/** The faucet keypair, or null when none is configured. */
export function getFaucetKeypair(): Keypair | null {
  if (cached) return cached;

  const raw = process.env.FAUCET_SECRET_KEY;
  if (!raw || raw.trim().length === 0) return null;

  cached = parseSecret(raw);
  return cached;
}

/**
 * How much to send so a balance reaches the target, never more.
 *
 * Topped up rather than added to, which is what makes pressing the button
 * twice harmless. A portfolio that already holds the target gets nothing, and
 * one that has spent part of its cash on a settlement gets back to the target
 * rather than doubling.
 */
export function topUpAmount(held: bigint, target: bigint): bigint {
  return held >= target ? BigInt(0) : target - held;
}

/**
 * Creates an associated token account if it does not already exist.
 *
 * Built by hand for the same reason `holdings.ts` derives addresses by hand:
 * the instruction is one byte of data and six accounts, which is less than the
 * dependency that would otherwise provide it. The idempotent variant (tag 1)
 * succeeds when the account is already there, so the whole set can be sent on
 * every request without reading first.
 */
export function createAssociatedTokenAccountIdempotent(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** An SPL token transfer: tag 3, then the amount as a little endian u64. */
export function transferTokens(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}
