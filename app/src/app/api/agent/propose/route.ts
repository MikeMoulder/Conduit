import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate, fetchPortfolio } from "@/lib/accounts";
import { getAssetByMint, getAssetBySymbol } from "@/lib/assets";
import { portfolioPda } from "@/lib/chain";
import { getConnection } from "@/lib/rpc";
import { runPipeline, type MandateSpec } from "@/lib/agents/pipeline";
import { GeminiError } from "@/lib/gemini";
import { pricedSymbols, snapshotMarket } from "@/lib/market";
import { evaluateProposal } from "@/lib/proposal";

/**
 * Runs the agent pipeline and returns a proposed allocation.
 *
 * This endpoint decides nothing on its own. It returns a proposal together with
 * a compliance report saying whether the chain would accept it. Signing and
 * submitting is a separate, deliberate act by the owner, and the program
 * re-derives every constraint again at that point.
 *
 * Nothing here can move funds. The worst a bad response can do is propose
 * something the chain refuses.
 */

export const dynamic = "force-dynamic";

/**
 * Long enough for five sequential model calls on a rate limited free key, where
 * the client may also be walking its model ladder after a 503.
 */
export const maxDuration = 300;

const bps = z.number().int().min(0).max(10_000);

/**
 * The real path. Limits and the permitted universe are read from the mandate
 * account, not accepted from the caller, so the agent reasons about the mandate
 * that exists rather than one described to it. Only the objective is supplied,
 * because prose is not stored on chain.
 */
const fromChainSchema = z.object({
  mandate: z.string().min(32).max(44),
  objective: z.string().min(1).max(2000),
});

/**
 * Limits supplied directly, for exercising the pipeline before any mandate
 * exists. Nothing submitted through this path can reach the chain: proposing
 * and submitting are separate routes, and the submitting one reads the mandate
 * itself.
 */
const explicitSchema = z.object({
  objective: z.string().min(1).max(2000),
  maxPositionBps: bps,
  minCashBps: bps,
  maxTurnoverBps: bps,
  maxAssets: z.number().int().min(1).max(8),
  /** Omitted means every registry asset that currently has a price. */
  allowedSymbols: z.array(z.string().min(1).max(16)).min(1).max(8).optional(),
});

interface ResolvedRequest {
  objective: string;
  maxPositionBps: number;
  minCashBps: number;
  maxTurnoverBps: number;
  maxAssets: number;
  allowedSymbols?: string[];
  currentPositions?: { symbol: string; targetBps: number }[];
  /** Present only on the from chain path. */
  chain?: {
    mandate: string;
    portfolio: string;
    status: string;
    allowedMints: string[];
    current: { mint: string; targetBps: number }[];
    /** Permitted mints with no registry entry, so the gap is stated. */
    unmapped: string[];
  };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const fromChain = fromChainSchema.safeParse(body);
  let input: ResolvedRequest;

