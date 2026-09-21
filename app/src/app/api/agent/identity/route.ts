import { getAgentIdentity } from "@/lib/agent-identity";

/**
 * The public key the agent signs proposals with.
 *
 * Exists so the mandate form can name the agent without the owner hunting for
 * an address. A public key is not a secret, and this one stops being private
 * the moment a mandate records it.
 *
 * The secret key is never reachable from here. This route returns a string it
 * derived, not the material it derived it from.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(getAgentIdentity());
}
