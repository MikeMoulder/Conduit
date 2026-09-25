import "server-only";

import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
} from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate, fetchPortfolio } from "@/lib/accounts";
import { getAgentIdentity, getAgentKeypair } from "@/lib/agent-identity";
import { extractProgramError, portfolioPda } from "@/lib/chain";
import { confirmSignature } from "@/lib/confirm";
import { getFaucetKeypair, openTokenAccounts } from "@/lib/faucet";
import {
  associatedTokenAddress,
  desk,
  fetchHoldings,
  isSettleable,
  settleableAsset,
} from "@/lib/holdings";
import idl from "@/lib/idl/conduit.json";
import type { Conduit } from "@/lib/idl/conduit";
import { evaluateProposal } from "@/lib/proposal";
import { getConnection } from "@/lib/rpc";

/**
 * The agent's two chain actions for a mandate, callable without a request.
 *
 * Lifted out of the rebalance and settle routes verbatim so the autopilot can
 * run them on a schedule, with no browser and no HTTP round trip to itself.
 * The routes are now wrappers around these. Nothing about the logic changed:
 * the only edit to the moved code is that it returns a status and a body
 * rather than a Response.
 */

let lookupCache: { address: string; account: AddressLookupTableAccount } | null = null;

/**
 * The desk's address lookup table, or null to send a legacy transaction.
 *
 * Cached for the life of the process: the table only changes when the desk is
 * rebuilt, and that rewrites the config the address comes from.
 */
async function deskLookupTable(connection: Connection): Promise<AddressLookupTableAccount | null> {
  if (!desk.lookupTable) return null;
  if (lookupCache?.address === desk.lookupTable) return lookupCache.account;
  const { value } = await connection.getAddressLookupTable(new PublicKey(desk.lookupTable));
  if (!value) return null;
  lookupCache = { address: desk.lookupTable, account: value };
  return value;
}

export interface ExecutionResult {
  status: number;
  body: Record<string, unknown>;
}

function result(
  body: Record<string, unknown>,
  init?: { status?: number },
): ExecutionResult {
  return { status: init?.status ?? 200, body };
}

const rebalanceSchema = z.object({
  mandate: z.string().min(32).max(44),
  positions: z
    .array(
      z.object({
        mint: z.string().min(32).max(44),
        targetBps: z.number().int().min(0).max(10_000),
      }),
    )
    .min(1)
    .max(8),
});

/**
 * A program client with a connection and no wallet.
 *
 * It exists to encode one instruction. Anchor will accept a full
 * `AnchorProvider` here, but the wallet it would be handed is the agent
 * keypair, and that would leave an object capable of signing sitting behind a
 * general purpose client for the sake of building a byte array. With only a
 * connection there is nothing here that can sign, and signing stays the single
 * explicit step further down.
 *
 * Encoding the instruction by hand was the first attempt and it was wrong in a
 * way worth recording. `BorshInstructionCoder` built from the JSON IDL wants
 * snake_case field names, and given `targetBps` instead of `target_bps` it does
 * not complain: it writes zero. Every weight would have gone to the chain as 0
 * bps and been refused as InvalidBasisPoints, which is a confusing symptom for
 * a naming mistake. The builder below accepts the camelCase names used
 * everywhere else and produces byte identical output, which an integration test
 * asserts.
 */
const program = new Program<Conduit>(idl as Conduit, {
  connection: getConnection(),
});

