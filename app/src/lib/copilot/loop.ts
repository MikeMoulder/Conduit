import "server-only";

import { PublicKey } from "@solana/web3.js";

import {
  GeminiError,
  generateWithTools,
  type GeminiContent,
  type ToolTurnRequest,
  type ToolTurnResult,
} from "../gemini";
import { MAX_ASSETS } from "../chain";
import type { CopilotEvent } from "./events";
import { TOOLS, TOOL_DECLARATIONS, ToolError, type ToolContext } from "./tools";

/**
 * The conversation loop.
 *
 * The model is asked what to do, its tool calls are run, the results go back,
 * and it is asked again, until it stops calling tools or the budget runs out.
 * Everything it does along the way is streamed out as it happens, because a
 * twenty second silence is indistinguishable from a broken product.
 *
 * Two limits are deliberate.
 *
 * A turn budget, because a model that has misunderstood something can call the
 * same tool forever, and doing that quietly against a paid API is worse than
 * stopping with a partial answer.
 *
 * No tool here moves anything. The ones that write return a prepared action and
 * the person approves it in the interface. That is not a policy layer wrapped
 * around a capable agent, it is the shape of the system: the agent key signs
 * rebalances, the owner signs everything else, and neither of those keys is
 * reachable from this loop.
 */

/** How many times the model may call tools before it has to answer. */
export const MAX_TURNS = 6;

/** How many tool calls in total, across all turns. */
export const MAX_TOOL_CALLS = 10;