  if (fromChain.success) {
    let mandateAddress: PublicKey;
    try {
      mandateAddress = new PublicKey(fromChain.data.mandate);
    } catch {
      return Response.json(
        { error: "mandate is not a valid address" },
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

    // A permitted mint the registry does not know cannot be reasoned about,
    // because there is no symbol, name or price for it. Reported rather than
    // dropped in silence, since the owner permitted it on purpose.
    const symbols: string[] = [];
    const unmapped: string[] = [];
    for (const asset of mandate.allowedAssets) {
      const known = getAssetByMint(asset.mint);
      if (known) symbols.push(known.symbol);
      else unmapped.push(asset.mint);
    }

    if (symbols.length === 0) {
      return Response.json(
        {
          error: "no permitted asset is in the registry",
          detail:
            "the mandate permits mints this deployment cannot price or name",
          unmapped,
        },
        { status: 422 },
      );
    }

    input = {
      objective: fromChain.data.objective,
      maxPositionBps: mandate.constraints.maxPositionBps,
      minCashBps: mandate.constraints.minCashBps,
      maxTurnoverBps: mandate.constraints.maxTurnoverBps,
      maxAssets: mandate.constraints.maxAssets,
      allowedSymbols: symbols,
      currentPositions: (portfolio?.positions ?? []).flatMap((p) => {
        const known = getAssetByMint(p.mint);
        return known ? [{ symbol: known.symbol, targetBps: p.targetBps }] : [];
      }),
      chain: {
        mandate: mandate.address,
        portfolio: portfolioAddress.toBase58(),
        status: mandate.status,
        allowedMints: mandate.allowedAssets.map((a) => a.mint),
        current: portfolio?.positions ?? [],
        unmapped,
      },
    };
  } else {
    const explicit = explicitSchema.safeParse(body);
    if (!explicit.success) {
      return Response.json(
        {
          error: "invalid request",
          detail:
            "supply either a mandate address with an objective, or an objective with explicit limits",
          issues: explicit.error.issues.map((i) => ({
            path: i.path.join(".") || "(root)",
            message: i.message,
          })),
        },
        { status: 400 },
      );
    }
    input = explicit.data;
  }

  if (input.allowedSymbols) {
    const unknown = input.allowedSymbols.filter((s) => !getAssetBySymbol(s));
    if (unknown.length > 0) {
      return Response.json(
        { error: "unknown symbols", unknown },
        { status: 400 },
      );
    }
  }

  const snapshot = await snapshotMarket(input.allowedSymbols);

  // An asset with no price cannot be reasoned about, and offering it to the
  // model invites an allocation justified by nothing. Drop it here and say so,
  // rather than letting the model quietly guess.
  const tradable = snapshot.filter((s) => s.price !== null);
  const excluded = snapshot
    .filter((s) => s.price === null)
    .map((s) => s.symbol);

  if (tradable.length === 0) {
    return Response.json(
      {
        error: "no priced assets available",
        detail:
          "every candidate is missing a price, so no allocation can be justified",
        excluded,
      },
      { status: 503 },
    );
  }

  const mandate: MandateSpec = {
    objective: input.objective,
    maxPositionBps: input.maxPositionBps,
    minCashBps: input.minCashBps,
    maxTurnoverBps: input.maxTurnoverBps,
    maxAssets: Math.min(input.maxAssets, tradable.length),
    allowedSymbols: pricedSymbols(tradable),
    currentPositions: input.currentPositions,
  };

  try {
    const result = await runPipeline(mandate, tradable);

    // The authoritative check, in mints, against the accounts as they stand.
    // `compliance` below is the pipeline's own view and works in symbols; this
    // one is what the chain will actually do.
    const evaluation = input.chain
      ? evaluateProposal({
          constraints: {
            maxPositionBps: input.maxPositionBps,
            minCashBps: input.minCashBps,
            maxTurnoverBps: input.maxTurnoverBps,
            maxAssets: input.maxAssets,
          },
          allowedMints: input.chain.allowedMints,
          current: input.chain.current,
          proposed: result.proposal.positions.flatMap((p) => {
            const asset = getAssetBySymbol(p.symbol);
            return asset ? [{ mint: asset.mint, targetBps: p.targetBps }] : [];
          }),
        })
      : null;

    return Response.json({
      mandate,
      chain: input.chain ?? null,
      evaluation,
      excludedForMissingPrice: excluded,
      research: result.research,
      bull: result.bull,
      bear: result.bear,
      risk: result.risk,
      proposal: result.proposal,
      compliance: result.compliance,
      stages: result.stages,
      totalDurationMs: result.totalDurationMs,
    });
  } catch (error) {
    if (error instanceof GeminiError) {
      return Response.json(
        {
          error: "agent pipeline failed",
          stage: error.stage,
          detail: error.detail ?? error.message,
        },
        { status: 502 },
      );
    }

    return Response.json(
      { error: "agent pipeline failed", detail: String(error) },
      { status: 500 },
    );
  }
}
