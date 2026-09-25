import "server-only";

import { MARKET_TOOLS } from "./market-tools";
import type { CopilotTool } from "./tool-types";
import { WALLET_TOOLS } from "./wallet-tools";

/**
 * Everything a greeting needs, in one call.
 *
 * Answering "yo" well depends on where the person is: not connected, new,
 * set up with nothing bought, or holding something. The first version left
 * the model to read the wallet and then decide whether to fetch a brief, and
 * once it skipped the brief and wrote "NVDA is up 1.2% today" from nothing.
 * So the deciding and the fetching happen here, and the model is handed the
 * stage and every fact it may use, with nothing left to look up or invent.
 *
 * Built on get_wallet and get_stock_brief rather than beside them, so a
 * greeting's numbers come from the same code as every other answer.
 */

type Stage = "not-connected" | "first-time" | "ready" | "holding";

/**
 * The words for someone who has not started, written here rather than left to
 * the model.
 *
 * These are the first words a new person reads, and a small model improvising
 * them drifted into chat room cheer: exclamation marks, "play money", and a
 * numbered list whose numbers it wrote twice. A person deciding whether to
 * trust a product with money should meet the same measured sentences every
 * time, so the model is handed them to use as written.
 */
const INTRO =
  "Conduit lets you trade tokenized US equities, such as NVIDIA and Tesla, through conversation, and can manage a portfolio for you within limits you set and the Solana program enforces.";

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function notConnectedGreeting(): string {
  return `Welcome to Conduit. ${INTRO}\n\nConnect a Solana wallet with the button to begin. Conduit runs on devnet, so every balance is in test funds.`;
}

function firstTimeGreeting(ownCash: number): string {
  const steps =
    ownCash > 0
      ? [
          `**Open your main wallet.** Type "open my main wallet". It takes one signature, and trades after that need none.`,
          `**Place your first trade.** Type "buy $100 of NVDA".`,
          `**See what is moving.** Type "what is moving today?"`,
        ]
      : [
          `**Add test funds.** Type "give me demo cash".`,
          `**Open your main wallet.** Type "open my main wallet". It takes one signature, and trades after that need none.`,
          `**Place your first trade.** Type "buy $100 of NVDA".`,
        ];
  const funds = ownCash > 0 ? ` Your wallet holds ${usd(ownCash)} in test funds.` : "";
  return [
    `Welcome to Conduit. ${INTRO} It runs on Solana devnet, so every balance is in test funds.${funds}`,
    "To get started:",
    steps.map((step, i) => `${i + 1}. ${step}`).join("\n"),
    "You can ask a question at any point along the way.",
  ].join("\n\n");
}

const getWelcome: CopilotTool = {
  label: "Getting your bearings",
  declaration: {
    name: "get_welcome",
    description:
      "Call this, and only this, when someone just says hello (hi, yo, hey, gm, sup) with nothing else. Returns which stage they are at (not-connected, first-time, ready, holding), their cash and holdings, and for their largest holding today's move and top headline, plus the next steps to offer as exact words. Write the greeting from these facts only.",
    parameters: { type: "OBJECT", properties: {} },
  },
  async run(args, ctx) {
    if (!ctx.owner) {
      const stage: Stage = "not-connected";
      return {
        result: {
          stage,
          greeting: notConnectedGreeting(),
          note: "Reply with greeting exactly as written, and nothing else.",
        },
        summary: "no wallet connected",
      };
    }

    const wallet = await WALLET_TOOLS.get_wallet.run({}, ctx);
    const w = wallet.result as {
      opened?: boolean;
      ownWalletCash?: number;
      cash?: number;
      holdings?: { symbol: string; value: number | null }[];
    };

    if (!w.opened) {
      const stage: Stage = "first-time";
      return {
        result: {
          stage,
          greeting: firstTimeGreeting(w.ownWalletCash ?? 0),
          note: "Reply with greeting exactly as written, and nothing else.",
        },
        summary: "first time here",
      };
    }

    const holdings = (w.holdings ?? []).filter((h) => (h.value ?? 0) > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    if (holdings.length === 0) {
      const stage: Stage = "ready";
      return {
        result: {
          stage,
          mainWalletCash: w.cash ?? 0,
          ownWalletCash: w.ownWalletCash ?? 0,
          nextWords: ["buy $100 of NVDA", "what is moving today?", "alert me if TSLA drops 3%"],
        },
        summary: "set up, nothing bought yet",
        card: wallet.card,
      };
    }

    const largest = holdings[0];
    const brief = await MARKET_TOOLS.get_stock_brief.run({ symbol: largest.symbol }, ctx).catch(() => null);
    const b = brief?.result as
      | {
          day?: { changePercent: number; where: string } | string;
          headlines?: { title: string; source: string; summary?: string }[] | string;
        }
      | undefined;
    const day = b && typeof b.day === "object" ? b.day : null;
    const top = b && Array.isArray(b.headlines) ? b.headlines[0] : null;
    const stage: Stage = "holding";
    const other = holdings[1]?.symbol ?? (largest.symbol === "TSLA" ? "AAPL" : "TSLA");

    return {
      result: {
        stage,
        mainWalletCash: w.cash ?? 0,
        holdings: holdings.map((h) => ({ symbol: h.symbol, value: Number((h.value ?? 0).toFixed(2)) })),
        largest: {
          symbol: largest.symbol,
          value: Number((largest.value ?? 0).toFixed(2)),
          today: day
            ? { changePercent: day.changePercent, where: day.where }
            : "no intraday figure available: do not state a daily move",
          topHeadline: top ? { title: top.title, source: top.source, summary: top.summary ?? null } : null,
        },
        nextWords: [
          `buy $100 more ${largest.symbol}`,
          `alert me if ${largest.symbol} drops 3%`,
          `how is ${other} doing?`,
        ],
      },
      summary: `${largest.symbol} is the largest holding${day ? `, ${day.changePercent >= 0 ? "+" : ""}${day.changePercent}% today` : ""}`,
      card: wallet.card,
      sources: [...(wallet.sources ?? []), ...(brief?.sources ?? [])],
    };
  },
};

export const WELCOME_TOOLS: Record<string, CopilotTool> = {
  get_welcome: getWelcome,
};
