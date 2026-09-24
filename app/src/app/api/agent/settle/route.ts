import { Program } from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate } from "@/lib/accounts";
import { getAgentIdentity, getAgentKeypair } from "@/lib/agent-identity";
import { extractProgramError, portfolioPda } from "@/lib/chain";
import { confirmSignature } from "@/lib/confirm";
import {
  associatedTokenAddress,
  desk,
  fetchHoldings,
  isSettleable,
  settleableAsset,
} from "@/lib/holdings";
import idl from "@/lib/idl/conduit.json";
import type { Conduit } from "@/lib/idl/conduit";
import { getConnection } from "@/lib/rpc";

/**
 * Executes a settlement, signed by the agent.
 *
 * This is where a target becomes a holding. Everything before it is policy: the
 * program accepted an allocation and will enforce it, but no token had moved and
 * the portfolio owned nothing.
 *
 * The agent signs, and chooses nothing by signing. Every quantity is derived
 * inside the program from targets it already accepted and prices it reads from
 * accounts this route does not supply the contents of. The same authority to
 * execute an approved allocation, carried to the point where it becomes real.
 *
 * Preflight stays on here, unlike the rebalance route. A refused rebalance is
 * evidence worth paying for, because the refusal is the thing being
 * demonstrated. A failed settlement is just a failed settlement.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const requestSchema = z.object({
  mandate: z.string().min(32).max(44),
});

const program = new Program<Conduit>(idl as Conduit, {
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
    return Response.json({ error: "invalid request" }, { status: 400 });
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
  try {
    mandateAddress = new PublicKey(parsed.data.mandate);
  } catch {
    return Response.json({ error: "mandate is not a valid address" }, { status: 400 });
  }

  const connection = getConnection();
  const portfolioAddress = portfolioPda(mandateAddress);
  const mandate = await fetchMandate(connection, mandateAddress);

  if (!mandate) {
    return Response.json({ error: "no mandate at that address" }, { status: 404 });
  }

  if (mandate.agent !== keypair.publicKey.toBase58()) {
    return Response.json(
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

    return Response.json(
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

  // Refused here with a reason rather than sent and left to fail. A fresh
  // portfolio has no token accounts at all, and the program's account checks
  // reject that with a simulation dump that says nothing useful to a person.
  const accountsOpen =
    Boolean(before.cash?.exists) && before.assets.every((a) => a.exists);

  if (!accountsOpen || !before.funded) {
    return Response.json(
      {
        settled: false,
        error: "this portfolio has nothing to settle with yet",
        detail:
          "It has no cash, or the token accounts settlement needs are not open. On devnet, add demo cash first; that opens the accounts too.",
      },
      { status: 409 },
    );
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

    const transaction = new Transaction({
      feePayer: keypair.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }).add(
      await program.methods
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
        .instruction(),
    );

    transaction.sign(keypair);
    signature = await connection.sendRawTransaction(transaction.serialize());
  } catch (error) {
    const programError = extractProgramError(error);
    return Response.json({
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
    return Response.json({
      settled: false,
      stage: "confirm",
      signature,
      outcome: outcome.status,
      programError:
        outcome.status === "failed" ? extractProgramError(outcome.error) : null,
    });
  }

  const after = await fetchHoldings(connection, portfolioAddress, mandate);

  return Response.json({
    settled: true,
    signature,
    slot: outcome.slot,
    before,
    after,
  });
}
