import "server-only";

import type { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

import { parseSecret } from "./agent-identity";
import { associatedTokenAddress } from "./holdings";
import { createAssociatedTokenAccountIdempotent } from "./token-instructions";

/**
 * The devnet faucet, and the key that pays for token accounts.
 *
 * Demo cash goes to the person's own wallet, not into Conduit. That keeps the
 * deposit a real step, taken by the person, the way it would be with money
 * that mattered: they hold cash in Phantom and choose how much of it their main
 * wallet or a mandate should get.
 *
 * The same key pays rent for the token accounts the agent's transactions need.
 * A main wallet or a mandate wallet holds each asset in its own token account,
 * those accounts have to exist before anything can land in them, and asking the
 * person to sign for each one would undo the point of not signing every trade.
 *
 * It is a third key, separate from the agent and from the mint authority. It
 * holds a finite float and a little SOL, so its worst case is running dry. The
 * mint authority stays off the web server: a key that can mint without limit
 * does not belong behind an HTTP route.
 */

/** Whole units of demo cash a person's own wallet is topped up to. */
export const FUND_UNITS = 50_000;

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
 * twice harmless. A wallet that already holds the target gets nothing, and one
 * that has deposited part of its cash gets back to the target rather than
 * doubling.
 */
export function topUpAmount(held: bigint, target: bigint): bigint {
  return held >= target ? BigInt(0) : target - held;
}

/**
 * Instructions opening a token account per mint for one holder, paid by the
 * faucet. Idempotent, so they can be sent every time without reading first.
 */
export function openTokenAccounts(
  payer: PublicKey,
  holder: PublicKey,
  mints: PublicKey[],
): TransactionInstruction[] {
  return mints.map((mint) =>
    createAssociatedTokenAccountIdempotent(
      payer,
      associatedTokenAddress(holder, mint),
      holder,
      mint,
    ),
  );
}

export {
  createAssociatedTokenAccountIdempotent,
  transferTokens,
} from "./token-instructions";
