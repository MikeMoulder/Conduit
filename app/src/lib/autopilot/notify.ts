import "server-only";

import { explorerUrl } from "../chain";
import { CLUSTER } from "../cluster";
import { sendToOwner } from "../telegram/bot";
import { describeScore } from "./scorecard";
import type { AutopilotEntry, Decision } from "./state";

/**
 * Tells the owner what the autopilot decided, over Telegram.
 *
 * To the chat that owner linked, and nobody else. There is no fixed chat id in
 * configuration: one bot serves everyone, and each person links their own chat
 * to their own wallet by proving the wallet is theirs. An owner who has not
 * linked a chat gets nothing here, and still sees every decision in Conduit.
 *
 * A failure to send is swallowed: a notification that did not arrive must
 * never be the reason a cycle is reported as failed, because the cycle itself
 * is on chain either way.
 */

const ICON: Record<Decision["outcome"], string> = {
  rebalanced: "Rebalanced",
  held: "Held",
  skipped: "Skipped",
  failed: "Failed",
  braked: "Stopped",
};

export function formatDecision(decision: Decision, entry: AutopilotEntry): string {
  const lines = [
    `Conduit autopilot, mandate ${entry.mandateId}`,
    `${ICON[decision.outcome]}: ${decision.summary}`,
  ];
  if (decision.score) {
    lines.push(`Scorecard: ${describeScore(decision.score)}`);
  }
  if (decision.preIpo?.length) {
    lines.push(`Pre-IPO:\n${decision.preIpo.map((note) => `- ${note}`).join("\n")}`);
  }
  if (decision.reasoning) {
    const why = decision.reasoning.replace(/\s+/g, " ").trim();
    lines.push(`Why: ${why.length > 400 ? `${why.slice(0, 397)}...` : why}`);
  }
  for (const signature of decision.signatures) {
    lines.push(explorerUrl(signature, "tx", CLUSTER));
  }
  return lines.join("\n\n");
}

export async function notify(decision: Decision, entry: AutopilotEntry): Promise<void> {
  await sendToOwner(decision.owner, formatDecision(decision, entry)).catch(() => "failed");
}
