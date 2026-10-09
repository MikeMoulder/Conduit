import { parseAddress } from "@/lib/agent-actions";
import { listEntries } from "@/lib/autopilot/state";
import { readWallet } from "@/lib/portfolio";
import { listTriggers } from "@/lib/triggers/state";

/**
 * Everything the portfolio panel shows, in one request.
 *
 * The main wallet as the chat's get_wallet reads it, the person's alerts and
 * orders, and their autopilots. All of it is public chain data or records the
 * owner made, read for the address in the query, the same trust the chat's
 * read tools already work under.
 */

export const dynamic = "force-dynamic";

/** Finished alerts kept on the panel, enough to see what last fired. */
const RECENT_FINISHED = 5;

export async function GET(request: Request): Promise<Response> {
  const owner = parseAddress(new URL(request.url).searchParams.get("owner"));
  if (!owner) return Response.json({ error: "owner is required" }, { status: 400 });

  const [wallet, triggers, autopilots] = await Promise.all([
    readWallet(owner),
    listTriggers(owner.toBase58()).catch(() => []),
    listEntries(owner.toBase58()).catch(() => []),
  ]);

  const watching = triggers.filter((t) => t.status === "active" || t.status === "firing");
  const finished = triggers.filter((t) => t.status !== "active" && t.status !== "firing").slice(0, RECENT_FINISHED);

  return Response.json({ wallet, triggers: { watching, finished }, autopilots, at: Date.now() });
}
