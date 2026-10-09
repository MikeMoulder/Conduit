import type { Card } from "./events";
import type { Turn } from "./store";

/**
 * What a person could say next, offered as chips under the latest reply.
 *
 * Picked by rules from what just happened rather than asked of the model.
 * A model would cost another call and another second, and could offer
 * something no tool can do. These are instant, free, and every one is a
 * sentence the copilot already handles: after a brief on NVDA, buy some or
 * set an alert on it; after a trade, how it is doing or an alert; after a
 * wallet with no cash, the deposit.
 *
 * Nothing is offered while a card is waiting, since the card is the next
 * step, or after an error, where the next step is trying again.
 */

const MAX = 3;

/** Sentences for whatever the most recent card or result was about. */
function fromCard(card: Card): string[] {
  switch (card.kind) {
    case "stock-brief": {
      const { symbol, held } = card.brief;
      return held && held > 0
        ? [`Buy $50 more ${symbol}`, `Ping me if ${symbol} drops 3%`, `Sell all my ${symbol}`]
        : [`Buy $50 of ${symbol}`, `Ping me if ${symbol} drops 3%`, `Run a full analysis on ${symbol}`];
    }
    case "wallet-result": {
      const { ok, headline } = card.result;
      if (!ok) return [];
      const traded = /^(Bought|Sold) ([A-Z0-9]+)/.exec(headline);
      if (traded) return [`How's ${traded[2]} doing?`, `Ping me if ${traded[2]} drops 5%`, "Show my wallet"];
      if (/test money|topped up/i.test(headline)) return ["Open my main wallet", "Deposit $1,000"];
      if (/main wallet is open/i.test(headline)) return ["Deposit $1,000", "Give me demo cash"];
      if (/^Deposited/.test(headline)) return ["Buy $50 of Apple", "How's NVIDIA doing today?"];
      return ["Show my wallet"];
    }
    case "wallet": {
      const { opened, cash, ownCash, holdings } = card.wallet;
      if (!opened) return ["Open my main wallet", "Give me demo cash"];
      if (cash === 0 && holdings.length === 0) return ownCash > 0 ? ["Deposit $1,000"] : ["Give me demo cash"];
      const top = [...holdings].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
      return top
        ? [`How's ${top.symbol} doing?`, `Ping me if ${top.symbol} drops 5%`, "How's NVIDIA doing today?"]
        : ["Buy $50 of Apple", "How's NVIDIA doing today?"];
    }
    case "analysis": {
      const top = [...card.analysis.positions].sort((a, b) => b.targetBps - a.targetBps)[0];
      return top
        ? [`Buy $100 of ${top.symbol}`, "Put it on autopilot", `How's ${top.symbol} doing?`]
        : ["Put it on autopilot"];
    }
    case "autopilot":
      return ["How am I doing against the market?", "Run the autopilot now"];
    case "mandate":
    case "portfolio":
      return ["Put it on autopilot", "How am I doing against the market?"];
    case "submission":
    case "settlement":
      return ["Show my portfolio", "How am I doing against the market?"];
    case "triggers":
    case "prices":
    case "universe":
    case "history":
    case "verdict":
      return ["How's NVIDIA doing today?", "Show my wallet"];
  }
}

const FALLBACK = ["How's NVIDIA doing today?", "Show my wallet", "What can you do?"];

/** Up to three things to say next, or none when something else is the next step. */
export function followUps(turns: Turn[]): string[] {
  const last = turns[turns.length - 1];
  if (!last || last.role !== "assistant") return [];
  if (last.streaming || last.error || last.actions.length > 0) return [];

  // The reply to a card's result has no card of its own, so the card it is
  // about sits on the reply before it.
  const recent = turns.filter((t) => t.role === "assistant").slice(-2).reverse();
  let picked: string[] = [];
  for (const turn of recent) {
    const items: Card[] = [...turn.cards, ...(turn.outcomes ?? [])];
    for (const card of items.reverse()) {
      picked = fromCard(card);
      if (picked.length > 0) break;
    }
    if (picked.length > 0) break;
  }
  if (picked.length === 0) picked = FALLBACK;

  // Never offer the question that was just asked.
  const asked = [...turns].reverse().find((t) => t.role === "user" && !t.event)?.text.trim().toLowerCase();
  return [...new Set(picked)].filter((s) => s.toLowerCase() !== asked).slice(0, MAX);
}
