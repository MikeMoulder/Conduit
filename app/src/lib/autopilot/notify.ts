import "server-only";

import { explorerUrl } from "../chain";
import { CLUSTER } from "../cluster";
import type { AutopilotEntry, Decision } from "./state";

/**
 * Tells the owner what the autopilot decided, over Telegram.
 *
 * Optional. With TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID unset it does nothing,
 * and the decisions are still readable in the chat. A failure to send is
 * swallowed: a notification that did not arrive must never be the reason a
 * cycle is reported as failed, because the cycle itself is on chain either way.
 *
 * One chat id for the deployment, which is right for a demo with one person
 * watching and would become a per owner link in a real deployment.
 */

const ICON: Record<Decision["outcome"], string> = {
  rebalanced: "Rebalanced",
  held: "Held",
  skipped: "Skipped",
  failed: "Failed",
};

export function formatDecision(decision: Decision, entry: AutopilotEntry): string {
  const lines = [
    `Conduit autopilot, mandate ${entry.mandateId}`,
    `${ICON[decision.outcome]}: ${decision.summary}`,
  ];
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
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: formatDecision(decision, entry),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Deliberately quiet. See above.
  }
}
