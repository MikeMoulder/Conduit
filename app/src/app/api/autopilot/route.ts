import { z } from "zod";

import { fetchMandate } from "@/lib/accounts";
import { parseAddress } from "@/lib/agent-actions";
import { getAgentIdentity } from "@/lib/agent-identity";
import { DEFAULT_BRAKE_BPS } from "@/lib/autopilot/brakes";
import { DEFAULT_PRE_IPO_CAP_BPS } from "@/lib/autopilot/pre-ipo";
import { startScheduler } from "@/lib/autopilot/scheduler";
import { resetPeak } from "@/lib/autopilot/scorecard";
import {
  getEntry,
  getScore,
  listDecisions,
  listEntries,
  saveScore,
  upsertEntry,
} from "@/lib/autopilot/state";
import { mandatePda } from "@/lib/chain";
import { getConnection } from "@/lib/rpc";

/**
 * Switches the autopilot on or off for a mandate, and reports what it has done.
 *
 * Switching it on is not a new grant of power. The owner already delegated the
 * mandate to the agent when they signed it, and the program enforces the rules
 * on every transaction whether a person or a timer sent it. What this records
 * is only that the owner wants the agent to act on its own schedule.
 *
 * The mandate address is derived from the owner and slot, never taken from the
 * request, and has to be one this server's agent can actually act on.
 */

export const dynamic = "force-dynamic";

const DEFAULT_OBJECTIVE =
  "Grow the portfolio steadily within the mandate. Favour quality, avoid concentration, and keep turnover modest.";

const setSchema = z.object({
  owner: z.string().min(32).max(44),
  mandateId: z.number().int().min(0).max(1_000_000),
  on: z.boolean(),
  everyMinutes: z.number().int().min(5).max(24 * 60).optional(),
  objective: z.string().min(1).max(2000).optional(),
  preIpoCapBps: z.number().int().min(0).max(10_000).optional(),
  brakeBps: z.number().int().min(0).max(5_000).optional(),
});

export async function POST(request: Request): Promise<Response> {
  // Idempotent. Covers a server that was already running before the startup
  // hook existed, which is exactly how the first timed cycle failed to happen.
  startScheduler();
  const parsed = setSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  const owner = parseAddress(parsed.data.owner);
  if (!owner) return Response.json({ error: "owner is not a valid address" }, { status: 400 });

  const mandateKey = mandatePda(owner, parsed.data.mandateId);
  const mandate = await fetchMandate(getConnection(), mandateKey);
  if (!mandate) return Response.json({ error: "no such mandate for this owner" }, { status: 404 });

  const agent = getAgentIdentity();
  if (!agent.configured || mandate.agent !== agent.publicKey) {
    return Response.json(
      { error: "this mandate names a different agent, so the autopilot could not act on it" },
      { status: 403 },
    );
  }

  const existing = getEntry(mandateKey.toBase58());

  // Switching a braked autopilot back on is the owner accepting the fall that
  // tripped it, so the brake measures from today. Otherwise it would trip
  // again on the first cycle.
  const resuming = parsed.data.on && Boolean(existing?.brakedAt);
  if (resuming) {
    const score = getScore(mandateKey.toBase58());
    if (score) saveScore(mandateKey.toBase58(), resetPeak(score));
  }

  const entry = upsertEntry({
    mandate: mandateKey.toBase58(),
    owner: owner.toBase58(),
    mandateId: parsed.data.mandateId,
    objective: parsed.data.objective ?? existing?.objective ?? DEFAULT_OBJECTIVE,
    everyMinutes: parsed.data.everyMinutes ?? existing?.everyMinutes ?? 30,
    preIpoCapBps: parsed.data.preIpoCapBps ?? existing?.preIpoCapBps ?? DEFAULT_PRE_IPO_CAP_BPS,
    brakeBps: parsed.data.brakeBps ?? existing?.brakeBps ?? DEFAULT_BRAKE_BPS,
    brakedAt: parsed.data.on ? null : (existing?.brakedAt ?? null),
    enabled: parsed.data.on,
    createdAt: existing?.createdAt ?? Date.now(),
    // Turning it on makes the first cycle due straight away rather than a full
    // interval later, so the person sees it act while they are still looking.
    lastRunAt: parsed.data.on ? null : (existing?.lastRunAt ?? null),
  });

  return Response.json({ ok: true, entry });
}

export async function GET(request: Request): Promise<Response> {
  startScheduler();
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner || !parseAddress(owner)) {
    return Response.json({ error: "owner is required" }, { status: 400 });
  }
  return Response.json({
    entries: listEntries(owner),
    decisions: listDecisions({ owner }, 20),
  });
}
