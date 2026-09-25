import "server-only";

import type { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate } from "../accounts";
import { getAgentIdentity } from "../agent-identity";
import { DEFAULT_PRE_IPO_CAP_BPS } from "../autopilot/pre-ipo";
import { describeScore, type Score } from "../autopilot/scorecard";
import { scoreNow } from "../autopilot/snapshot";
import { listDecisions, listEntries } from "../autopilot/state";
import { bpsToPercent, mandatePda, portfolioPda } from "../chain";
import { fetchHoldings } from "../holdings";
import { getConnection } from "../rpc";
import { botToken } from "../telegram/bot";
import { chatFor } from "../telegram/state";
import { ToolError, type CopilotTool, type ToolContext } from "./tool-types";

/**
 * The copilot's tools for autonomous mode.
 *
 * The one place the agent acts without a person approving each step. What makes
 * that acceptable is not these tools, which only switch it on and report on it,
 * but the program: every transaction a cycle sends is checked against the rules
 * the owner signed. So the tools are careful about one thing, which is being
 * clear with the person that from here on the agent decides and the chain
 * checks.
 */

function requireOwner(ctx: ToolContext): PublicKey {
  if (!ctx.owner) {
    throw new ToolError(
      "No wallet is connected, so there is nobody whose mandate this could run. Ask the person to connect one.",
    );
  }
  return ctx.owner;
}

const mandateIdArg = z.number().int().min(0).max(1_000_000).optional();

async function requireRunnableMandate(owner: PublicKey, mandateId: number) {
  const connection = getConnection();
  const address = mandatePda(owner, mandateId);
  const mandate = await fetchMandate(connection, address);
  if (!mandate) {
    throw new ToolError(`There is no mandate ${mandateId} for this wallet. Create one first.`);
  }
  const agent = getAgentIdentity();
  if (!agent.configured || mandate.agent !== agent.publicKey) {
    throw new ToolError("This mandate names a different agent, so the autopilot here could not act on it.");
  }
  if (mandate.status !== "active") {
    throw new ToolError(`Mandate ${mandateId} is ${mandate.status}. The program refuses the agent until the owner reactivates it.`);
  }
  const holdings = await fetchHoldings(connection, portfolioPda(address), mandate);
  return { address, mandate, funded: holdings.funded };
}

