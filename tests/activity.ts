/**
 * Integration tests for the activity feed, run against the deployed program on
 * devnet.
 *
 * The feed is the project's claim about its own past, so the thing worth
 * testing is that the claim is recoverable from the chain and nowhere else.
 * Each test performs a real action, then reads it back the way the interface
 * does: the signature list for the mandate account, and the logs of each
 * transaction in it.
 *
 * Refusals get particular attention. They are the more interesting half of any
 * history here, and they only exist to be found when the transaction actually
 * reached the ledger, so the test submits one the way the interface does, with
 * preflight skipped.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import type { Stockpilot } from "../target/types/stockpilot";
import {
  extractProgramError,
  mandatePda as chainMandatePda,
  portfolioPda,
} from "../app/src/lib/chain";
import { fetchMandate } from "../app/src/lib/accounts";
import { fetchActivity, type ActivityRecord } from "../app/src/lib/events";

/**
 * Built explicitly at `confirmed` rather than taken from the environment.
 *
 * `AnchorProvider.env()` defaults to `processed`, which is below the level
 * `getSignaturesForAddress` will serve and below the level a transaction has to
 * reach before it appears in an account history. Left at the default, every
 * test here would send successfully and then read back an empty feed, which
 * looks like a decoding bug and is not one.
 *
 * This is also the level the browser uses, so these tests exercise the same
 * timing the interface does.
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
    path.resolve(process.cwd(), "target", "idl", "stockpilot.json"),
    "utf8",
  ),
) as Stockpilot;

const program = new Program<Stockpilot>(idl, provider);
const owner = provider.wallet;
const connection = provider.connection;

let nextId = Date.now() + 1_300_000;
const freshId = () => new BN(nextId++);
const mint = () => Keypair.generate().publicKey;

const CONSTRAINTS = {
  maxPositionBps: 2500,
  minCashBps: 1000,
  maxTurnoverBps: 4000,
  maxAssets: 4,
};

interface Opened {
  mandate: PublicKey;
  portfolio: PublicKey;
  agent: Keypair;
  mints: PublicKey[];
}

async function open(): Promise<Opened> {
  const mandateId = freshId();
  const mandate = chainMandatePda(owner.publicKey, mandateId);
  const portfolio = portfolioPda(mandate);
  const agent = Keypair.generate();
  const mints = [mint(), mint(), mint()];

  await program.methods
    .initializeMandate(
      mandateId,
      CONSTRAINTS,
      mints.map((m) => ({ mint: m, feedId: Array(32).fill(0) })),
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

  return { mandate, portfolio, agent, mints };
}

function propose(
  opened: Opened,
  positions: { mint: PublicKey; targetBps: number }[],
  options?: { skipPreflight?: boolean },
) {
  return program.methods
    .proposeRebalance(positions)
    .accountsStrict({
      mandate: opened.mandate,
      portfolio: opened.portfolio,
      agent: opened.agent.publicKey,
    })
    .signers([opened.agent])
    .rpc(options);
}

describe("the activity feed", () => {
  it("recovers an accepted rebalance from the event the program emitted", async () => {
    const opened = await open();

    await propose(opened, [
      { mint: opened.mints[0], targetBps: 2000 },
      { mint: opened.mints[1], targetBps: 1500 },
    ]);

    const records = await fetchActivity(connection, opened.mandate);
    const accepted = records.filter(
      (r): r is Extract<ActivityRecord, { kind: "accepted" }> =>
        r.kind === "accepted",
    );

    assert.lengthOf(accepted, 1, "expected exactly one accepted rebalance");

    const { event } = accepted[0];
    assert.equal(event.mandate, opened.mandate.toBase58());
    assert.equal(event.portfolio, opened.portfolio.toBase58());
    assert.equal(event.agent, opened.agent.publicKey.toBase58());
    assert.equal(event.positionCount, 2);
    assert.equal(event.cashBps, 6500);
    assert.equal(event.turnoverBps, 3500, "deploying 3500 from cash costs 3500");
    assert.isAbove(event.timestamp, 0, "the event carries a cluster timestamp");

    // The sequence comes from the mandate rather than from the feed, so a gap
    // in what was read back is visible rather than silently renumbered.
    const mandate = await fetchMandate(connection, opened.mandate);
    assert.equal(event.sequence, mandate!.rebalanceCount);
  });

  it("numbers rebalances in the order the program recorded them", async () => {
    const opened = await open();

    await propose(opened, [{ mint: opened.mints[0], targetBps: 2000 }]);
    await propose(opened, [
      { mint: opened.mints[0], targetBps: 2000 },
      { mint: opened.mints[1], targetBps: 1000 },
    ]);

    const records = await fetchActivity(connection, opened.mandate);
    const sequences = records
      .filter(
        (r): r is Extract<ActivityRecord, { kind: "accepted" }> =>
          r.kind === "accepted",
      )
      .map((r) => r.event.sequence);

    // Newest first, so the sequence runs down.
    assert.deepEqual(sequences, [2, 1]);
  });

  it("finds a refusal that was submitted without preflight", async () => {
    const opened = await open();

    let thrown: unknown = null;
    try {
      // Skipping preflight is what the interface does when it already expects a
      // refusal, so the transaction lands and the refusal becomes a permanent,
      // publicly checkable record rather than a message in a browser.
      await propose(opened, [{ mint: opened.mints[0], targetBps: 9000 }], {
        skipPreflight: true,
      });
      assert.fail("the program accepted a proposal above the position cap");
    } catch (error) {
      thrown = error;
    }

    assert.isNotNull(thrown);

    const records = await fetchActivity(connection, opened.mandate);
    const refused = records.filter(
      (r): r is Extract<ActivityRecord, { kind: "refused" }> =>
        r.kind === "refused",
    );

    assert.lengthOf(refused, 1, "the refusal should be in the account history");
    assert.isNotNull(refused[0].error, "the refusal should name a clause");
    assert.equal(refused[0].error!.name, "PositionExceedsMaxSize");
    assert.equal(refused[0].error!.code, 6006);
    assert.equal(refused[0].instruction, "Rebalance proposed");

    // Nothing moved. A refused transaction pays a fee and changes no state.
    const mandate = await fetchMandate(connection, opened.mandate);
    assert.equal(mandate!.rebalanceCount, 0);
  });

  it("names the instructions that carry no event", async () => {
    const opened = await open();

    const records = await fetchActivity(connection, opened.mandate);
    assert.isNotEmpty(records, "creating a mandate should leave a record");

    const named = records.filter(
      (r): r is Extract<ActivityRecord, { kind: "instruction" }> =>
        r.kind === "instruction",
    );

    assert.isNotEmpty(named, "mandate creation should be recognised");
    assert.equal(named[named.length - 1].instruction, "Mandate created");
  });

  it("returns an empty history for an account that has never existed", async () => {
    const nowhere = chainMandatePda(Keypair.generate().publicKey, new BN(0));
    assert.deepEqual(await fetchActivity(connection, nowhere), []);
  });
});

describe("decoding a refusal reported at confirmation", () => {
  it("reads the program error out of the status error shape", () => {
    // What `getSignatureStatuses` returns for a landed, failed transaction.
    // Without this branch the interface knows a transaction failed but not why,
    // and that branch runs for every refusal recorded on chain.
    const statusError = { InstructionError: [0, { Custom: 6006 }] };
    const decoded = extractProgramError(statusError);

    assert.isNotNull(decoded);
    assert.equal(decoded!.name, "PositionExceedsMaxSize");
    assert.equal(decoded!.code, 6006);
  });

  it("still reads the error out of simulation logs", () => {
    const decoded = extractProgramError({
      logs: [
        "Program 6X7wfnLNHQvW94CHPVFdguraojh5uEN3Y1gjfi2pkxVu invoke [1]",
        "Program log: Instruction: ProposeRebalance",
        "Program 6X7wfnLNHQvW94CHPVFdguraojh5uEN3Y1gjfi2pkxVu failed: custom program error: 0x1779",
      ],
    });

    assert.isNotNull(decoded);
    assert.equal(decoded!.code, 6009);
    assert.equal(decoded!.name, "TurnoverExceeded");
  });

  it("returns null for a failure that is not one of ours", () => {
    assert.isNull(extractProgramError({ InstructionError: [0, "AccountInUse"] }));
    assert.isNull(extractProgramError(new Error("connection reset")));
  });
});
