import { z } from "zod";

import { fetchMandate } from "@/lib/accounts";
import { parseAddress } from "@/lib/agent-actions";
import { runNow } from "@/lib/autopilot/scheduler";
import { getEntry } from "@/lib/autopilot/state";
import { mandatePda } from "@/lib/chain";
import { getConnection } from "@/lib/rpc";

/**
 * Runs one autopilot cycle for a mandate now, instead of at its next interval.
 *
 * What a demo needs: nobody watches for thirty minutes to see an autonomous
 * decision land. It is the same cycle the timer runs, through the same guard
 * against running a mandate twice at once, and it is recorded in the same log.
 * A mandate the autopilot is not switched on for can be run once this way, at
 * the default objective, which is how someone tries it before committing.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  owner: z.string().min(32).max(44),
  mandateId: z.number().int().min(0).max(1_000_000),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  const owner = parseAddress(parsed.data.owner);
  if (!owner) return Response.json({ error: "owner is not a valid address" }, { status: 400 });

  const mandateKey = mandatePda(owner, parsed.data.mandateId);
  if (!(await fetchMandate(getConnection(), mandateKey))) {
    return Response.json({ error: "no such mandate for this owner" }, { status: 404 });
  }

  const entry = getEntry(mandateKey.toBase58()) ?? {
    mandate: mandateKey.toBase58(),
    owner: owner.toBase58(),
    mandateId: parsed.data.mandateId,
    objective:
      "Grow the portfolio steadily within the mandate. Favour quality, avoid concentration, and keep turnover modest.",
    everyMinutes: 30,
    enabled: false,
    createdAt: Date.now(),
    lastRunAt: null,
  };

  const decision = await runNow(entry);
  return Response.json({ decision });
}