const setAutopilot: CopilotTool = {
  label: "Preparing the autopilot",
  declaration: {
    name: "set_autopilot",
    description:
      "Prepares switching autonomous mode on or off for one of the person's mandates. When on, the agent runs the full analysis on a schedule and rebalances and settles on its own, with no approval per trade; the program checks every transaction against the mandate's rules. It never sends a proposal the mandate would refuse, and it leaves the allocation alone when the analysis barely changes it. Use the person's own words for the objective. This does NOT execute: they approve a card.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
        on: { type: "BOOLEAN", description: "True to switch it on, false to stop it." },
        everyMinutes: {
          type: "INTEGER",
          description: "How often it runs, in minutes. At least 5. Defaults to 30.",
        },
        objective: {
          type: "STRING",
          description: "What the agent should aim for, in the person's words.",
        },
        preIpoCapPercent: {
          type: "NUMBER",
          description:
            "Most of the mandate the pre IPO names (SpaceX, OpenAI and the rest) may hold together, in percent. Only if the person says. Defaults to 10. 0 keeps the autopilot out of pre IPO entirely.",
        },
      },
      required: ["on"],
    },
  },
  async run(args, ctx) {
    const parsed = z
      .object({
        mandateId: mandateIdArg,
        on: z.boolean(),
        everyMinutes: z.number().int().min(5).max(1440).optional(),
        objective: z.string().min(1).max(2000).optional(),
        preIpoCapPercent: z.number().min(0).max(100).optional(),
      })
      .parse(args);
    const owner = requireOwner(ctx);
    const mandateId = parsed.mandateId ?? 0;
    const everyMinutes = parsed.everyMinutes ?? 30;
    const label = `mandate ${mandateId}`;
    const preIpoCapBps =
      parsed.preIpoCapPercent === undefined ? null : Math.round(parsed.preIpoCapPercent * 100);
    const capText = bpsToPercent(preIpoCapBps ?? DEFAULT_PRE_IPO_CAP_BPS);

    if (parsed.on) {
      const { funded } = await requireRunnableMandate(owner, mandateId);
      if (!funded) {
        throw new ToolError(
          `Mandate ${mandateId} holds no cash, so the autopilot would have nothing to invest. Offer fund_mandate first.`,
        );
      }
    }

    return {
      result: { prepared: true, mandate: label, on: parsed.on, everyMinutes },
      summary: parsed.on
        ? `autopilot on ${label} every ${everyMinutes} min, awaiting approval`
        : `autopilot off on ${label}, awaiting approval`,
      action: {
        kind: "autopilot",
        owner: owner.toBase58(),
        mandateId,
        mandateLabel: label,
        on: parsed.on,
        everyMinutes,
        objective: parsed.objective ?? null,
        preIpoCapBps,
        summary: parsed.on
          ? `Let the agent run ${label} on its own every ${everyMinutes} minutes${parsed.objective ? `, aiming to ${parsed.objective.replace(/\.$/, "")}` : ""}. It analyses, rebalances and settles without asking you each time. The program checks every transaction against the mandate's rules, so it can only do what you already allowed. Pre-IPO names are bought only when their token trades below the company's mark, never added to at a premium, and kept to ${capText} of the mandate together. The first cycle starts within a minute.`
          : `Stop the autopilot on ${label}. Nothing it already did is undone, and you can switch it back on at any time.`,
      },
    };
  },
};

const getAutopilot: CopilotTool = {
  label: "Reading the autopilot log",
  declaration: {
    name: "get_autopilot",
    description:
      "Reports which of the person's mandates run on autopilot, how often, the most recent decisions it made on its own with what it did and why, and each mandate's scorecard: its return since the autopilot started against simply holding SPY, as of right now. Deposits and withdrawals are kept out of the return. Use it whenever they ask what the agent has been doing, or how they are doing.",
    parameters: { type: "OBJECT", properties: {} },
  },
  async run(_args, ctx) {
    const owner = requireOwner(ctx).toBase58();
    const entries = listEntries(owner);
    const decisions = listDecisions({ owner }, 8);
    const connection = getConnection();
    const scores = (
      await Promise.all(
        entries.map(async (e) => {
          const score = await scoreNow(connection, e.mandate).catch(() => null);
          return score ? { mandateId: e.mandateId, score } : null;
        }),
      )
    ).filter((s): s is { mandateId: number; score: Score } => s !== null);

    return {
      result: {
        telegramLinked: chatFor(owner) !== null,
        running: entries.filter((e) => e.enabled).map((e) => ({ mandateId: e.mandateId, everyMinutes: e.everyMinutes, preIpoCap: bpsToPercent(e.preIpoCapBps ?? DEFAULT_PRE_IPO_CAP_BPS) })),
        scorecards: scores.map((s) => ({
          mandateId: s.mandateId,
          scorecard: describeScore(s.score),
          returnPercent: Number(s.score.returnPct.toFixed(2)),
          spyReturnPercent: Number(s.score.spyReturnPct.toFixed(2)),
        })),
        recent: decisions.slice(0, 5).map((d) => ({
          at: new Date(d.at).toISOString(),
          outcome: d.outcome,
          summary: d.summary,
          preIpo: d.preIpo ?? [],
        })),
      },
      summary:
        entries.length === 0
          ? "no autopilot yet"
          : `${entries.filter((e) => e.enabled).length} running, ${decisions.length} recent decisions`,
      card: { kind: "autopilot", entries, decisions, scores },
    };
  },
};

