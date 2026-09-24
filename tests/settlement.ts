/**
 * Settlement, against the deployed program on devnet.
 *
 * Every other suite in this repository tests policy. A mandate is checked, a
 * proposal is accepted or refused, a weight is stored. None of it moves
 * anything, and until this instruction existed the honest description of a
 * position was a number in an account.
 *
 * These tests are about value changing hands. They assert on token balances
 * before and after, because a balance is the one thing here that cannot be a
 * claim about itself: the mandate can say what it permits and the portfolio can
 * say what it targets, but a token account says what is actually held.
 *
 * The desk is real inventory, funded once by `npm run desk`, and the prices
 * come from Pyth accounts on devnet that the program reads and checks against
 * the feed each mandate bound at creation.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";

import type { Conduit } from "../app/src/lib/idl/conduit";
import {
  mandatePda as chainMandatePda,
  portfolioPda,
} from "../app/src/lib/chain";

/**
 * Built at `confirmed` rather than taken from the environment, for the reason
 * recorded in `activity.ts`: the default is `processed`, which is below the
 * level a transaction must reach before its effects are readable.
 */
const base = anchor.AnchorProvider.env();
const provider = new anchor.AnchorProvider(
  new Connection(base.connection.rpcEndpoint, "confirmed"),
  base.wallet,
  { commitment: "confirmed", preflightCommitment: "confirmed" },
);
anchor.setProvider(provider);

const idl = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), "target", "idl", "conduit.json"),
    "utf8",
  ),
) as Conduit;

const program = new Program<Conduit>(idl, provider);
const owner = provider.wallet;
const connection = provider.connection;

interface DeskConfig {
  cashMint: string;
  cashDecimals: number;
  desk: string;
  deskCash: string;
  settleable: {
    symbol: string;
    mint: string;
    decimals: number;
    feedId: string;
    priceAccount: string;
    deskTokenAccount: string;
    source: "pyth" | "published";
  }[];
}

const desk = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), "app", "src", "lib", "desk.devnet.json"),
    "utf8",
  ),
) as DeskConfig;

const CASH_MINT = new PublicKey(desk.cashMint);
const DESK = new PublicKey(desk.desk);
const DESK_CASH = new PublicKey(desk.deskCash);

/**
 * The assets these tests settle.
 *
 * A deliberate subset, not the whole desk. The desk now carries eighteen
 * assets and a mandate may permit at most eight, so building one over
 * everything the desk stocks stopped being possible the moment the equities
 * were added. It used to work only because the desk happened to hold exactly
 * three things, which is the kind of assumption that silently becomes wrong.
 *
 * Whatever the desk actually carries, capped at three. Not filtered by price
 * source: these tests are about settlement arithmetic and the refusals around
 * it, and the program reads both sources through the same path by design. A
 * test that only ran against one of them would stop covering the configuration
 * the demo actually uses the moment that configuration changed.
 */
const SETTLED = desk.settleable.slice(0, 3);

if (SETTLED.length === 0) {
  throw new Error("no settleable assets in the desk config");
}

let nextId = Date.now() + 2_000_000;
const freshId = () => new BN(nextId++);

/** Whole units of cash each test portfolio is funded with. */
const FUNDING = 10_000;

const hex = (s: string) => Array.from(Buffer.from(s, "hex"));

interface Opened {
  mandate: PublicKey;
  portfolio: PublicKey;
  agent: Keypair;
  cash: PublicKey;
  assets: { symbol: string; mint: PublicKey; ata: PublicKey }[];
}

/**
 * Creates a settleable mandate, opens its portfolio, and funds it with cash.
 *
 * The portfolio starts as pure cash, which is what a real one does: money
 * arrives before it is allocated.
 */
