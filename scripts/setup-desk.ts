/**
 * Creates the settlement currency and stocks the desk that trades against it.
 *
 * Why a desk exists
 * -----------------
 * A purchase needs a counterparty. The devnet mints in this registry have no
 * pools and no order books, so there is nobody on the other side unless one is
 * provided, and minting into the portfolio on demand would look like trading
 * while actually being printing.
 *
 * So the desk holds finite inventory and swaps at the oracle price. That is not
 * a workaround for the absence of a venue, it is how tokenized equities work in
 * the primary market: you do not find a seller, you create and redeem with the
 * issuer at net asset value. Backed and PreStocks both work this way.
 *
 * What it creates
 * ---------------
 *   a cash mint      the settlement currency, six decimals, as stablecoins use
 *   the desk account a PDA owning the inventory
 *   desk holdings    a token account per settleable asset, funded
 *   a cash float     so the desk can buy as well as sell
 *
 * Only assets with a live Pyth price account on this cluster are included,
 * because an asset the program cannot price is one it will refuse to settle.
 *
 * Usage
 * -----
 *   npm run desk              create anything missing, then top up
 *   npm run desk -- --force   recreate the cash mint from scratch
 *
 * Idempotent. Existing accounts are reused and only the balances are topped up,
 * so running it again after adding an asset does the right thing.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
} from "@solana/spl-token";

import type { Conduit } from "../app/src/lib/idl/conduit";

const CASH_DECIMALS = 6;

/** Whole units of cash the desk floats, so it can buy as well as sell. */
const DESK_CASH_FLOAT = 5_000_000;

/** Whole units of each asset the desk stocks. */
const DESK_ASSET_UNITS = 100_000;

const REGISTRY = path.resolve(process.cwd(), "app/src/lib/registry.devnet.json");
const CONFIG = path.resolve(process.cwd(), "app/src/lib/desk.devnet.json");

interface RegistryAsset {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  assetClass: string;
  priceAccount?: string;
  feeds?: { primary: string };
}

interface DeskConfig {
  cluster: string;
  generatedAt: string;
  cashMint: string;
  cashDecimals: number;
  desk: string;
  deskCash: string;
  /** Assets the program can price, and therefore settle. */
  settleable: {
    symbol: string;
    mint: string;
    decimals: number;
    feedId: string;
    priceAccount: string;
    deskTokenAccount: string;
  }[];
}

function readConfig(): DeskConfig | null {
  if (!fs.existsSync(CONFIG)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8")) as DeskConfig;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), "target", "idl", "conduit.json"),
      "utf8",
    ),
  ) as Conduit;
  const program = new Program<Conduit>(idl, provider);

  const payer = provider.wallet;
  const connection = provider.connection;

  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")) as {
    assets: RegistryAsset[];
  };

  // An asset with no live price account cannot be settled, because the program
  // refuses to value anything it cannot verify.
  const settleable = registry.assets.filter((a) => a.priceAccount && a.feeds);

  if (settleable.length === 0) {
    console.error("No asset in the registry has a price account. Nothing can settle.");
    process.exit(1);
  }

  console.log(`settleable assets: ${settleable.map((a) => a.symbol).join(", ")}`);

  const existing = force ? null : readConfig();

  /* ---- the settlement currency ---- */

  let cashMint: PublicKey;

  if (existing?.cashMint && !force) {
    cashMint = new PublicKey(existing.cashMint);
    console.log(`cash mint      reusing ${cashMint.toBase58()}`);
  } else {
    const mintKeypair = Keypair.generate();
    const lamports = await getMinimumBalanceForRentExemptMint(connection);

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mintKeypair.publicKey,
        CASH_DECIMALS,
        payer.publicKey,
        payer.publicKey,
      ),
    );

    await provider.sendAndConfirm(tx, [mintKeypair]);
    cashMint = mintKeypair.publicKey;
    console.log(`cash mint      created ${cashMint.toBase58()}`);
  }

  /* ---- the desk ---- */

  const [desk] = PublicKey.findProgramAddressSync(
    [Buffer.from("desk")],
    program.programId,
  );

  const deskAccount = await connection.getAccountInfo(desk);
  if (deskAccount) {
    console.log(`desk           exists  ${desk.toBase58()}`);
  } else {
    await program.methods
      .initializeDesk()
      .accountsStrict({
        desk,
        cashMint,
        authority: payer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`desk           created ${desk.toBase58()}`);
  }

  /* ---- inventory ---- */

  /** Creates the token account if absent, then tops it up to `units`. */
  async function stock(
    mint: PublicKey,
    decimals: number,
    units: number,
    label: string,
  ): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, desk, true);
    const target = BigInt(units) * BigInt(10) ** BigInt(decimals);

    let held = 0n;
    const info = await connection.getAccountInfo(ata);

    if (!info) {
      await provider.sendAndConfirm(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            ata,
            desk,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        ),
      );
    } else {
      held = (await getAccount(connection, ata)).amount;
    }

    if (held < target) {
      await provider.sendAndConfirm(
        new Transaction().add(
          createMintToInstruction(mint, ata, payer.publicKey, target - held),
        ),
      );
      console.log(
        `${label.padEnd(15)}stocked ${units.toLocaleString()} units  ${ata.toBase58()}`,
      );
    } else {
      console.log(`${label.padEnd(15)}already holds enough  ${ata.toBase58()}`);
    }

    return ata;
  }

  const deskCash = await stock(cashMint, CASH_DECIMALS, DESK_CASH_FLOAT, "desk cash");

  const stocked: DeskConfig["settleable"] = [];
  for (const asset of settleable) {
    const ata = await stock(
      new PublicKey(asset.mint),
      asset.decimals,
      DESK_ASSET_UNITS,
      `desk ${asset.symbol}`,
    );
    stocked.push({
      symbol: asset.symbol,
      mint: asset.mint,
      decimals: asset.decimals,
      feedId: asset.feeds!.primary,
      priceAccount: asset.priceAccount!,
      deskTokenAccount: ata.toBase58(),
    });
  }

  const config: DeskConfig = {
    cluster: "devnet",
    generatedAt: new Date().toISOString(),
    cashMint: cashMint.toBase58(),
    cashDecimals: CASH_DECIMALS,
    desk: desk.toBase58(),
    deskCash: deskCash.toBase58(),
    settleable: stocked,
  };

  fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(process.cwd(), CONFIG)}`);
  console.log(`the desk can settle: ${stocked.map((s) => s.symbol).join(", ")}`);
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
