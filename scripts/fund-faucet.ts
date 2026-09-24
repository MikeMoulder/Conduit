/**
 * Stocks the devnet faucet with demo cash.
 *
 * The faucet is how somebody who is not us finishes the flow. A browser wallet
 * can create a mandate, but a portfolio needs cash before it can settle into
 * anything, and only the cash mint authority can create cash. That authority
 * is the build host wallet and it stays off the web server, because a key that
 * can mint without limit does not belong behind an HTTP route.
 *
 * So the faucet holds a finite float, minted to it here, once. The web app
 * holds the faucet key and can only hand out what the faucet already has. The
 * worst a bug in that route can do is empty the float.
 *
 * Usage
 * -----
 *   npm run faucet -- <faucet-pubkey> [--cash 2000000]
 *
 * Tops the float up to the target rather than adding to it, so running this
 * twice does not double anything. Run on the build host, which holds the mint
 * authority.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const DESK_CONFIG = path.resolve(process.cwd(), "app/src/lib/desk.devnet.json");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || target.startsWith("--")) {
    console.error("usage: npm run faucet -- <faucet-pubkey> [--cash 2000000]");
    process.exit(1);
  }

  const faucet = new PublicKey(target);
  const units = Number(arg("--cash") ?? 2_000_000);

  const provider = anchor.AnchorProvider.env();
  const payer = provider.wallet.publicKey;

  const desk = JSON.parse(fs.readFileSync(DESK_CONFIG, "utf8")) as {
    cashMint: string;
    cashDecimals: number;
  };
  const cashMint = new PublicKey(desk.cashMint);
  const ata = getAssociatedTokenAddressSync(cashMint, faucet);

  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        ata,
        faucet,
        cashMint,
      ),
    ),
  );

  const held = BigInt(
    (await provider.connection.getTokenAccountBalance(ata)).value.amount,
  );
  const want = BigInt(units) * BigInt(10) ** BigInt(desk.cashDecimals);

  if (held < want) {
    await provider.sendAndConfirm(
      new Transaction().add(
        createMintToInstruction(cashMint, ata, payer, want - held),
      ),
    );
    console.log(`faucet topped up to ${units.toLocaleString()} cash`);
  } else {
    console.log(`faucet already holds ${Number(held) / 10 ** desk.cashDecimals}`);
  }

  console.log(`faucet cash account ${ata.toBase58()}`);
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
