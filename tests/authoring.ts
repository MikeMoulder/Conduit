/**
 * Integration tests for mandate authoring, run against the deployed program on
 * devnet.
 *
 * These cover what `constitution.ts` does not: the exact transaction the
 * interface builds, and whether the client side validation the owner sees while
 * typing tells the truth about what the program will do.
 *
 * The second of those is the interesting one. A form that mirrors on chain rules
 * is a second implementation of them, and a second implementation drifts. So the
 * mirror is not tested against a list of expected strings written by hand. Each
 * case is sent to the real program, and the test asserts that the client and the
 * cluster name the same error. If they ever disagree, this fails.
 */

import * as fs from "fs";
import * as path from "path";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { assert } from "chai";

import type { Stockpilot } from "../target/types/stockpilot";
import {
  extractProgramError,
  mandatePda as chainMandatePda,
  portfolioPda,
} from "../app/src/lib/chain";
import { confirmSignature } from "../app/src/lib/confirm";
import {
  toAllowedAssets,
  validateConstraints,
  validateUniverse,
  type MandateConstraintsInput,
} from "../app/src/lib/mandate";
import { listAssets } from "../app/src/lib/assets";

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

let nextId = Date.now() + 500_000;
const freshId = () => new BN(nextId++);

const SYMBOLS = listAssets().map((a) => a.symbol);

/** The wire limit for a single Solana transaction. */
const PACKET_DATA_SIZE = 1232;

/**
 * Builds the pair of instructions the interface sends, in the order it sends
 * them. Kept in one place so a test cannot accidentally diverge from the shape
 * the browser actually produces.
 */
