import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * The two SPL instructions this app builds by hand.
 *
 * Shared by the server, which opens accounts and moves demo cash, and the
 * browser, which builds the owner signed deposit. Built by hand rather than
 * taken from @solana/spl-token for the reason holdings.ts derives addresses by
 * hand: each is a handful of bytes and accounts, which is less than the
 * dependency. Tests pin every tag byte and every account position.
 */

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

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
  // Written through a DataView rather than Buffer.writeBigUInt64LE. This runs
  // in the browser too, for deposits, and the Buffer polyfill bundled there
  // predates the BigInt methods: the deposit card failed with "is not a
  // function" while every Node test passed. DataView is native everywhere.
  const bytes = new Uint8Array(9);
  bytes[0] = 3;
  new DataView(bytes.buffer).setBigUint64(1, amount, true);
  const data = Buffer.from(bytes);

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
