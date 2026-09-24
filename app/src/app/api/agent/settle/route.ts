import { executeSettle } from "@/lib/agent-execution";

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

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const outcome = await executeSettle(body);
  return Response.json(outcome.body, { status: outcome.status });
}
