import { Program } from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate, fetchPortfolio } from "@/lib/accounts";
import { getAgentKeypair, getAgentIdentity } from "@/lib/agent-identity";
import { extractProgramError, portfolioPda } from "@/lib/chain";
import { confirmSignature } from "@/lib/confirm";
import idl from "@/lib/idl/stockpilot.json";
import type { Stockpilot } from "@/lib/idl/stockpilot";
import { evaluateProposal } from "@/lib/proposal";
import { getConnection } from "@/lib/rpc";

/**
 * Submits a rebalance, signed by the agent.
 *
 * This is the only instruction the agent can reach, and it is the only place in
 * the system where the agent key signs anything. The owner does not sign here.
 * That asymmetry is the architecture: authority over the mandate stays with the
 * owner, and the agent holds one narrow power.
 *
 * What this route deliberately does NOT do
 * ----------------------------------------
 * It does not refuse a proposal that breaks the mandate. It evaluates it, says
 * so in the response, and sends it anyway.
 *
 * That is not laziness. A client side guard that quietly blocks bad proposals
 * would make the demo prove the wrong thing: it would show a careful interface,
 * not an enforced mandate. The claim of this project is that the chain refuses,
 * so the chain is what refuses. The evaluation is reported alongside the result
 * precisely so the two can be compared, and a disagreement between them is a
 * bug worth seeing rather than a case worth hiding.
 *
 * On this being an open endpoint
 * ------------------------------
 * Anyone who can reach this can ask the agent to propose. On devnet that is
 * acceptable, and it is worth being clear about why it is not catastrophic in
 * principle: the worst such a caller achieves is a reallocation the mandate
 * already permits, paid for in the agent's own lamports. They cannot widen the
 * universe, raise a limit, change the agent or withdraw, because the agent
 * itself cannot do those things. The blast radius of a compromised agent is
 * exactly the mandate, which is the property the whole design is for.
 *
 * Before mainnet this should still require the owner to authorise a proposal.
 * Recorded as an open item rather than left implied.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z.object({
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
const program = new Program<Stockpilot>(idl as Stockpilot, {
  connection: getConnection(),
});

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
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
    return Response.json(
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
    return Response.json(
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
    return Response.json(
      { error: "no mandate at that address" },
      { status: 404 },
    );
  }

  if (!portfolio) {
    return Response.json(
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
    return Response.json(
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
    return Response.json({
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
    return Response.json({
      accepted: true,
      signature,
      slot: outcome.slot,
      evaluation,
      portfolio: updated,
    });
  }

  return Response.json({
    accepted: false,
    stage: "confirm",
    signature,
    evaluation,
    outcome: outcome.status,
    programError:
      outcome.status === "failed" ? extractProgramError(outcome.error) : null,
  });
}