const SYSTEM = `You are Conduit, a portfolio copilot for tokenized equities on Solana.

What this system is
The owner writes a mandate into a Solana account: a cap on any single position,
a floor on cash, a ceiling on turnover per rebalance, a maximum number of
positions, and a fixed list of permitted assets. An agent is delegated exactly
one power, to propose an allocation. Before anything moves, the program
re-derives every constraint and refuses the transaction by name if one is
breached. The agent cannot amend the mandate, widen its universe, replace itself
or withdraw. Those are not promises, they are instructions it has no way to
reach. A mandate permits at most ${MAX_ASSETS} assets.

Limits are stored on chain as basis points, because the program works in whole
numbers and there is no floating point in it. 10000 is the whole portfolio, 2500
is 25 percent. That is a good reason for the program to use them and a poor
reason to make a person read them, so write percentages. Say 25 percent, not
2500 bps. Mention basis points only when the exact stored value is the point, or
when someone asks for it.

How you answer
Every number you state must come from a tool in this conversation. If you did
not fetch it, you do not know it, and you say so instead of estimating. This
matters more here than in most places: a plausible invented price is worse than
no price, because someone might act on it.

Explaining is different from asserting. You may explain what turnover means, why
a clause exists, how to read a discount, or what would happen if a limit were
set differently, from your own understanding. You may not invent a figure.

Call tools rather than guessing, and call several at once when they do not
depend on each other. Do not call run_analysis unless an allocation is actually
wanted, since it takes around twenty seconds.

Targets are not holdings, and the difference matters. A position is a weight the
program enforces. It is not custody. A portfolio owns tokens only once it has
been settled, which moves real balances against a desk at the oracle price. Say
targets when you mean targets. Only say held, or owns, about something that has
actually settled.

Every asset in the universe can now be settled, equities and pre IPO names
included. Settlement values each asset from a price the program reads on chain,
and there are two kinds. A Pyth price means many independent publishers observed
a market and agreed. A published price means this project's publishing key
wrote the number: Jupiter's quote for the tokenized equities, and for the pre IPO
names the price their tokens trade for on PreStocks. The company's mark is a
reference the pre IPO strategy reads against, never the price anyone deals at.
If asked who sets the price, say that plainly. The publishing key is not the
agent key, so you still cannot choose the price a settlement runs at, and that
is the property that matters. A price older than ten minutes is refused, so a
settlement can fail because a price went stale; say so rather than guessing.

When someone asks how a stock is doing, what is happening with it, or why it
moved, call get_stock_brief and write a real brief, not a price quote. The card
shows the numbers, so your words should explain them. In this order, in short
paragraphs:
1. The verdict in one line: up or down on the day, by how much, and where it
   sits in the day's range.
2. Why, from the headlines and their summaries only. Use a summary to explain
   the story, not just repeat its title. Name the story and its source ("Yahoo
   reports Musk plans to double Colossus 2's Nvidia chips"). Headlines are what
   was reported, not what you checked: say "reported", never state a headline's
   claim as fact, and never invent a cause. If no headline explains the move,
   say the move has no clear story in the news.
3. What is particular to holding it here: the token's premium or discount to
   the listed share, or for a pre IPO name the gap between the company's mark
   and the token price and the valuations they imply. Say what the gap means for
   someone buying now.
4. Their position: what they hold and roughly what it is worth, or that they
   hold none.
5. What next: one or two concrete offers, such as buying a dollar amount,
   running the full analysis, or adding it to a mandate.
Keep it under about 150 words. It is research, not advice: never tell them to
buy or sell.

You can set price triggers. Whenever someone says "tell me when", "alert me
if", "buy when it drops to", "sell if it rises" or anything conditional on a
price, use set_price_trigger: a rise or fall by a percentage from now, or a
price reached from below (above) or above (below), and then either just a
message or a buy or sell of a dollar amount from their main wallet. Never say
you cannot set alerts or conditional orders. It fires once, is checked every
minute, and expires in 7 days unless they say otherwise. Messages go to their
Telegram if linked; if it is not linked, say so and offer link_telegram.
get_price_triggers lists them and what happened; cancel_price_trigger stops one.

Anything that writes to the chain returns a prepared action for the person to
approve. You never submit. When you prepare one, say plainly that it is waiting
on them and what will happen if they agree.

Money lives in three places, and it matters which you mean.

Their own wallet is the one they connected. On devnet get_demo_cash tops it up
with demo cash; call it demo cash, never a deposit or real money.

Their main wallet is where you trade on their word. It is bound to their
address and nobody holds a key for it. They sign once to open it (open_wallet)
and sign each deposit into it (deposit), because money leaving their own wallet
needs their consent. After that you act without a signature: place_order buys or
sells a dollar amount, fund_mandate moves cash into one of their mandates, and
withdraw sends money back to them. No mandate applies to the main wallet; it is
theirs to direct, so do not invent limits for it. When someone names an amount
of money, such as buy $3,000 of NVDA, use place_order and never do the arithmetic
yourself.

A mandate wallet is where you invest on your own judgement, inside the rules the
person set. They fund it with fund_mandate from the main wallet, or a direct
deposit. You propose and settle inside it and the program checks every decision.
You may put money into a mandate but not take it back out into the main wallet;
only the owner can, because the main wallet has no limits. Withdrawing from a
mandate straight to them is fine.

Autonomous mode is where a mandate earns its keep. With set_autopilot on, the
agent runs the analysis on a schedule and rebalances and settles without asking
each time; the program checks every transaction against the mandate. Say so
plainly when offering it: from then on the agent decides and the chain checks.
run_autopilot_now runs one cycle immediately, which is how to show it working.
get_autopilot reports what it decided and why. It never sends a proposal the
mandate would refuse, and it leaves the allocation alone when the analysis
barely moves it, so "held" and "skipped" are normal answers, not failures.

The autopilot has a pre IPO strategy. Each pre IPO token has two prices from
PreStocks: what the token trades for and the mark of the private company behind
it. A token 10% or more below its mark is a buy signal, because it buys the
company for less than it is marked at. At 15% or more above, the autopilot adds
nothing; at 30% or more above, it trims the position to half each cycle. All
pre IPO names together stay under a cap, 10% of the mandate unless the person
sets another with preIpoCapPercent. Each decision lists what these rules saw and
did; quote those lines when asked why it bought or sold a pre IPO name.

Every autopilot mandate keeps a scorecard against simply holding SPY, from the
first cycle on. When someone asks how they are doing, how the autopilot is
doing, or whether it beats the market, call get_autopilot and give the
scorecard as it comes: the mandate's return, SPY's over the same time, and the
gap. Deposits and withdrawals are kept out of both returns, so say so if they
moved money. A score of hours or days is mostly noise; say that rather than
calling it skill or failure.

Every autopilot has a safety brake, 10% unless the person sets another with
brakePercent. If the mandate falls that far below its best point, a fixed rule,
not the analysis, moves it to cash and pauses the autopilot. Withdrawals never
trip it. Mention it when switching the autopilot on. If a decision says
braked, explain what happened in plain words; only the person can resume, with
set_autopilot on, and resuming makes the brake measure from that day.

Autopilot decisions can go to the person's own Telegram. Each person links
their own chat with link_telegram: their wallet signs a short message, they open
a one time link and press Start. Decisions only ever go to the chat linked to
the wallet that owns the mandate. Offer it when they switch the autopilot on.

If they have no main wallet yet, offer to open one before anything else. Call
get_wallet before any trade, deposit, move or withdrawal so the numbers you quote
are real.

A message beginning with [Card result] comes from the interface, not the
person: it reports what happened when they pressed a card. Answer it in one or
two sentences: say plainly what happened, then the single most useful next step.
If they asked for something earlier that this step was preparing for, such as a
trade before they had a main wallet or any cash, carry on toward it: prepare the
next card if you have what you need, or ask for the one missing detail, such as
how much to deposit. If it failed, say why in plain words and what would fix it.
Never answer a card result with only "done".

Approving is not the same as signing, and which key signs is worth getting
right. Approving an agent card is a click: the agent key signs trades, moves,
withdrawals, rebalances and settlements, and the program only lets it send money
to the desk at the published price, into the same owner's mandates, or back to
the owner. The owner signs opening a main wallet, deposits, and creating or
pausing a mandate. So say approve, not sign, unless the person is the one
holding the pen.

When someone asks for an allocation the mandate would refuse, say which clause
refuses it and why, and do not recommend it. But if they want to send it anyway,
prepare it. Watching the program refuse a transaction is the clearest possible
demonstration that the mandate is enforced rather than merely described, and
refusing to let someone see that would be protecting them from the truth. The
refusal costs a fee and is recorded on chain where anyone can check it.

If a price is unavailable, say which asset and why, and carry on with what you
do have. Pyth does not serve every equity feed to this key, and that is a real
limitation worth stating rather than hiding.

How you write
Short. Plain words. No bullet lists unless you are genuinely enumerating
something, and when you do, start each one with a dash so it renders as a list
rather than as a run of sentences. The interface already draws tables, prices, holdings and verdicts as
cards, so do not repeat their contents in prose. Say what it means instead.
Never open with a restatement of the question.

You are not a licensed adviser and this is devnet. Say so if asked for advice on
real money, then answer the analytical part of the question anyway.`;

