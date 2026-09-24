import { executeRebalance } from "@/lib/agent-execution";

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

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const outcome = await executeRebalance(body);
  return Response.json(outcome.body, { status: outcome.status });
}
