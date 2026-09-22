/**
 * Integration tests for proposing a rebalance, run against the deployed program
 * on devnet.
 *
 * Two things are under test that `constitution.ts` does not cover.
 *
 * The first is account decoding. The interface reads mandates and portfolios
 * without a wallet, through its own helper rather than through Anchor's account
 * client, and a decoder that silently returns the wrong shape is a bad failure:
 * it produces a page of plausible numbers. So the helper is checked field by
 * field against what Anchor's own client returns for the same account.
 *
 * The second is the proposal mirror. The interface predicts what the chain will
 * do before anything is sent, and that prediction has to be right, including
 * which clause fails first. Every case below is sent to the real program and the
 * test asserts the prediction and the cluster name the same error.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

import type { Stockpilot } from "../target/types/stockpilot";
import {
  extractProgramError,
  mandatePda as chainMandatePda,
  portfolioPda,
} from "../app/src/lib/chain";
import {
  fetchMandate,
  fetchPortfolio,
  type PositionView,
} from "../app/src/lib/accounts";
import {
  evaluateProposal,
  turnoverBetween,
  type ProposedPosition,
} from "../app/src/lib/proposal";

const provider = anchor.AnchorProvider.env();
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

let nextId = Date.now() + 900_000;
const freshId = () => new BN(nextId++);

/** A mint address that is unique per test and needs no token program. */
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