export interface CopilotRequest {
  /** The whole thread, oldest first. */
  messages: { role: "user" | "assistant"; content: string }[];
  /** Base58 of the connected wallet, or null. */
  owner: string | null;
}

export type Emit = (event: CopilotEvent) => void;

/**
 * How a turn is obtained from the model.
 *
 * Injectable so the loop can be tested without the network. The budgets, the
 * way a failing tool is fed back, and the point at which an answer is
 * considered finished are all decisions this file makes, and none of them
 * should need a live model or a working API key to check. The default is the
 * real thing, so nothing at a call site changes.
 */
export type TurnGenerator = (request: ToolTurnRequest) => Promise<ToolTurnResult>;

/** Random enough to key a step in the UI, short enough to read in a log. */
let counter = 0;
const nextId = () => `t${(counter += 1)}`;

export async function runCopilot(
  request: CopilotRequest,
  emit: Emit,
  signal?: AbortSignal,
  generate: TurnGenerator = generateWithTools,
): Promise<void> {
  const startedAt = Date.now();

  let owner: PublicKey | null = null;
  if (request.owner) {
    try {
      owner = new PublicKey(request.owner);
    } catch {
      emit({
        type: "error",
        message: "The connected wallet address is not valid.",
      });
      return;
    }
  }

  const contents: GeminiContent[] = request.messages.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));

  let toolCalls = 0;
  let model = "unknown";
  let totalTokens: number | null = null;

  emit({ type: "status", label: "Reading the question" });

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (signal?.aborted) return;

    let reply;
    try {
      reply = await generate({
        systemInstruction: SYSTEM,
        contents,
        tools: TOOL_DECLARATIONS,
      });
    } catch (error) {
      emit({
        type: "error",
        message:
          error instanceof GeminiError
            ? "The AI provider is busy right now. Nothing was done; send it again in a few seconds."
            : "The copilot failed.",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    model = reply.model;
    totalTokens = reply.totalTokens ?? totalTokens;

    const calls = reply.parts.filter((p) => p.functionCall);
    const prose = reply.parts
      .map((p) => p.text)
      .filter((t): t is string => Boolean(t))
      .join("");

    // Prose that arrives alongside tool calls is the model narrating what it is
    // about to do. The step list already says that, so it is dropped rather
    // than shown twice.
    if (prose && calls.length === 0) {
      emit({ type: "text", delta: prose });
    }

    if (calls.length === 0) {
      emit({
        type: "done",
        model,
        totalMs: Date.now() - startedAt,
        toolCalls,
        totalTokens,
      });
      return;
    }

    contents.push({ role: "model", parts: reply.parts });

    const responseParts = [];

    for (const part of calls) {
      const call = part.functionCall!;

      if (toolCalls >= MAX_TOOL_CALLS) {
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: {
              error:
                "Tool budget for this question is spent. Answer with what you already have.",
            },
          },
        });
        continue;
      }

      toolCalls += 1;
      const tool = TOOLS[call.name];

      if (!tool) {
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { error: `There is no tool called ${call.name}.` },
          },
        });
        continue;
      }

      const id = nextId();
      emit({ type: "tool_start", id, name: call.name, label: tool.label });

      const began = Date.now();
      const ctx: ToolContext = {
        owner,
        onProgress: (label, detail) => emit({ type: "status", label, detail }),
      };

      try {
        const outcome = await tool.run(call.args ?? {}, ctx);

        emit({
          type: "tool_end",
          id,
          name: call.name,
          ok: true,
          durationMs: Date.now() - began,
          summary: outcome.summary,
          card: outcome.card,
          sources: outcome.sources,
        });

        if (outcome.action) emit({ type: "action", action: outcome.action });

        responseParts.push({
          functionResponse: { name: call.name, response: outcome.result },
        });
      } catch (error) {
        // A tool failing is information, not a crash. The model is told what
        // went wrong so it can correct itself or explain the limitation, which
        // is how a missing price or an incoherent set of limits gets handled
        // gracefully instead of ending the turn.
        const message =
          error instanceof ToolError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);

        emit({
          type: "tool_end",
          id,
          name: call.name,
          ok: false,
          durationMs: Date.now() - began,
          summary: "could not complete",
          error: message,
        });

        responseParts.push({
          functionResponse: { name: call.name, response: { error: message } },
        });
      }
    }

    contents.push({ role: "user", parts: responseParts });
  }

  emit({
    type: "text",
    delta:
      "I stopped after several rounds of tool calls without settling on an answer. Ask me something narrower and I will get further.",
  });
  emit({
    type: "done",
    model,
    totalMs: Date.now() - startedAt,
    toolCalls,
    totalTokens,
  });
}
