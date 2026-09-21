import { z } from "zod";

import { getAssetBySymbol } from "@/lib/assets";
import { runPipeline, type MandateSpec } from "@/lib/agents/pipeline";
import { GeminiError } from "@/lib/gemini";
import { pricedSymbols, snapshotMarket } from "@/lib/market";

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

const requestSchema = z.object({
  objective: z.string().min(1).max(2000),
  maxPositionBps: bps,
  minCashBps: bps,
  maxTurnoverBps: bps,
  maxAssets: z.number().int().min(1).max(8),
  /** Omitted means every registry asset that currently has a price. */
  allowedSymbols: z.array(z.string().min(1).max(16)).min(1).max(8).optional(),
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

  const input = parsed.data;

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
  };

  try {
    const result = await runPipeline(mandate, tradable);

    return Response.json({
      mandate,
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