const runAutopilotNow: CopilotTool = {
  label: "Preparing a cycle",
  declaration: {
    name: "run_autopilot_now",
    description:
      "Prepares one autonomous cycle on a mandate right now instead of waiting for its schedule: the full analysis, then a rebalance and settlement if the analysis changes the allocation and the mandate allows it. Takes about half a minute. Works whether or not the autopilot is switched on. This does NOT execute: they approve a card.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
      },
    },
  },
  async run(args, ctx) {
    const { mandateId = 0 } = z.object({ mandateId: mandateIdArg }).parse(args);
    const owner = requireOwner(ctx);
    const { funded } = await requireRunnableMandate(owner, mandateId);
    if (!funded) {
      throw new ToolError(`Mandate ${mandateId} holds no cash to invest yet. Offer fund_mandate first.`);
    }
    const label = `mandate ${mandateId}`;
    return {
      result: { prepared: true, mandate: label },
      summary: `one cycle on ${label}, awaiting approval`,
      action: {
        kind: "autopilot-run",
        owner: owner.toBase58(),
        mandateId,
        mandateLabel: label,
        summary: `Run one autonomous cycle on ${label} now: analyse the market, then rebalance and settle if the result changes the allocation and the mandate allows it. The agent decides; the program checks.`,
      },
    };
  },
};

const linkTelegram: CopilotTool = {
  label: "Preparing Telegram",
  declaration: {
    name: "link_telegram",
    description:
      "Prepares connecting the person's own Telegram chat, so their autopilot decisions are sent to them there. Their wallet signs a short message proving it is theirs (not a transaction), then they get a one time link to open in Telegram and press Start. Each person links their own chat; decisions only ever go to the chat linked to the wallet that owns the mandate. This does NOT execute: they approve a card.",
    parameters: { type: "OBJECT", properties: {} },
  },
  async run(_args, ctx) {
    const owner = requireOwner(ctx);
    if (!botToken()) {
      throw new ToolError(
        "Telegram is not set up on this server yet: the operator needs to add a bot token. Everything the autopilot decides is still visible here with get_autopilot.",
      );
    }
    if (chatFor(owner.toBase58()) !== null) {
      throw new ToolError("This wallet already has a Telegram chat linked. Offer unlink_telegram if they want to change it.");
    }
    return {
      result: { prepared: true },
      summary: "Telegram link ready to sign",
      action: {
        kind: "link-telegram",
        owner: owner.toBase58(),
        summary:
          "Connect your Telegram so the autopilot can tell you what it decides. Your wallet signs a short message to prove it is yours; nothing moves and it costs nothing. You then get a link to open in Telegram and press Start. It works once and expires in ten minutes.",
      },
    };
  },
};

const unlinkTelegram: CopilotTool = {
  label: "Preparing to disconnect Telegram",
  declaration: {
    name: "unlink_telegram",
    description:
      "Prepares stopping Telegram updates for the person's wallet. Their wallet signs a short message to prove it is theirs. Sending /stop to the bot does the same. This does NOT execute: they approve a card.",
    parameters: { type: "OBJECT", properties: {} },
  },
  async run(_args, ctx) {
    const owner = requireOwner(ctx);
    if (chatFor(owner.toBase58()) === null) {
      throw new ToolError("No Telegram chat is linked to this wallet.");
    }
    return {
      result: { prepared: true },
      summary: "ready to disconnect Telegram",
      action: {
        kind: "unlink-telegram",
        owner: owner.toBase58(),
        summary: "Stop sending autopilot updates for this wallet to Telegram. Your wallet signs a short message to confirm; nothing moves.",
      },
    };
  },
};

export const AUTOPILOT_TOOLS: Record<string, CopilotTool> = {
  link_telegram: linkTelegram,
  unlink_telegram: unlinkTelegram,
  set_autopilot: setAutopilot,
  get_autopilot: getAutopilot,
  run_autopilot_now: runAutopilotNow,
};
