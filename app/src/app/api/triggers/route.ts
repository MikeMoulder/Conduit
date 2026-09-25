import { z } from "zod";

import { parseAddress } from "@/lib/agent-actions";
import { startScheduler } from "@/lib/autopilot/scheduler";
import { MAX_RUNS, MAX_TTL_DAYS, MIN_DELAY_MINUTES, expiryFor } from "@/lib/triggers/rules";
import { checkTrigger } from "@/lib/triggers/prepare";
import { addTrigger, listTriggers } from "@/lib/triggers/state";

/**
 * Sets a price trigger once the owner approves it, and lists theirs.
 *
 * Unauthenticated like the other agent routes, and bounded the same way: the
 * worst a stranger can do is set a trigger that later trades someone's main
 * wallet at market prices, which moves no value out of it.
 */

export const dynamic = "force-dynamic";

const schema = z.object({
  owner: z.string().min(32).max(44),
  symbol: z.string().min(1).max(16),
  condition: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("rise"), percent: z.number().positive().max(1000) }),
    z.object({ kind: z.literal("fall"), percent: z.number().positive().max(99.99) }),
    z.object({ kind: z.literal("above"), price: z.number().positive() }),
    z.object({ kind: z.literal("below"), price: z.number().positive() }),
    z.object({ kind: z.literal("after"), minutes: z.number().min(MIN_DELAY_MINUTES).max(MAX_TTL_DAYS * 1440) }),
    z.object({ kind: z.literal("always") }),
  ]),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("notify") }),
    z.object({ kind: z.enum(["buy", "sell"]), dollars: z.number().positive().max(10_000_000) }),
  ]),
  days: z.number().positive().max(MAX_TTL_DAYS).optional(),
  repeat: z
    .object({
      everyMinutes: z.number().min(MIN_DELAY_MINUTES).max(MAX_TTL_DAYS * 1440),
      maxRuns: z.number().int().min(1).max(MAX_RUNS),
    })
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  // The trigger timer rides on the scheduler, started here as well so a
  // trigger set on a fresh server is watched from the next minute.
  startScheduler();
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  const owner = parseAddress(parsed.data.owner);
  if (!owner) return Response.json({ error: "owner is not a valid address" }, { status: 400 });

  const check = await checkTrigger({ ...parsed.data, owner });
  if (!check.ok) return Response.json({ error: check.error }, { status: 409 });

  const now = Date.now();
  const trigger = await addTrigger({
    owner: owner.toBase58(),
    symbol: check.symbol,
    condition: parsed.data.condition,
    basePrice: check.basePrice,
    action: parsed.data.action,
    createdAt: now,
    // A timed trigger's clock starts here, at approval, not when it was prepared.
    expiresAt: expiryFor(parsed.data.condition, now, parsed.data.days, parsed.data.repeat),
    // A repeating one makes its first check on the next pass.
    ...(parsed.data.repeat ? { repeat: parsed.data.repeat, runs: 0, nextAt: now } : {}),
  });
  return Response.json({ ok: true, trigger });
}

export async function GET(request: Request): Promise<Response> {
  const owner = new URL(request.url).searchParams.get("owner");
  if (!owner || !parseAddress(owner)) return Response.json({ error: "owner is required" }, { status: 400 });
  return Response.json({ triggers: await listTriggers(owner) });
}
