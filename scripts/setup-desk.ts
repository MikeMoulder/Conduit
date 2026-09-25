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
import {
  priceSourceFor,
  publishedFeedIdHex,
} from "../app/src/lib/published-feeds";

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
    /** Which price source the program will read this asset from. */
    source: "pyth" | "published";
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
  // Off by default. See priceSourceFor for why the safe default is ours.
  const preferPyth = process.argv.includes("--pyth-crypto");

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

  /**
   * Every asset the program can price, by whichever of the two routes applies.
   *
   * Crypto has a live Pyth account on devnet and uses it. Everything else is
   * priced by this project's own publisher, because Pyth will not serve the
   * equities without a commercial grant and nobody at all prices the pre IPO
   * names. The account address is derived here rather than looked up: a
   * published price lives at a PDA of its feed id, so it can be addressed
   * before it has ever been written.
   */
  const [publisherPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("publisher")],
    program.programId,
  );

  const settleable = registry.assets
    .map((asset) => {
      const source = priceSourceFor(asset.assetClass, preferPyth);

      if (source === "pyth") {
        // A recorded feed id is not the same as an available price, so an
        // asset without a live account is skipped rather than assumed.
        if (!asset.priceAccount || !asset.feeds) return null;
        return {
          asset,
          source,
          feedId: asset.feeds.primary,
          priceAccount: asset.priceAccount,
        };
      }

      const feedId = publishedFeedIdHex(asset.symbol);
      const [priceAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("price"), Buffer.from(feedId, "hex")],
        program.programId,
      );
      return { asset, source, feedId, priceAccount: priceAccount.toBase58() };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (settleable.length === 0) {
    console.error("No asset in the registry can be priced. Nothing can settle.");
    process.exit(1);
  }

  const byPyth = settleable.filter((e) => e.source === "pyth");
  const byUs = settleable.filter((e) => e.source === "published");
  console.log(`priced by pyth      ${byPyth.map((e) => e.asset.symbol).join(", ")}`);
  console.log(`priced by publisher ${byUs.map((e) => e.asset.symbol).join(", ")}`);
  console.log(`publisher account   ${publisherPda.toBase58()}`);

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

  /* ---- price bindings for main wallet trades ---- */

  async function bindFeeds(entries: DeskConfig["settleable"]): Promise<void> {

    // A main wallet has no mandate to bind its assets to feeds, so the desk
    // states the binding itself, once per mint. Without it a trade could pair
    // one asset's mint with another asset's price.
    for (const entry of entries) {
      const mint = new PublicKey(entry.mint);
      const [deskAsset] = PublicKey.findProgramAddressSync(
        [Buffer.from("desk_asset"), mint.toBuffer()],
        program.programId,
      );
      if (await connection.getAccountInfo(deskAsset)) {
        console.log(`bound  ${entry.symbol.padEnd(10)} already`);
        continue;
      }
      await program.methods
        .registerDeskAsset(Array.from(Buffer.from(entry.feedId, "hex")))
        .accountsStrict({
          desk,
          deskAsset,
          mint,
          authority: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`bound  ${entry.symbol.padEnd(10)} to its ${entry.source} feed`);
    }
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

  // --bind-only reuses the config already written and only states the price
  // bindings. Stocking reads every token account, around forty requests, and
  // on the public devnet RPC that alone is enough to be rate limited.
  if (process.argv.includes("--bind-only")) {
    const current = readConfig();
    if (!current) {
      console.error("no desk config yet; run without --bind-only first");
      process.exit(1);
    }
    await bindFeeds(current.settleable);
    return;
  }

  const deskCash = await stock(cashMint, CASH_DECIMALS, DESK_CASH_FLOAT, "desk cash");

  const stocked: DeskConfig["settleable"] = [];
  for (const entry of settleable) {
    const { asset } = entry;
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
      feedId: entry.feedId,
      priceAccount: entry.priceAccount,
      deskTokenAccount: ata.toBase58(),
      source: entry.source,
    });
  }

  await bindFeeds(stocked);

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
  console.log("the lookup table is not carried over: run npm run desk:lookup-table");
  console.log(`the desk can settle: ${stocked.map((s) => s.symbol).join(", ")}`);
  console.log(
    "a published price must be written before those assets will settle: npm run publish:prices",
  );
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