/** Five permitted mints against a four position cap, so the two limits differ. */
async function open(): Promise<Opened> {
  const mandateId = freshId();
  const mandate = chainMandatePda(owner.publicKey, mandateId);
  const portfolio = portfolioPda(mandate);
  const agent = Keypair.generate();
  const mints = [mint(), mint(), mint(), mint(), mint()];

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

async function propose(opened: Opened, positions: ProposedPosition[]) {
  return program.methods
    .proposeRebalance(
      positions.map((p) => ({
        mint: new PublicKey(p.mint),
        targetBps: p.targetBps,
      })),
    )
    .accountsStrict({
      mandate: opened.mandate,
      portfolio: opened.portfolio,
      agent: opened.agent.publicKey,
    })
    .signers([opened.agent])
    .rpc();
}

describe("reading accounts without a wallet", () => {
  it("decodes a mandate identically to the Anchor account client", async () => {
    const opened = await open();

    const viaAnchor = await program.account.mandate.fetch(opened.mandate);
    const viaHelper = await fetchMandate(connection, opened.mandate);

    assert.isNotNull(viaHelper, "the helper found no account");

    // Named individually rather than compared as objects, because the failure
    // this guards against is a decoder returning undefined for a field whose
    // name it did not recognise, and a loose comparison would pass that.
    assert.equal(viaHelper!.owner, viaAnchor.owner.toBase58());
    assert.equal(viaHelper!.agent, viaAnchor.agent.toBase58());
    assert.equal(viaHelper!.status, "active");
    assert.equal(
      viaHelper!.constraints.maxPositionBps,
      viaAnchor.constraints.maxPositionBps,
    );
    assert.equal(
      viaHelper!.constraints.minCashBps,
      viaAnchor.constraints.minCashBps,
    );
    assert.equal(
      viaHelper!.constraints.maxTurnoverBps,
      viaAnchor.constraints.maxTurnoverBps,
    );
    assert.equal(
      viaHelper!.constraints.maxAssets,
      viaAnchor.constraints.maxAssets,
    );
    assert.lengthOf(viaHelper!.allowedAssets, viaAnchor.allowedAssets.length);
    assert.equal(
      viaHelper!.allowedAssets[0].mint,
      viaAnchor.allowedAssets[0].mint.toBase58(),
    );
    assert.equal(viaHelper!.rebalanceCount, 0);
    assert.isAbove(viaHelper!.createdAt, 0, "createdAt decoded as a timestamp");
    assert.equal(viaHelper!.mandateId, viaAnchor.mandateId.toString());
  });

  it("decodes a portfolio identically to the Anchor account client", async () => {
    const opened = await open();

    const viaAnchor = await program.account.portfolio.fetch(opened.portfolio);
    const viaHelper = await fetchPortfolio(connection, opened.portfolio);

    assert.isNotNull(viaHelper);
    assert.equal(viaHelper!.mandate, viaAnchor.mandate.toBase58());
    assert.equal(viaHelper!.owner, viaAnchor.owner.toBase58());
    assert.equal(viaHelper!.cashBps, viaAnchor.cashBps);
    assert.equal(viaHelper!.cashBps, 10_000, "opens fully in cash");
    assert.lengthOf(viaHelper!.positions, 0);
    assert.isAbove(viaHelper!.createdAt, 0);
  });

  it("returns null rather than throwing for an account that does not exist", async () => {
    const nowhere = chainMandatePda(Keypair.generate().publicKey, new BN(0));
    assert.isNull(await fetchMandate(connection, nowhere));
  });
});

describe("a compliant rebalance", () => {
  it("is predicted compliant, accepted, and stored as proposed", async () => {
    const opened = await open();

    // From all cash, turnover equals the amount deployed, so the limit on the
    // first move is the turnover cap rather than the cash floor.
    const positions: ProposedPosition[] = [
      { mint: opened.mints[0].toBase58(), targetBps: 2000 },
      { mint: opened.mints[1].toBase58(), targetBps: 1500 },
      { mint: opened.mints[2].toBase58(), targetBps: 500 },
    ];

    const evaluation = evaluateProposal({
      constraints: CONSTRAINTS,
      allowedMints: opened.mints.map((m) => m.toBase58()),
      current: [],
      proposed: positions,
    });

    assert.isTrue(
      evaluation.compliant,
      `predicted a refusal: ${evaluation.violations.map((v) => v.detail).join("; ")}`,
    );
    assert.equal(evaluation.turnoverBps, 4000, "deploying 4000 costs 4000");
    assert.equal(evaluation.cashBps, 6000);

    await propose(opened, positions);

    const portfolio = await fetchPortfolio(connection, opened.portfolio);
    assert.isNotNull(portfolio);
    assert.equal(portfolio!.cashBps, evaluation.cashBps);
    assert.lengthOf(portfolio!.positions, 3);

    for (const position of positions) {
      // Annotated because chai's asserting signature would otherwise make the
      // inferred type depend on the assertion made about it.
      const stored: PositionView | undefined = portfolio!.positions.find(
        (p) => p.mint === position.mint,
      );
      assert.isDefined(stored, `${position.mint} was not stored`);
      assert.equal(stored!.targetBps, position.targetBps);
    }

    const mandate = await fetchMandate(connection, opened.mandate);
    assert.equal(mandate!.rebalanceCount, 1);
  });

  it("measures turnover against what is already held, not against cash", async () => {
    const opened = await open();

    const first: ProposedPosition[] = [
      { mint: opened.mints[0].toBase58(), targetBps: 2000 },
      { mint: opened.mints[1].toBase58(), targetBps: 2000 },
    ];
    await propose(opened, first);

    // Trimming one holding and opening another of the same size is a small
    // move, even though the book it produces is large. A turnover limit is
    // about churn, not about size.
    const second: ProposedPosition[] = [
      { mint: opened.mints[0].toBase58(), targetBps: 2000 },
      { mint: opened.mints[1].toBase58(), targetBps: 1500 },
      { mint: opened.mints[2].toBase58(), targetBps: 500 },
    ];

    const current = (await fetchPortfolio(connection, opened.portfolio))!
      .positions;

    const evaluation = evaluateProposal({
      constraints: CONSTRAINTS,
      allowedMints: opened.mints.map((m) => m.toBase58()),
      current,
      proposed: second,
    });

    assert.equal(evaluation.turnoverBps, 500, "only 500 bps actually moves");
    assert.isTrue(evaluation.compliant);

    await propose(opened, second);

    const portfolio = await fetchPortfolio(connection, opened.portfolio);
    assert.lengthOf(portfolio!.positions, 3);
  });

  it("agrees with the program on turnover arithmetic", () => {
    // Exercised directly because turnover is the one clause with real
    // arithmetic behind it, and the halving and the exit leg are both easy to
    // drop without any test noticing.
    const current = [
      { id: "a", targetBps: 3000 },
      { id: "b", targetBps: 2000 },
    ];

    assert.equal(
      turnoverBetween(current, current, 5000),
      0,
      "proposing the current book moves nothing",
    );

    assert.equal(
      turnoverBetween(current, [{ id: "a", targetBps: 3000 }], 7000),
      2000,
      "closing b entirely is 2000 bps of turnover, not zero",
    );

    assert.equal(
      turnoverBetween([], [{ id: "a", targetBps: 4000 }], 6000),
      4000,
      "deploying from cash costs what it deploys",
    );
  });
});

const REFUSALS: {
  name: string;
  positions: (m: PublicKey[]) => ProposedPosition[];
  expected: string;
}[] = [
  {
    name: "a position above the concentration cap",
    positions: (m) => [{ mint: m[0].toBase58(), targetBps: 9000 }],
    expected: "PositionExceedsMaxSize",
  },
  {
    name: "a position with a zero weight",
    positions: (m) => [{ mint: m[0].toBase58(), targetBps: 0 }],
    expected: "InvalidBasisPoints",
  },
  {
    name: "an asset outside the permitted universe",
    positions: () => [{ mint: mint().toBase58(), targetBps: 1000 }],
    expected: "AssetNotAllowed",
  },
  {
    name: "the same asset twice",
    positions: (m) => [
      { mint: m[0].toBase58(), targetBps: 1000 },
      { mint: m[0].toBase58(), targetBps: 1000 },
    ],
    expected: "DuplicateAsset",
  },
  {
    name: "more positions than the mandate allows",
    positions: (m) => m.map((x) => ({ mint: x.toBase58(), targetBps: 500 })),
    expected: "TooManyAssets",
  },
  {
    name: "an allocation that eats into the cash floor",
    positions: (m) =>
      m.slice(0, 4).map((x) => ({ mint: x.toBase58(), targetBps: 2400 })),
    expected: "InsufficientCashReserve",
  },
  {
    name: "deploying more in one move than the turnover limit allows",
    positions: (m) =>
      m.slice(0, 4).map((x) => ({ mint: x.toBase58(), targetBps: 2000 })),
    expected: "TurnoverExceeded",
  },
];

describe("the proposal mirror agrees with the program", () => {
  for (const testCase of REFUSALS) {
    it(`both refuse ${testCase.name}`, async () => {
      const opened = await open();
      const positions = testCase.positions(opened.mints);

      const evaluation = evaluateProposal({
        constraints: CONSTRAINTS,
        allowedMints: opened.mints.map((m) => m.toBase58()),
        current: [],
        proposed: positions,
      });

      assert.isFalse(
        evaluation.compliant,
        "the interface would have called this compliant",
      );

      let programError: ReturnType<typeof extractProgramError> = null;
      try {
        await propose(opened, positions);
        assert.fail("the program accepted a proposal it should have refused");
      } catch (error) {
        programError = extractProgramError(error);
      }

      assert.isNotNull(programError, "no recognisable program error came back");

      assert.equal(
        programError!.name,
        testCase.expected,
        "the program named a different clause than expected",
      );

      // The point of the test. Reporting every violation is useful, but the
      // interface also claims to know which one the chain reaches first, and
      // that claim is what gets checked here.
      assert.equal(
        evaluation.firstRefusal,
        programError!.name,
        `the interface predicted ${evaluation.firstRefusal}, the chain returned ${programError!.name}`,
      );
    });
  }
});
