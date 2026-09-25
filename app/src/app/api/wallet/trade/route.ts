import { z } from "zod";

import { parseAddress } from "@/lib/agent-actions";
import { executeWalletTrade } from "@/lib/wallet-trade";

/**
 * A trade in a person's main wallet, on their word, signed by the agent.
 *
 * A wrapper around `executeWalletTrade`, which a price trigger also calls. See
 * there for why it is safe to leave unauthenticated: anyone who calls it can
 * at worst trade someone's main wallet at market prices, which moves no value
 * out of it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const requestSchema = z.object({
  owner: z.string().min(32).max(44),
  side: z.enum(["buy", "sell"]),
  symbol: z.string().min(1).max(16),
  dollars: z.number().positive().finite(),
  all: z.boolean().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  const owner = parseAddress(parsed.data.owner);
  if (!owner) return Response.json({ error: "owner is not a valid address" }, { status: 400 });

  const { status, body } = await executeWalletTrade({ ...parsed.data, owner });
  return Response.json(body, { status });
}
