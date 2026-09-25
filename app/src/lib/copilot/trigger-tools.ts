import "server-only";

import type { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { fetchWalletBalances, walletAddress } from "../main-wallet";
import { getConnection } from "../rpc";
import { botToken } from "../telegram/bot";
import { chatFor } from "../telegram/state";
import { checkTrigger } from "../triggers/prepare";
import {
  DEFAULT_RUNS,
  DEFAULT_TTL_DAYS,
  MAX_RUNS,
  MAX_TTL_DAYS,
  MIN_DELAY_MINUTES,
  describeEvery,
  describeTrigger,
  describeWait,
  targetPrice,
  type Condition,
  type Repeat,
  type TriggerAction,
} from "../triggers/rules";
import { cancelTrigger, listTriggers } from "../triggers/state";
import { ToolError, type CopilotTool, type ToolContext } from "./tool-types";
import { fundFirst } from "./wallet-tools";

/**
 * The copilot's tools for price triggers: "when NVDA rises 2.5%, message me
 * and buy $500 of it", timed ones: "in 2 minutes, buy $50 of AAPL", and
 * repeating ones: "buy $20 of AAPL every 10 minutes".
 *
 * Setting one is a card the owner approves, like any order, because a trigger
 * that trades is an order placed in advance. Cancelling is done straight
 * away: it only ever stops something from happening.
 */

function requireOwner(ctx: ToolContext): PublicKey {
  if (!ctx.owner) {
    throw new ToolError("No wallet is connected, so there is nobody to set a trigger for. Ask the person to connect one.");
  }
  return ctx.owner;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What the main wallet lacks, today, to place the trade a trigger would place.
 * Null when it has enough, when the trigger only messages, or when the
 * balance cannot be read.
 */
async function fundingShortfall(
  owner: PublicKey,
  symbol: string,
  action: TriggerAction,
  price: number,
  runs = 1,
): Promise<string | null> {
  if (action.kind === "notify") return null;
  const total = action.dollars * runs;
  const all = runs > 1 ? ` over all ${runs} runs` : "";
  try {
    const balances = await fetchWalletBalances(getConnection(), walletAddress(owner));
    if (action.kind === "buy") {
      const cash = balances.cash?.uiAmount ?? 0;
      return cash >= total
        ? null
        : `your main wallet has ${usd(cash)} of cash now, less than the ${usd(total)} this would buy${all}. Deposit before then, or a buy will fail and stop it.`;
    }
    const held = balances.assets.find((a) => a.symbol === symbol)?.uiAmount ?? 0;
    return held * price >= total
      ? null
      : `your main wallet holds about ${usd(held * price)} of ${symbol} now, less than the ${usd(total)} this would sell${all}. A sale will fail and stop it unless you hold more by then.`;
  } catch {
    return null;
  }
}

const setTrigger: CopilotTool = {
  label: "Preparing a price trigger",
  declaration: {
    name: "set_price_trigger",
    description:
      "Prepares a price, timed or repeating trigger: watch one asset and, the first time a condition holds, message the person on Telegram and optionally buy or sell a dollar amount in their main wallet with no further approval. Conditions: rise or fall by a percentage from the current price, reach a price from below (above) or above (below), or after, a wait in minutes from the moment they approve. Use it for 'tell me when', 'alert me if', 'buy when it drops to', 'sell if it rises', and for anything timed: 'in 2 minutes buy', 'sell in an hour', 'remind me of the price in 30 minutes'. For a timed request use condition after with value in minutes (an hour is 60, a day is 1440). For anything repeated ('every 10 minutes', 'each hour', 'every day') set every_minutes: 'buy $20 of AAPL every 10 minutes' is condition always with every_minutes 10, and 'every 10 minutes, if NVDA is above $180, buy $100' is condition above, value 180, every_minutes 10. A repeating trigger checks once per interval, acts each time its condition holds, and stops after times runs (10 if they do not say). Without every_minutes it fires once, and expires after 7 days unless they say otherwise; a timed one fires at its time. This does NOT execute: they approve a card.",
    parameters: {
      type: "OBJECT",
      properties: {
        symbol: { type: "STRING", description: "The asset to watch, such as NVDA." },
        condition: {
          type: "STRING",
          description: "rise, fall, above, below, after, or always (no price condition; only with every_minutes).",
        },
        value: {
          type: "NUMBER",
          description:
            "For rise or fall, the percentage, such as 2.5. For above or below, the price in dollars. For after, the wait in minutes, such as 2. Leave out for always.",
        },
        every_minutes: {
          type: "NUMBER",
          description: "Makes it repeat: check this often, in minutes, such as 10. An hour is 60, a day is 1440.",
        },
        times: {
          type: "NUMBER",
          description: `With every_minutes, the most times it acts. Defaults to ${DEFAULT_RUNS}, at most ${MAX_RUNS}.`,
        },
        action: { type: "STRING", description: "notify, buy or sell. Defaults to notify." },
        dollars: { type: "NUMBER", description: "For buy or sell, the dollar amount to trade." },
        days: { type: "NUMBER", description: `How long to watch, in days. Defaults to ${DEFAULT_TTL_DAYS}, at most ${MAX_TTL_DAYS}.` },
      },
      required: ["symbol", "condition"],
    },
  },
  async run(args, ctx) {
    const parsed = z
      .object({
        symbol: z.string().min(1).max(16),
        condition: z.enum(["rise", "fall", "above", "below", "after", "always"]),
        value: z.number().positive().optional(),
        every_minutes: z.number().positive().optional(),
        times: z.number().int().positive().max(MAX_RUNS).optional(),
        action: z.enum(["notify", "buy", "sell"]).optional(),
        dollars: z.number().positive().optional(),
        days: z.number().positive().max(MAX_TTL_DAYS).optional(),
      })
      .parse({
        ...args,
        condition: String(args.condition ?? "").toLowerCase(),
        action: args.action === undefined ? undefined : String(args.action).toLowerCase(),
      });
    const owner = requireOwner(ctx);

    const value = parsed.value ?? 0;
    if (parsed.condition !== "always" && !value) {
      throw new ToolError(`A ${parsed.condition} trigger needs a value. Ask for it.`);
    }
    if (parsed.condition === "after" && value < MIN_DELAY_MINUTES) {
      throw new ToolError(
        `A timed trigger waits at least ${MIN_DELAY_MINUTES} minute. For anything sooner, offer to place the order now with place_order.`,
      );
    }
    if (parsed.condition === "after" && parsed.every_minutes) {
      throw new ToolError("A repeating trigger starts straight away. Use condition always with every_minutes, or say the first run is right after approval.");
    }
    const condition: Condition =
      parsed.condition === "always"
        ? { kind: "always" }
        : parsed.condition === "after"
          ? { kind: "after", minutes: value }
          : parsed.condition === "rise" || parsed.condition === "fall"
            ? { kind: parsed.condition, percent: value }
            : { kind: parsed.condition, price: value };
    const repeat: Repeat | undefined = parsed.every_minutes
      ? { everyMinutes: parsed.every_minutes, maxRuns: parsed.times ?? DEFAULT_RUNS }
      : undefined;
    const timed = condition.kind === "after";
    const kind = parsed.action ?? "notify";
    if (kind !== "notify" && !parsed.dollars) {
      throw new ToolError(`A trigger that will ${kind} needs a dollar amount. Ask how much.`);
    }
    const action: TriggerAction = kind === "notify" ? { kind } : { kind, dollars: parsed.dollars! };

    const check = await checkTrigger({ owner, symbol: parsed.symbol.toUpperCase(), condition, action, repeat });
    if (!check.ok) throw new ToolError(check.error);

    // A buy the main wallet cannot pay for is funded first, when their own
    // wallet can cover it: the deposit card comes now, and the trigger after.
    if (action.kind === "buy") {
      const balances = await fetchWalletBalances(getConnection(), walletAddress(owner)).catch(() => null);
      const cash = balances?.cash?.uiAmount ?? 0;
      if (balances && cash < action.dollars) {
        const sentence = describeTrigger({ symbol: check.symbol, condition, basePrice: check.basePrice, action, repeat });
        try {
          return await fundFirst({
            owner,
            needed: action.dollars,
            have: cash,
            purpose: `a trigger that buys ${usd(action.dollars)} of ${check.symbol}`,
            then: `the trigger (${sentence.replace(/\.$/, "")})`,
            retry: { tool: "set_price_trigger", args: { ...args } },
          });
        } catch {
          // Their own wallet cannot cover it either. Fall through: the trigger
          // can still be set, and the card says what it lacks.
        }
      }
    }

    // Not a refusal: they may fund it before it fires. But a trade that will
    // fail for want of cash or holding should be said now, not when it fails.
    const shortfall = await fundingShortfall(owner, check.symbol, action, check.basePrice, repeat?.maxRuns ?? 1);

    const days = timed ? Math.max(1, Math.ceil(value / 1440)) : (parsed.days ?? DEFAULT_TTL_DAYS);
    const telegram = Boolean(botToken()) && (await chatFor(owner.toBase58())) !== null;
    const sentence = describeTrigger({ symbol: check.symbol, condition, basePrice: check.basePrice, action, repeat });

    return {
      result: {
        prepared: true,
        notDoneYet: "The trigger is NOT set yet. Tell them to press Set the trigger on the card to switch it on. Never say it is set.",
        trigger: sentence,
        currentPrice: check.basePrice,
        ...(repeat
          ? {
              repeats: `${describeEvery(repeat.everyMinutes)}, ${repeat.maxRuns} times at most, first check within a minute of approval`,
              ...(action.kind === "notify" ? {} : { mostInAll: action.dollars * repeat.maxRuns }),
            }
          : timed
            ? { firesAfter: `${describeWait(value)} from the moment they approve` }
            : { targetPrice: Number(targetPrice(condition, check.basePrice).toFixed(2)), watchesForDays: days }),
        telegramLinked: telegram,
        ...(shortfall ? { warning: shortfall } : {}),
      },
      summary: `${check.symbol} ${repeat ? "repeating " : timed ? "timed " : ""}trigger ready to approve`,
      action: {
        kind: "price-trigger",
        owner: owner.toBase58(),
        symbol: check.symbol,
        condition,
        action,
        days,
        ...(repeat ? { repeat } : {}),
        basePrice: check.basePrice,
        summary: `${sentence} ${check.symbol} is ${usd(check.basePrice)} now. ${
          repeat
            ? `The first check is within a minute of your approval, then ${describeEvery(repeat.everyMinutes)}. It stops after ${repeat.maxRuns} run${repeat.maxRuns === 1 ? "" : "s"}${condition.kind === "always" ? "" : ` or after ${days} day${days === 1 ? "" : "s"}, whichever comes first`}, and you can cancel it at any time.`
            : timed
              ? `The clock starts the moment you approve, and it fires once, ${describeWait(value)} later.`
              : `Measured from the moment you approve. Checked every minute for ${days} day${days === 1 ? "" : "s"}; it fires once.`
        }${
          action.kind === "notify"
            ? ""
            : ` ${repeat ? "Each time it acts" : "When it fires"} the agent places the ${action.kind} from your main wallet straight away, at the price at that moment, with no further approval.`
        }${telegram ? " The message goes to your Telegram." : " Telegram is not linked, so the message will only be here in the chat unless you connect it."}${shortfall ? ` Note: ${shortfall}` : ""}`,
      },
    };
  },
};

const getTriggers: CopilotTool = {
  label: "Reading your price triggers",
  declaration: {
    name: "get_price_triggers",
    description:
      "Lists the person's price triggers: those still watching, and recent ones that fired, failed, expired or were cancelled, with what happened. Use it when they ask about their alerts or triggers, or whether one has fired.",
    parameters: { type: "OBJECT", properties: {} },
  },
  async run(_args, ctx) {
    const owner = requireOwner(ctx).toBase58();
    const triggers = (await listTriggers(owner)).slice(0, 12);
    return {
      result: {
        triggers: triggers.map((t) => ({
          id: t.id,
          status: t.status,
          trigger: describeTrigger(t),
          setAt: new Date(t.createdAt).toISOString(),
          ...(t.status === "active" ? { expires: new Date(t.expiresAt).toISOString() } : {}),
          ...(t.repeat ? { runsDone: t.runs ?? 0, ...(t.status === "active" ? { nextCheck: new Date(t.nextAt ?? t.createdAt).toISOString() } : {}) } : {}),
          ...(t.result ? { outcome: t.result } : {}),
        })),
      },
      summary: `${triggers.filter((t) => t.status === "active").length} watching, ${triggers.length} in all`,
      card: { kind: "triggers", triggers },
    };
  },
};

const cancel: CopilotTool = {
  label: "Cancelling the trigger",
  declaration: {
    name: "cancel_price_trigger",
    description:
      "Cancels one of the person's active price triggers by id, straight away. Get the id from get_price_triggers. Cancelling only stops something from happening, so it needs no approval card.",
    parameters: {
      type: "OBJECT",
      properties: { id: { type: "STRING", description: "The trigger id." } },
      required: ["id"],
    },
  },
  async run(args, ctx) {
    const owner = requireOwner(ctx).toBase58();
    const id = String(args.id ?? "");
    const done = await cancelTrigger(owner, id);
    if (!done) throw new ToolError("There is no active trigger with that id. It may have fired, expired or been cancelled already.");
    return {
      result: { cancelled: true, trigger: describeTrigger(done) },
      summary: "trigger cancelled",
      card: { kind: "triggers", triggers: (await listTriggers(owner)).slice(0, 12) },
    };
  },
};

export const TRIGGER_TOOLS: Record<string, CopilotTool> = {
  set_price_trigger: setTrigger,
  get_price_triggers: getTriggers,
  cancel_price_trigger: cancel,
};