async function open(constraints: {
  maxPositionBps: number;
  minCashBps: number;
  maxTurnoverBps: number;
  maxAssets: number;
}): Promise<Opened> {
  const mandateId = freshId();
  const mandate = chainMandatePda(owner.publicKey, mandateId);
  const portfolio = portfolioPda(mandate);
  const agent = Keypair.generate();

  await program.methods
    .initializeMandate(
      mandateId,
      constraints,
      SETTLED.map((a) => ({
        mint: new PublicKey(a.mint),
        feedId: hex(a.feedId),
      })),
      agent.publicKey,
    )
    .accountsStrict({
      mandate,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .postInstructions([
      await program.methods
        .initializePortfolio()
        .accountsStrict({
          mandate,
          portfolio,
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ])
    .rpc();

  // Token accounts for the portfolio, owned by the PDA.
  const cash = getAssociatedTokenAddressSync(CASH_MINT, portfolio, true);
  const assets = SETTLED.map((a) => ({
    symbol: a.symbol,
    mint: new PublicKey(a.mint),
    ata: getAssociatedTokenAddressSync(new PublicKey(a.mint), portfolio, true),
  }));

  const setup = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      owner.publicKey,
      cash,
      portfolio,
      CASH_MINT,
    ),
    ...assets.map((a) =>
      createAssociatedTokenAccountInstruction(
        owner.publicKey,
        a.ata,
        portfolio,
        a.mint,
      ),
    ),
    createMintToInstruction(
      CASH_MINT,
      cash,
      owner.publicKey,
      BigInt(FUNDING) * BigInt(10) ** BigInt(desk.cashDecimals),
    ),
  );
  await provider.sendAndConfirm(setup);

  return { mandate, portfolio, agent, cash, assets };
}

/** The four accounts `settle` expects per asset, in mandate order. */
function settlementAccounts(opened: Opened) {
  return SETTLED.flatMap((a, i) => [
    { pubkey: new PublicKey(a.priceAccount), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(a.mint), isSigner: false, isWritable: false },
    { pubkey: opened.assets[i].ata, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(a.deskTokenAccount), isSigner: false, isWritable: true },
  ]);
}

function settle(opened: Opened) {
  return program.methods
    .settle()
    .accountsStrict({
      mandate: opened.mandate,
      portfolio: opened.portfolio,
      desk: DESK,
      agent: opened.agent.publicKey,
      cashMint: CASH_MINT,
      portfolioCash: opened.cash,
      deskCash: DESK_CASH,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .remainingAccounts(settlementAccounts(opened))
    .signers([opened.agent])
    .rpc();
}

async function balances(opened: Opened) {
  const cash = (await getAccount(connection, opened.cash)).amount;
  const held: Record<string, bigint> = {};
  for (const a of opened.assets) {
    held[a.symbol] = (await getAccount(connection, a.ata)).amount;
  }
  return { cash, held };
}

const MODERATE = {
  maxPositionBps: 4000,
  minCashBps: 1000,
  maxTurnoverBps: 10_000,
  maxAssets: 3,
};

describe("settlement moves real tokens", () => {
  it("buys what the portfolio targets and pays for it in cash", async () => {
    const opened = await open(MODERATE);
    const before = await balances(opened);

    assert.equal(
      before.cash,
      BigInt(FUNDING) * BigInt(10) ** BigInt(desk.cashDecimals),
      "the portfolio should start as pure cash",
    );
    for (const a of opened.assets) {
      assert.equal(before.held[a.symbol], 0n, `${a.symbol} should start empty`);
    }

    // A quarter into each of the three, leaving a quarter in cash.
    await program.methods
      .proposeRebalance(
        opened.assets.map((a) => ({ mint: a.mint, targetBps: 2500 })),
      )
      .accountsStrict({
        mandate: opened.mandate,
        portfolio: opened.portfolio,
        agent: opened.agent.publicKey,
      })
      .signers([opened.agent])
      .rpc();

    await settle(opened);
    const after = await balances(opened);

    // The assertion that matters: the portfolio holds tokens it did not hold.
    for (const a of opened.assets) {
      assert.isAbove(
        Number(after.held[a.symbol]),
        0,
        `${a.symbol} was never actually bought`,
      );
    }

    assert.isBelow(
      Number(after.cash),
      Number(before.cash),
      "the assets were acquired without paying for them",
    );

    // A quarter in cash, within a base unit of rounding.
    const expectedCash = before.cash / 4n;
    const drift =
      after.cash > expectedCash
        ? after.cash - expectedCash
        : expectedCash - after.cash;
    assert.isBelow(
      Number(drift),
      Number(before.cash / 1000n),
      `cash landed at ${after.cash}, expected about ${expectedCash}`,
    );
  });

  it("sells back to cash when the targets go to zero", async () => {
    const opened = await open(MODERATE);

    await program.methods
      .proposeRebalance([{ mint: opened.assets[0].mint, targetBps: 3000 }])
      .accountsStrict({
        mandate: opened.mandate,
        portfolio: opened.portfolio,
        agent: opened.agent.publicKey,
      })
      .signers([opened.agent])
      .rpc();
    await settle(opened);

    const bought = await balances(opened);
    assert.isAbove(Number(bought.held[opened.assets[0].symbol]), 0);

    // Everything back to cash. A single position at a hundred percent cash is
    // expressed as an empty proposal being refused, so target the smallest
    // permitted position in something else and let the first exit entirely.
    await program.methods
      .proposeRebalance([{ mint: opened.assets[1].mint, targetBps: 100 }])
      .accountsStrict({
        mandate: opened.mandate,
        portfolio: opened.portfolio,
        agent: opened.agent.publicKey,
      })
      .signers([opened.agent])
      .rpc();
    await settle(opened);

    const after = await balances(opened);
    assert.equal(
      after.held[opened.assets[0].symbol],
      0n,
      "the position was not fully closed, which leaves dust that never clears",
    );
    assert.isAbove(
      Number(after.cash),
      Number(bought.cash),
      "selling did not return cash to the portfolio",
    );
  });

  it("does nothing when the portfolio already matches its targets", async () => {
    const opened = await open(MODERATE);

    await program.methods
      .proposeRebalance([{ mint: opened.assets[0].mint, targetBps: 2000 }])
      .accountsStrict({
        mandate: opened.mandate,
        portfolio: opened.portfolio,
        agent: opened.agent.publicKey,
      })
      .signers([opened.agent])
      .rpc();

    await settle(opened);
    const settled = await balances(opened);

    // Settling again should be very nearly a no op. Prices move between the two
    // calls, so an exact equality would be testing that devnet stood still.
    await settle(opened);
    const again = await balances(opened);

    const moved =
      again.cash > settled.cash
        ? again.cash - settled.cash
        : settled.cash - again.cash;

    assert.isBelow(
      Number(moved),
      Number(settled.cash / 100n),
      "a second settlement churned the portfolio rather than leaving it alone",
    );
  });

  it("refuses a price account for the wrong feed", async () => {
    const opened = await open(MODERATE);

    await program.methods
      .proposeRebalance([{ mint: opened.assets[0].mint, targetBps: 2000 }])
      .accountsStrict({
        mandate: opened.mandate,
        portfolio: opened.portfolio,
        agent: opened.agent.publicKey,
      })
      .signers([opened.agent])
      .rpc();

    // Bitcoin's price, handed in where Ether's belongs. Both are real, live,
    // correctly owned accounts. Only the binding recorded in the mandate makes
    // one of them wrong here, which is the whole point of storing a feed id.
    const swapped = settlementAccounts(opened);
    swapped[4] = {
      pubkey: new PublicKey(SETTLED[0].priceAccount),
      isSigner: false,
      isWritable: false,
    };

    try {
      await program.methods
        .settle()
        .accountsStrict({
          mandate: opened.mandate,
          portfolio: opened.portfolio,
          desk: DESK,
          agent: opened.agent.publicKey,
          cashMint: CASH_MINT,
          portfolioCash: opened.cash,
          deskCash: DESK_CASH,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(swapped)
        .signers([opened.agent])
        .rpc();
      assert.fail("a price for the wrong instrument was accepted");
    } catch (error) {
      assert.include(String(error), "PriceFeedMismatch");
    }
  });

  it("refuses a signer that is not the delegated agent", async () => {
    const opened = await open(MODERATE);
    const impostor = Keypair.generate();

    try {
      await program.methods
        .settle()
        .accountsStrict({
          mandate: opened.mandate,
          portfolio: opened.portfolio,
          desk: DESK,
          agent: impostor.publicKey,
          cashMint: CASH_MINT,
          portfolioCash: opened.cash,
          deskCash: DESK_CASH,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(settlementAccounts(opened))
        .signers([impostor])
        .rpc();
      assert.fail("anyone could settle somebody else's portfolio");
    } catch (error) {
      assert.include(String(error), "UnauthorizedAgent");
    }
  });

  it("refuses to settle a paused mandate", async () => {
    const opened = await open(MODERATE);

    await program.methods
      .setMandateStatus({ paused: {} })
      .accountsStrict({ mandate: opened.mandate, owner: owner.publicKey })
      .rpc();

    try {
      await settle(opened);
      assert.fail("a paused mandate was settled");
    } catch (error) {
      assert.include(String(error), "MandateNotActive");
    }
  });
});