export async function executeRebalance(body: unknown): Promise<ExecutionResult> {
  const parsed = rebalanceSchema.safeParse(body);
  if (!parsed.success) {
    return result(
      {
        error: "invalid request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join(".") || "(root)",
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const keypair = getAgentKeypair();
  if (!keypair) {
    const identity = getAgentIdentity();
    return result(
      {
        error: "no agent key configured",
        detail: identity.configured ? "unknown" : identity.reason,
      },
      { status: 409 },
    );
  }

  let mandateAddress: PublicKey;
  let positions: { mint: PublicKey; targetBps: number }[];
  try {
    mandateAddress = new PublicKey(parsed.data.mandate);
    positions = parsed.data.positions.map((p) => ({
      mint: new PublicKey(p.mint),
      targetBps: p.targetBps,
    }));
  } catch {
    return result(
      { error: "mandate or mint is not a valid address" },
      { status: 400 },
    );
  }

  const connection = getConnection();
  const portfolioAddress = portfolioPda(mandateAddress);

  const [mandate, portfolio] = await Promise.all([
    fetchMandate(connection, mandateAddress),
    fetchPortfolio(connection, portfolioAddress),
  ]);

  if (!mandate) {
    return result(
      { error: "no mandate at that address" },
      { status: 404 },
    );
  }

  if (!portfolio) {
    return result(
      {
        error: "the mandate has no portfolio",
        detail: "a mandate governs a portfolio, and this one has none to move",
      },
      { status: 404 },
    );
  }

  // Checked here because the answer is certain and specific. Sending would burn
  // a fee to be told UnauthorizedAgent, and the useful message is not that the
  // transaction failed but that this deployment holds a different key than the
  // one the mandate named.
  if (mandate.agent !== keypair.publicKey.toBase58()) {
    return result(
      {
        error: "this mandate delegates to a different agent",
        detail: `the mandate names ${mandate.agent}, this server holds ${keypair.publicKey.toBase58()}`,
        onChainError: "UnauthorizedAgent",
      },
      { status: 403 },
    );
  }

  const evaluation = evaluateProposal({
    constraints: mandate.constraints,
    allowedMints: mandate.allowedAssets.map((a) => a.mint),
    current: portfolio.positions,
    proposed: parsed.data.positions,
  });

  let signature: string;
  let lastValidBlockHeight: number;

  try {
    const latest = await connection.getLatestBlockhash("confirmed");
    lastValidBlockHeight = latest.lastValidBlockHeight;

    const transaction = new Transaction({
      feePayer: keypair.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(
      await program.methods
        .proposeRebalance(positions)
        .accountsStrict({
          mandate: mandateAddress,
          portfolio: portfolioAddress,
          agent: keypair.publicKey,
        })
        .instruction(),
    );

    transaction.sign(keypair);

    /**
     * Preflight is skipped exactly when a refusal is expected.
     *
     * Simulation is the cheap path and stays on for anything that looks
     * compliant: if the chain disagrees with us there, it costs nothing to find
     * out. But a transaction stopped at preflight never reaches the ledger, so
     * it leaves no trace, and a refusal with no trace is the one piece of
     * evidence this project most wants to be able to point at.
     *
     * When the caller has been told the mandate will refuse this and submits it
     * anyway, the refusal is worth a fee. It lands, it fails, and it stays in
     * the account history for anyone to look up. That is the difference between
     * claiming the chain enforces a mandate and being able to show where it
     * did.
     */
    signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: !evaluation.compliant,
    });
  } catch (error) {
    const programError = extractProgramError(error);
    return result({
      accepted: false,
      stage: "send",
      evaluation,
      programError,
      detail: programError
        ? programError.message
        : error instanceof Error
          ? error.message
          : String(error),
    });
  }

  const outcome = await confirmSignature(connection, signature, {
    lastValidBlockHeight,
    timeoutMs: 90_000,
  });

  if (outcome.status === "confirmed") {
    const updated = await fetchPortfolio(connection, portfolioAddress);
    return result({
      accepted: true,
      signature,
      slot: outcome.slot,
      evaluation,
      portfolio: updated,
    });
  }

  return result({
    accepted: false,
    stage: "confirm",
    signature,
    evaluation,
    outcome: outcome.status,
    programError:
      outcome.status === "failed" ? extractProgramError(outcome.error) : null,
  });
}

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const settleSchema = z.object({
  mandate: z.string().min(32).max(44),
});

export async function executeSettle(body: unknown): Promise<ExecutionResult> {
  const parsed = settleSchema.safeParse(body);
  if (!parsed.success) {
    return result({ error: "invalid request" }, { status: 400 });
  }

  const keypair = getAgentKeypair();
  if (!keypair) {
    const identity = getAgentIdentity();
    return result(
      {
        error: "no agent key configured",
        detail: identity.configured ? "unknown" : identity.reason,
      },
      { status: 409 },
    );
  }

  let mandateAddress: PublicKey;
  try {
    mandateAddress = new PublicKey(parsed.data.mandate);
  } catch {
    return result({ error: "mandate is not a valid address" }, { status: 400 });
  }

  const connection = getConnection();
  const portfolioAddress = portfolioPda(mandateAddress);
  const mandate = await fetchMandate(connection, mandateAddress);

  if (!mandate) {
    return result({ error: "no mandate at that address" }, { status: 404 });
  }

  if (mandate.agent !== keypair.publicKey.toBase58()) {
    return result(
      {
        error: "this mandate delegates to a different agent",
        onChainError: "UnauthorizedAgent",
      },
      { status: 403 },
    );
  }

  if (!isSettleable(mandate)) {
    // Said plainly rather than attempted and failed. A mandate permitting an
    // asset with no on chain price is policy only, and that is a property of
    // the mandate rather than a fault.
    const unpriceable = mandate.allowedAssets
      .filter((a) => !settleableAsset(a.mint))
      .map((a) => a.mint);

    return result(
      {
        error: "this mandate cannot be settled on chain",
        detail:
          "settlement needs a price the program can read on chain, and at least one asset this mandate permits has none",
        unpriceable,
        onChainError: "MandateNotSettleable",
      },
      { status: 422 },
    );
  }

  const before = await fetchHoldings(connection, portfolioAddress, mandate);

  // Nothing to settle with is a reason to stop. Missing token accounts are not:
  // a portfolio funded by a direct deposit has its cash account and nothing
  // else, and settle needs one per permitted asset. They are opened here, paid
  // by the faucet, rather than handing the person a refusal about housekeeping.
  if (!before.funded) {
    return result(
      {
        settled: false,
        error: "this portfolio has nothing to settle with yet",
        detail: "It holds no cash. Move money in from the main wallet, or deposit directly.",
      },
      { status: 409 },
    );
  }

  const accountsOpen =
    Boolean(before.cash?.exists) && before.assets.every((a) => a.exists);

  if (!accountsOpen) {
    const faucet = getFaucetKeypair();
    if (!faucet) {
      return result(
        { settled: false, error: "token accounts are missing and no faucet is configured to open them" },
        { status: 409 },
      );
    }
    const latest = await connection.getLatestBlockhash("confirmed");
    const opening = new Transaction({
      feePayer: faucet.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(
      ...openTokenAccounts(faucet.publicKey, portfolioAddress, [
        new PublicKey(desk.cashMint),
        ...mandate.allowedAssets.map((a) => new PublicKey(a.mint)),
      ]),
    );
    opening.sign(faucet);
    const openSig = await connection.sendRawTransaction(opening.serialize());
    await confirmSignature(connection, openSig, {
      lastValidBlockHeight: latest.lastValidBlockHeight,
      timeoutMs: 60_000,
    });
  }

  /**
   * Four accounts per asset, in the order the mandate permits them. The program
   * pairs them positionally with `allowed_assets`, so the order is not a
   * convenience, it is what makes each feed id check line up with the right
   * instrument.
   */
  const remaining = mandate.allowedAssets.flatMap((allowed) => {
    const asset = settleableAsset(allowed.mint)!;
    const mint = new PublicKey(allowed.mint);
    return [
      { pubkey: new PublicKey(asset.priceAccount), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      {
        pubkey: associatedTokenAddress(portfolioAddress, mint),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: new PublicKey(asset.deskTokenAccount),
        isSigner: false,
        isWritable: true,
      },
    ];
  });

  let signature: string;
  let lastValidBlockHeight: number;

  try {
    const latest = await connection.getLatestBlockhash("confirmed");
    lastValidBlockHeight = latest.lastValidBlockHeight;

    const instruction = await program.methods
      .settle()
      .accountsStrict({
        mandate: mandateAddress,
        portfolio: portfolioAddress,
        desk: new PublicKey(desk.desk),
        agent: keypair.publicKey,
        cashMint: new PublicKey(desk.cashMint),
        portfolioCash: associatedTokenAddress(
          portfolioAddress,
          new PublicKey(desk.cashMint),
        ),
        deskCash: new PublicKey(desk.deskCash),
        tokenProgram: TOKEN_PROGRAM,
      })
      .remainingAccounts(remaining)
      .instruction();

    // Four accounts per asset outgrow a legacy transaction at about six
    // assets. With the desk's lookup table the shared accounts cost a byte
    // each, and the program receives exactly the same accounts either way.
    const table = await deskLookupTable(connection);
    let raw: Uint8Array;
    if (table) {
      const versioned = new VersionedTransaction(
        new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: latest.blockhash,
          instructions: [instruction],
        }).compileToV0Message([table]),
      );
      versioned.sign([keypair]);
      raw = versioned.serialize();
    } else {
      const transaction = new Transaction({
        feePayer: keypair.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }).add(instruction);
      transaction.sign(keypair);
      raw = transaction.serialize();
    }

    signature = await connection.sendRawTransaction(raw);
  } catch (error) {
    const programError = extractProgramError(error);
    return result({
      settled: false,
      stage: "send",
      programError,
      detail:
        programError?.message ??
        (error instanceof Error ? error.message : String(error)),
    });
  }

  const outcome = await confirmSignature(connection, signature, {
    lastValidBlockHeight,
    timeoutMs: 90_000,
  });

  if (outcome.status !== "confirmed") {
    return result({
      settled: false,
      stage: "confirm",
      signature,
      outcome: outcome.status,
      programError:
        outcome.status === "failed" ? extractProgramError(outcome.error) : null,
    });
  }

  const after = await fetchHoldings(connection, portfolioAddress, mandate);

  return result({
    settled: true,
    signature,
    slot: outcome.slot,
    before,
    after,
  });
}