async function authoringInstructions(
  mandateId: BN,
  constraints: MandateConstraintsInput,
  symbols: string[],
  agent: PublicKey,
) {
  const mandate = chainMandatePda(owner.publicKey, mandateId);
  const portfolio = portfolioPda(mandate);

  const createMandate = await program.methods
    .initializeMandate(
      mandateId,
      {
        maxPositionBps: constraints.maxPositionBps,
        minCashBps: constraints.minCashBps,
        maxTurnoverBps: constraints.maxTurnoverBps,
        maxAssets: constraints.maxAssets,
      },
      toAllowedAssets(symbols),
      agent,
    )
    .accountsStrict({
      mandate,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const createPortfolio = await program.methods
    .initializePortfolio()
    .accountsStrict({
      mandate,
      portfolio,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { mandate, portfolio, createMandate, createPortfolio };
}

describe("authoring, the way the interface does it", () => {
  it("creates the mandate and its portfolio in one signed transaction", async () => {
    const mandateId = freshId();
    const constraints: MandateConstraintsInput = {
      maxPositionBps: 2500,
      minCashBps: 1000,
      maxTurnoverBps: 4000,
      maxAssets: 6,
    };
    const symbols = SYMBOLS.slice(0, 4);
    const agent = anchor.web3.Keypair.generate().publicKey;

    assert.lengthOf(
      validateConstraints(constraints),
      0,
      "the client should consider this mandate well formed",
    );

    const { mandate, portfolio, createMandate, createPortfolio } =
      await authoringInstructions(mandateId, constraints, symbols, agent);

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    const transaction = new Transaction({
      feePayer: owner.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(createMandate, createPortfolio);

    const signed = await owner.signTransaction(transaction);
    const signature = await connection.sendRawTransaction(signed.serialize());

    // Confirmed by polling, which is what the browser has to do: the RPC proxy
    // that keeps the endpoint key server side is HTTP, and a subscription needs
    // a websocket. This exercises the same helper the interface uses.
    const outcome = await confirmSignature(connection, signature, {
      lastValidBlockHeight,
      timeoutMs: 90_000,
    });

    assert.equal(outcome.status, "confirmed", `signature ${signature}`);

    const stored = await program.account.mandate.fetch(mandate);
    assert.equal(stored.owner.toBase58(), owner.publicKey.toBase58());
    assert.equal(stored.agent.toBase58(), agent.toBase58());
    assert.equal(stored.constraints.maxPositionBps, constraints.maxPositionBps);
    assert.equal(stored.constraints.minCashBps, constraints.minCashBps);
    assert.equal(stored.constraints.maxTurnoverBps, constraints.maxTurnoverBps);
    assert.equal(stored.constraints.maxAssets, constraints.maxAssets);
    assert.lengthOf(stored.allowedAssets, symbols.length);

    const openedPortfolio = await program.account.portfolio.fetch(portfolio);
    assert.equal(openedPortfolio.cashBps, 10_000, "opens fully in cash");
    assert.lengthOf(openedPortfolio.positions, 0);
  });

  it("records the registry feed id for each permitted asset", async () => {
    const mandateId = freshId();
    // One Pyth priced asset and one priced by its issuer, so both branches of
    // the feed binding are stored and read back.
    const pythAsset = listAssets().find((a) => a.feeds?.primary);
    const issuerAsset = listAssets().find((a) => !a.feeds?.primary);
    assert.isDefined(pythAsset, "registry should contain a Pyth priced asset");
    assert.isDefined(issuerAsset, "registry should contain an issuer priced asset");

    const symbols = [pythAsset!.symbol, issuerAsset!.symbol];

    const { mandate, createMandate, createPortfolio } =
      await authoringInstructions(
        mandateId,
        {
          maxPositionBps: 5000,
          minCashBps: 0,
          maxTurnoverBps: 10_000,
          maxAssets: 2,
        },
        symbols,
        anchor.web3.Keypair.generate().publicKey,
      );

    await provider.sendAndConfirm(
      new Transaction().add(createMandate, createPortfolio),
    );

    const stored = await program.account.mandate.fetch(mandate);
    const [first, second] = stored.allowedAssets;

    assert.equal(first.mint.toBase58(), pythAsset!.mint);
    assert.equal(
      Buffer.from(first.feedId).toString("hex"),
      pythAsset!.feeds!.primary,
      "the Pyth feed id is stored exactly as the registry records it",
    );

    assert.equal(second.mint.toBase58(), issuerAsset!.mint);
    assert.isTrue(
      second.feedId.every((b: number) => b === 0),
      "an asset Pyth does not publish records zeros rather than an invented id",
    );
  });

  it("fits the largest possible mandate inside one transaction", async () => {
    const mandateId = freshId();
    const symbols = SYMBOLS.slice(0, 8);
    assert.lengthOf(symbols, 8, "the cap is eight assets per mandate");

    const { createMandate, createPortfolio } = await authoringInstructions(
      mandateId,
      {
        maxPositionBps: 2000,
        minCashBps: 0,
        maxTurnoverBps: 10_000,
        maxAssets: 8,
      },
      symbols,
      anchor.web3.Keypair.generate().publicKey,
    );

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: owner.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(createMandate, createPortfolio);

    const size = (await owner.signTransaction(transaction)).serialize().length;

    // Reported, not just asserted. The limit is fixed and the headroom is the
    // number that decides whether a future field fits, so it is worth seeing on
    // every run rather than only when it has already been exceeded.
    console.log(
      `      ${symbols.length} assets serialise to ${size} bytes, ` +
        `${PACKET_DATA_SIZE - size} bytes of headroom`,
    );

    // If this ever fails, the two instructions have to be split across two
    // transactions and the atomicity argument in the form has to be revisited.
    assert.isBelow(
      size,
      PACKET_DATA_SIZE,
      `a full mandate serialises to ${size} bytes, limit ${PACKET_DATA_SIZE}`,
    );
  });
});

/**
 * Each case is rejected by the program, and the client is asked about the same
 * input. The assertion is that they name the same clause.
 */
const MIRROR_CASES: {
  name: string;
  constraints: MandateConstraintsInput;
  symbols: string[];
  expected: string;
}[] = [
  {
    name: "limits that strand part of the portfolio",
    constraints: {
      maxPositionBps: 2000,
      minCashBps: 0,
      maxTurnoverBps: 5000,
      maxAssets: 1,
    },
    symbols: SYMBOLS.slice(0, 2),
    expected: "ContradictoryConstraints",
  },
  {
    name: "a maximum position of zero",
    constraints: {
      maxPositionBps: 0,
      minCashBps: 10_000,
      maxTurnoverBps: 5000,
      maxAssets: 4,
    },
    symbols: SYMBOLS.slice(0, 2),
    expected: "ContradictoryConstraints",
  },
  {
    name: "a basis point value above one hundred percent",
    constraints: {
      maxPositionBps: 20_000,
      minCashBps: 0,
      maxTurnoverBps: 5000,
      maxAssets: 4,
    },
    symbols: SYMBOLS.slice(0, 2),
    expected: "InvalidBasisPoints",
  },
  {
    name: "more simultaneous positions than the program allows",
    constraints: {
      maxPositionBps: 2000,
      minCashBps: 0,
      maxTurnoverBps: 5000,
      maxAssets: 9,
    },
    symbols: SYMBOLS.slice(0, 2),
    expected: "TooManyAssets",
  },
  {
    name: "no simultaneous positions at all",
    constraints: {
      maxPositionBps: 10_000,
      minCashBps: 0,
      maxTurnoverBps: 5000,
      maxAssets: 0,
    },
    symbols: SYMBOLS.slice(0, 2),
    expected: "TooManyAssets",
  },
  {
    name: "the same asset permitted twice",
    constraints: {
      maxPositionBps: 5000,
      minCashBps: 0,
      maxTurnoverBps: 5000,
      maxAssets: 2,
    },
    symbols: [SYMBOLS[0], SYMBOLS[0]],
    expected: "DuplicateAsset",
  },
  {
    name: "an empty permitted universe",
    constraints: {
      maxPositionBps: 5000,
      minCashBps: 0,
      maxTurnoverBps: 5000,
      maxAssets: 2,
    },
    symbols: [],
    expected: "EmptyAssetUniverse",
  },
];

describe("the client mirror agrees with the program", () => {
  for (const testCase of MIRROR_CASES) {
    it(`both refuse ${testCase.name}`, async () => {
      const clientViolations = [
        ...validateConstraints(testCase.constraints),
        ...validateUniverse(testCase.symbols),
      ];

      assert.isNotEmpty(
        clientViolations,
        "the form would have let this through, so the owner pays for a refusal",
      );

      const mandateId = freshId();
      const mandate = chainMandatePda(owner.publicKey, mandateId);

      let programError: ReturnType<typeof extractProgramError> = null;

      try {
        await program.methods
          .initializeMandate(
            mandateId,
            {
              maxPositionBps: testCase.constraints.maxPositionBps,
              minCashBps: testCase.constraints.minCashBps,
              maxTurnoverBps: testCase.constraints.maxTurnoverBps,
              maxAssets: testCase.constraints.maxAssets,
            },
            toAllowedAssets(testCase.symbols),
            anchor.web3.Keypair.generate().publicKey,
          )
          .accountsStrict({
            mandate,
            owner: owner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        assert.fail("the program accepted a mandate it should have refused");
      } catch (error) {
        programError = extractProgramError(error);
      }

      assert.isNotNull(
        programError,
        "the failure carried no recognisable program error",
      );

      assert.equal(
        programError!.name,
        testCase.expected,
        "the program named a different clause than expected",
      );

      assert.include(
        clientViolations.map((v) => v.onChainError),
        programError!.name,
        `the client predicted ${clientViolations
          .map((v) => v.onChainError)
          .join(", ")} but the program returned ${programError!.name}`,
      );
    });
  }
});
