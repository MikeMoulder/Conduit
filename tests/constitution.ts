/**
 * Integration tests for the CONDUIT constitution, run against the deployed
 * program on devnet.
 *
 * The unit tests in `programs/stockpilot/src/policy.rs` already prove the policy
 * arithmetic. These tests exist to prove something the unit tests cannot: that
 * the enforcement is real on chain. Every rejection below is a transaction that
 * the cluster refuses, not a client side guard that a determined caller could
 * simply skip by talking to the program directly.
 *
 * That distinction is the entire claim of this project, so it is tested as such.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import type { Stockpilot } from "../target/types/stockpilot";
import {
  PROGRAM_ID,
  mandatePda as chainMandatePda,
  portfolioPda as chainPortfolioPda,
} from "../app/src/lib/chain";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

/**
 * The IDL is read from disk rather than imported.
 *
 * A direct `import ... from "*.json"` is resolved by Node as an ES module and
 * now requires an import attribute, which conflicts with the CommonJS output
 * these tests compile to. Reading the file sidesteps the module system entirely.
 *
 * The path resolves from the working directory rather than `__dirname`, because
 * the compiled output lives under `.test-build` and would otherwise look for the
 * IDL in the wrong place.
 */
const idl = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), "target", "idl", "stockpilot.json"),
    "utf8",
  ),
) as Stockpilot;

const program = new Program<Stockpilot>(idl, provider);
const owner = provider.wallet;

/** Basis points helper, so tests read in percent rather than raw integers. */
const pct = (p: number) => p * 100;

/**
 * Devnet accounts persist between runs, so every test derives its own mandate
 * from a unique id. Without this a second run would collide with the first and
 * fail on "account already in use" rather than on anything meaningful.
 */
let nextId = Date.now();
const freshId = () => new BN(nextId++);

/**
 * Address derivation comes from the application client, not a copy.
 *
 * A second implementation of these seeds would be one more place to drift, and a
 * drifted PDA does not fail loudly: it quietly addresses an account that does not
 * exist. Importing the real one means these tests also prove the client the
 * browser uses derives the same addresses the program expects.
 */
function mandatePda(mandateId: BN): PublicKey {
  return chainMandatePda(owner.publicKey, mandateId);
}

const portfolioPda = chainPortfolioPda;

/**
 * A unique mint address for constraint tests.
 *
 * These tests exercise the policy engine, which cares only about mint identity,
 * so a fresh address is sufficient and avoids creating real token accounts for
 * every case. Settlement against registry mints is covered separately.
 */
const asset = () => Keypair.generate().publicKey;

const feed = (): number[] => Array(32).fill(0);

const allow = (mints: PublicKey[]) =>
  mints.map((mint) => ({ mint, feedId: feed() }));

type Constraints = {
  maxPositionBps: number;
  minCashBps: number;
  maxTurnoverBps: number;
  maxAssets: number;
};

const MODERATE: Constraints = {
  maxPositionBps: pct(25),
  minCashBps: pct(15),
  maxTurnoverBps: pct(100),
  maxAssets: 4,
};

/**
 * Asserts a transaction was refused by the program with one specific error.
 *
 * Matching on the exact code matters. A test that only checks "it threw" would
 * still pass if the transaction failed for an unrelated reason, such as a bad
 * account or insufficient funds, which would quietly stop testing the
 * constraint it claims to cover.
 */
async function expectRejection(
  promise: Promise<unknown>,
  codeName: string,
  codeNumber: number,
): Promise<void> {
  let caught: unknown;
  let succeeded = false;

  try {
    await promise;
    succeeded = true;
  } catch (error) {
    caught = error;
  }

  if (succeeded) {
    assert.fail(
      `expected the chain to reject this with ${codeName} (${codeNumber}), but the transaction succeeded`,
    );
  }

  const anchorError = caught as anchor.AnchorError;
  const code = anchorError?.error?.errorCode;

  if (!code) {
    assert.fail(
      `expected AnchorError ${codeName} (${codeNumber}), got: ${String(caught)}`,
    );
  }

  assert.strictEqual(code.code, codeName, "wrong error variant");
  assert.strictEqual(code.number, codeNumber, "wrong error code number");
}

