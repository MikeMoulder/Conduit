/**
 * Puts the desk's fixed accounts in an address lookup table.
 *
 * Why this exists
 * ---------------
 * Settle takes four accounts for every asset a mandate permits: the price, the
 * mint, the portfolio's token account and the desk's. A legacy transaction
 * spells out every account as 32 bytes, and Solana caps a transaction at 1232
 * bytes, so a mandate of seven assets produced a settlement of 1333 bytes and
 * was refused before it reached the program. Earlier demos permitted three
 * assets and never came near the limit.
 *
 * A lookup table is the standard answer. The accounts that are the same for
 * every portfolio, the price accounts, the mints, the desk's token accounts,
 * and the desk itself, are written into a table on chain once. A version 0
 * transaction then names each of them with a one byte index instead. Only the
 * accounts particular to one portfolio are still spelled out, which keeps even
 * an eight asset settlement far inside the limit.
 *
 * It changes nothing about what settle checks. The program receives exactly
 * the same accounts in the same order; the table only shortens how the
 * transaction writes them down.
 *
 * Usage
 * -----
 *   npm run desk:lookup-table
 *
 * Run on the build host after `setup-desk`, which rewrites the desk config and
 * drops the table, because a table built for an old desk would name accounts
 * the new one does not use. Writes `lookupTable` into the desk config.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

const CONFIG = path.resolve(process.cwd(), "app/src/lib/desk.devnet.json");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGqPVydviL1TB8aM5d2hqX8");

/** Addresses per extend. Kept well under what one transaction can carry. */
const CHUNK = 20;

interface DeskConfig {
  cashMint: string;
  desk: string;
  deskCash: string;
  lookupTable?: string;
  settleable: { symbol: string; mint: string; priceAccount: string; deskTokenAccount: string }[];
}

async function main(): Promise<void> {
  const provider = anchor.AnchorProvider.env();
  const { connection, wallet } = provider;
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf8")) as DeskConfig;

  const addresses = [
    config.desk,
    config.cashMint,
    config.deskCash,
    TOKEN_PROGRAM.toBase58(),
    ...config.settleable.flatMap((a) => [a.priceAccount, a.mint, a.deskTokenAccount]),
  ];
  const unique = [...new Set(addresses)].map((a) => new PublicKey(a));
  console.log(`authority ${wallet.publicKey.toBase58()}`);
  console.log(`${unique.length} addresses for ${config.settleable.length} assets`);

  const send = async (tx: Transaction) => {
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = latest.blockhash;
    const signed = await wallet.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    return signature;
  };

  const slot = await connection.getSlot("finalized");
  const [create, table] = AddressLookupTableProgram.createLookupTable({
    authority: wallet.publicKey,
    payer: wallet.publicKey,
    recentSlot: slot,
  });
  await send(new Transaction().add(create));
  console.log(`created ${table.toBase58()}`);

  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    await send(
      new Transaction().add(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: table,
          authority: wallet.publicKey,
          payer: wallet.publicKey,
          addresses: batch,
        }),
      ),
    );
    console.log(`  added ${Math.min(i + CHUNK, unique.length)} of ${unique.length}`);
  }

  const stored = await connection.getAddressLookupTable(table);
  const count = stored.value?.state.addresses.length ?? 0;
  if (count !== unique.length) {
    throw new Error(`the table holds ${count} addresses, expected ${unique.length}`);
  }

  fs.writeFileSync(CONFIG, `${JSON.stringify({ ...config, lookupTable: table.toBase58() }, null, 2)}\n`);
  console.log(`\nwrote lookupTable ${table.toBase58()} to ${path.relative(process.cwd(), CONFIG)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
