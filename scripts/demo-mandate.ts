/**
 * Creates a funded mandate the copilot can actually settle.
 *
 * Why this exists
 * ---------------
 * The integration suite builds its own mandates and throws them away. This
 * builds one that survives, delegated to the key the running app signs with, so
 * a settlement can be driven through the real routes and the real chat window
 * rather than through a test harness.
 *
 * It also has to run here rather than in the browser, for one unavoidable
 * reason: funding a portfolio means minting the settlement currency, and only
 * the wallet that created the cash mint can do that. That is the same wallet
 * that created the desk, which is the build host. A browser wallet can create a
 * mandate but cannot give it anything to trade with.
 *
 * The mandate permits exactly the assets the program can price on chain, since
 * a mandate containing one unpriceable asset cannot be settled at all.
 *
 * Usage
 * -----
 *   npm run demo:mandate -- <agent-pubkey> [--id N] [--cash 25000]
 *
 * The agent public key comes from the app, at /api/agent/identity. Passing the
 * wrong one produces a mandate the app cannot act on, which the program will
 * refuse with UnauthorizedAgent rather than silently ignore.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import type { Conduit } from "../app/src/lib/idl/conduit";

const DESK_CONFIG = path.resolve(process.cwd(), "app/src/lib/desk.devnet.json");

interface DeskConfig {
  cashMint: string;
  cashDecimals: number;
  settleable: { symbol: string; mint: string; feedId: string }[];
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** A feed id is stored as 32 raw bytes, and written everywhere else as hex. */
function hex(value: string): number[] {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  return Array.from(Buffer.from(clean, "hex"));
}

function mandatePda(
  owner: PublicKey,
  id: number,
  programId: PublicKey,
): PublicKey {
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), owner.toBuffer(), seed],
    programId,
  )[0];
}

async function main(): Promise<void> {
  const agentArg = process.argv[2];
  if (!agentArg || agentArg.startsWith("--")) {
    console.error(
      "usage: npm run demo:mandate -- <agent-pubkey> [--id N] [--cash 25000]",
    );
    console.error("get the agent key from the running app at /api/agent/identity");
    process.exit(1);
  }

  let agent: PublicKey;
  try {
    agent = new PublicKey(agentArg);
  } catch {
    console.error(`not a valid public key: ${agentArg}`);
    process.exit(1);
  }

  const mandateId = Number(arg("--id") ?? 0);
  const cashUnits = Number(arg("--cash") ?? 25_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "target/idl/conduit.json"), "utf8"),
  ) as Conduit;
  const program = new Program<Conduit>(idl, provider);

  const desk = JSON.parse(fs.readFileSync(DESK_CONFIG, "utf8")) as DeskConfig;
  const cashMint = new PublicKey(desk.cashMint);
  const owner = provider.wallet.publicKey;

  const mandate = mandatePda(owner, mandateId, program.programId);
  const [portfolio] = PublicKey.findProgramAddressSync(
    [Buffer.from("portfolio"), mandate.toBuffer()],
    program.programId,
  );

  console.log(`owner     ${owner.toBase58()}`);
  console.log(`agent     ${agent.toBase58()}`);
  console.log(`mandate   ${mandate.toBase58()}  (id ${mandateId})`);
  console.log(`portfolio ${portfolio.toBase58()}`);
  console.log(`assets    ${desk.settleable.map((a) => a.symbol).join(", ")}`);

  const already = await provider.connection.getAccountInfo(mandate);

  if (already) {
    console.log("\nmandate exists, leaving it alone");
  } else {
    await program.methods
      .initializeMandate(
        new BN(mandateId),
        {
          // Room for three positions without forcing any of them, and a cash
          // floor low enough that a settlement actually moves most of the book.
          maxPositionBps: 5000,
          minCashBps: 1000,
          maxTurnoverBps: 9000,
          maxAssets: 3,
        },
        desk.settleable.map((a) => ({
          mint: new PublicKey(a.mint),
          feedId: hex(a.feedId),
        })),
        agent,
      )
      .accountsStrict({
        mandate,
        owner,
        systemProgram: SystemProgram.programId,
      })
      .postInstructions([
        await program.methods
          .initializePortfolio()
          .accountsStrict({
            mandate,
            portfolio,
            owner,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ])
      .rpc();
    console.log("\nmandate and portfolio created");
  }

  /* ---- token accounts, and the cash to trade with ---- */

  const cashAta = getAssociatedTokenAddressSync(cashMint, portfolio, true);
  const assetAtas = desk.settleable.map((a) => ({
    symbol: a.symbol,
    ata: getAssociatedTokenAddressSync(new PublicKey(a.mint), portfolio, true),
    mint: new PublicKey(a.mint),
  }));

  const infos = await provider.connection.getMultipleAccountsInfo([
    cashAta,
    ...assetAtas.map((a) => a.ata),
  ]);

  const create = [];
  if (!infos[0]) {
    create.push(
      createAssociatedTokenAccountInstruction(owner, cashAta, portfolio, cashMint),
    );
  }
  assetAtas.forEach((a, i) => {
    if (!infos[i + 1]) {
      create.push(
        createAssociatedTokenAccountInstruction(owner, a.ata, portfolio, a.mint),
      );
    }
  });

  if (create.length > 0) {
    await provider.sendAndConfirm(new Transaction().add(...create));
    console.log(`created ${create.length} token account(s)`);
  } else {
    console.log("token accounts already exist");
  }

  // Topped up to the target rather than added to, so running this twice does
  // not quietly double the size of the demo portfolio.
  const held = BigInt(
    (await provider.connection.getTokenAccountBalance(cashAta)).value.amount,
  );
  const want = BigInt(cashUnits) * BigInt(10) ** BigInt(desk.cashDecimals);

  if (held < want) {
    await provider.sendAndConfirm(
      new Transaction().add(
        createMintToInstruction(cashMint, cashAta, owner, want - held),
      ),
    );
    console.log(`funded to ${cashUnits.toLocaleString()} cash`);
  } else {
    console.log(`already holds ${Number(held) / 10 ** desk.cashDecimals} cash`);
  }

  console.log(`\nmandate address: ${mandate.toBase58()}`);
  console.log("the copilot can propose against this, and settle it");
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