/** Creates a mandate plus its portfolio, returning everything a test needs. */
async function openAccount(
  constraints: Constraints,
  mints: PublicKey[],
): Promise<{ mandate: PublicKey; portfolio: PublicKey; agent: Keypair }> {
  const mandateId = freshId();
  const mandate = mandatePda(mandateId);
  const portfolio = portfolioPda(mandate);
  const agent = Keypair.generate();

  await program.methods
    .initializeMandate(mandateId, constraints, allow(mints), agent.publicKey)
    .accountsPartial({
      mandate,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await program.methods
    .initializePortfolio()
    .accountsPartial({
      mandate,
      portfolio,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { mandate, portfolio, agent };
}

describe("client and program agreement", () => {
  it("bundles an IDL that points at the deployed program", () => {
    // The browser builds transactions from the IDL copied into the app. If that
    // copy goes stale against a redeploy, every instruction would be addressed to
    // the wrong program and fail for reasons that look nothing like the cause.
    assert.strictEqual(
      PROGRAM_ID.toBase58(),
      program.programId.toBase58(),
      "app IDL and test IDL disagree about the program address",
    );
  });

  it("derives portfolio addresses the program accepts", async () => {
    // Proven indirectly by every other test, asserted directly here so a
    // derivation bug names itself instead of surfacing as a missing account.
    const { mandate, portfolio } = await openAccount(MODERATE, [asset()]);
    assert.strictEqual(chainPortfolioPda(mandate).toBase58(), portfolio.toBase58());

    const account = await program.account.portfolio.fetch(portfolio);
    assert.strictEqual(account.mandate.toBase58(), mandate.toBase58());
  });
});

describe("mandate creation", () => {
  it("stores the constitution exactly as the owner wrote it", async () => {
    const mandateId = freshId();
    const mandate = mandatePda(mandateId);
    const mints = [asset(), asset()];
    const agent = Keypair.generate();

    await program.methods
      .initializeMandate(mandateId, MODERATE, allow(mints), agent.publicKey)
      .accountsPartial({
        mandate,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const account = await program.account.mandate.fetch(mandate);

    assert.strictEqual(account.mandateId.toString(), mandateId.toString());
    assert.strictEqual(account.owner.toBase58(), owner.publicKey.toBase58());
    assert.strictEqual(account.agent.toBase58(), agent.publicKey.toBase58());
    assert.strictEqual(account.constraints.maxPositionBps, pct(25));
    assert.strictEqual(account.constraints.minCashBps, pct(15));
    assert.strictEqual(account.allowedAssets.length, 2);
    assert.deepStrictEqual(account.status, { active: {} });
    assert.strictEqual(account.rebalanceCount.toNumber(), 0);
  });

  it("refuses constraints that could never reach a full allocation", async () => {
    // Four positions capped at 10 percent each tops out at 40 percent deployed.
    // The owner almost certainly did not mean to mandate a 60 percent cash
    // portfolio, so the chain refuses rather than silently obeying.
    const mandateId = freshId();

    await expectRejection(
      program.methods
        .initializeMandate(
          mandateId,
          { ...MODERATE, maxPositionBps: pct(10), minCashBps: 0 },
          allow([asset()]),
          Keypair.generate().publicKey,
        )
        .accountsPartial({
          mandate: mandatePda(mandateId),
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "ContradictoryConstraints",
      6011,
    );
  });

  it("refuses a permitted universe containing the same asset twice", async () => {
    const mandateId = freshId();
    const duplicated = asset();

    await expectRejection(
      program.methods
        .initializeMandate(
          mandateId,
          MODERATE,
          allow([duplicated, duplicated]),
          Keypair.generate().publicKey,
        )
        .accountsPartial({
          mandate: mandatePda(mandateId),
          owner: owner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "DuplicateAsset",
      6005,
    );
  });
});

describe("portfolio creation", () => {
  it("opens fully in cash, which no well formed mandate can forbid", async () => {
    const { portfolio, mandate } = await openAccount(MODERATE, [asset()]);
    const account = await program.account.portfolio.fetch(portfolio);

    assert.strictEqual(account.cashBps, pct(100));
    assert.strictEqual(account.positions.length, 0);
    assert.strictEqual(account.mandate.toBase58(), mandate.toBase58());
  });
});

describe("the constitution is enforced on chain", () => {
  it("accepts a compliant rebalance and records the new allocation", async () => {
    const mints = [asset(), asset()];
    const { mandate, portfolio, agent } = await openAccount(MODERATE, mints);

    await program.methods
      .proposeRebalance([
        { mint: mints[0], targetBps: pct(25) },
        { mint: mints[1], targetBps: pct(20) },
      ])
      .accountsPartial({ mandate, portfolio, agent: agent.publicKey })
      .signers([agent])
      .rpc();

    const account = await program.account.portfolio.fetch(portfolio);
    assert.strictEqual(account.positions.length, 2);
    assert.strictEqual(account.cashBps, pct(55));

    const mandateAccount = await program.account.mandate.fetch(mandate);
    assert.strictEqual(mandateAccount.rebalanceCount.toNumber(), 1);
  });

  it("REJECTS a position that breaches the concentration cap", async () => {
    // The demo moment. The agent asks for 40 percent in one name against a
    // mandate capped at 25. The cluster refuses the transaction outright.
    const mints = [asset()];
    const { mandate, portfolio, agent } = await openAccount(MODERATE, mints);

    await expectRejection(
      program.methods
        .proposeRebalance([{ mint: mints[0], targetBps: pct(40) }])
        .accountsPartial({ mandate, portfolio, agent: agent.publicKey })
        .signers([agent])
        .rpc(),
      "PositionExceedsMaxSize",
      6006,
    );

    // The refusal must leave nothing behind. A partially applied rebalance
    // would be worse than one that was never attempted.
    const account = await program.account.portfolio.fetch(portfolio);
    assert.strictEqual(account.cashBps, pct(100));
    assert.strictEqual(account.positions.length, 0);
  });

  it("REJECTS a signer that is not the delegated agent", async () => {
    const mints = [asset()];
    const { mandate, portfolio } = await openAccount(MODERATE, mints);
    const impostor = Keypair.generate();

    await expectRejection(
      program.methods
        .proposeRebalance([{ mint: mints[0], targetBps: pct(10) }])
        .accountsPartial({ mandate, portfolio, agent: impostor.publicKey })
        .signers([impostor])
        .rpc(),
      "UnauthorizedAgent",
      6001,
    );
  });

  it("REJECTS an asset outside the permitted universe", async () => {
    const permitted = asset();
    const { mandate, portfolio, agent } = await openAccount(MODERATE, [permitted]);

    await expectRejection(
      program.methods
        .proposeRebalance([{ mint: asset(), targetBps: pct(10) }])
        .accountsPartial({ mandate, portfolio, agent: agent.publicKey })
        .signers([agent])
        .rpc(),
      "AssetNotAllowed",
      6004,
    );
  });

  it("REJECTS a proposal that eats into the cash floor", async () => {
    const mints = [asset(), asset(), asset(), asset()];
    const { mandate, portfolio, agent } = await openAccount(MODERATE, mints);

    // Four positions at 25 percent each is 100 percent deployed, leaving zero
    // cash against a mandated floor of 15 percent.
    await expectRejection(
      program.methods
        .proposeRebalance(
          mints.map((mint) => ({ mint, targetBps: pct(25) })),
        )
        .accountsPartial({ mandate, portfolio, agent: agent.publicKey })
        .signers([agent])
        .rpc(),
      "InsufficientCashReserve",
      6007,
    );
  });

  it("REJECTS the agent entirely once the owner pauses the mandate", async () => {
    const mints = [asset()];
    const { mandate, portfolio, agent } = await openAccount(MODERATE, mints);

    await program.methods
      .setMandateStatus({ paused: {} })
      .accountsPartial({ mandate, owner: owner.publicKey })
      .rpc();

    await expectRejection(
      program.methods
        .proposeRebalance([{ mint: mints[0], targetBps: pct(10) }])
        .accountsPartial({ mandate, portfolio, agent: agent.publicKey })
        .signers([agent])
        .rpc(),
      "MandateNotActive",
      6000,
    );
  });

  it("REJECTS an attempt by the agent to pause or alter its own mandate", async () => {
    // The agent holds exactly one power. Proving it cannot reach the controls
    // that govern it is the point of separating owner from agent at all.
    const { mandate, agent } = await openAccount(MODERATE, [asset()]);

    await expectRejection(
      program.methods
        .setMandateStatus({ closed: {} })
        .accountsPartial({ mandate, owner: agent.publicKey })
        .signers([agent])
        .rpc(),
      "UnauthorizedOwner",
      6002,
    );
  });
});
