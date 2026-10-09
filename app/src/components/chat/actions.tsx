"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { bpsToPercent, extractProgramError, portfolioPda } from "@/lib/chain";
import { confirmSignature } from "@/lib/confirm";
import { associatedTokenAddress, desk, type PortfolioHoldings } from "@/lib/holdings";
import { walletAddress } from "@/lib/main-wallet";
import { buildProofMessage } from "@/lib/wallet-proof";
import { describeScore, type Score } from "@/lib/autopilot/scorecard";
import { describeEvery, describeTrigger, fireTime, targetPrice, type Trigger } from "@/lib/triggers/rules";
import bs58 from "bs58";
import { createMandateInstructions, setStatusInstruction } from "@/lib/mandate-tx";
import {
  createAssociatedTokenAccountIdempotent,
  transferTokens,
} from "@/lib/token-instructions";
import { useConduitProgram } from "@/hooks/use-conduit-program";
import { actionButton, actionTitle, type Card, type PendingAction, type WalletResultCard } from "@/lib/copilot/events";
import { AssetBadge } from "./cards";

/**
 * The approval step.
 *
 * Every write the copilot can reach arrives here first. Nothing happens because
 * a sentence asked for it; it happens because somebody read a card and pressed
 * a button.
 *
 * What differs is who signs, and the card says so rather than hiding it behind
 * one uniform button. Approving an agent card is a click: the agent's key signs
 * on the server, and the program decides what that key may do. Approving an
 * owner card opens the person's wallet, because those are the steps the agent
 * cannot take: creating or pausing a mandate, opening a main wallet, and moving
 * money out of their own wallet.
 *
 * Main wallet trades, moves into a mandate and withdrawals are agent signed on
 * purpose. The person asked not to sign every trade, and they do not need to:
 * the program only lets the agent send money to the desk at the published
 * price, into the same owner's mandates, or back to the owner.
 */

type Phase =
  | { state: "idle" }
  | { state: "working"; note: string }
  | { state: "failed"; message: string };

type Signer = "agent" | "owner" | "faucet";

type OwnerAction = Extract<
  PendingAction,
  { kind: "create-mandate" | "set-status" | "open-wallet" | "deposit" }
>;
/** Signed as a message, not a transaction: proof of the wallet, nothing moves. */
type MessageAction = Extract<PendingAction, { kind: "link-telegram" | "unlink-telegram" }>;
type ServerAction = Exclude<PendingAction, OwnerAction | MessageAction>;

interface Presentation {
  title: string;
  signer: Signer;
  button: string;
  warning: boolean;
}

const usd = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const tokens = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });

function present(action: PendingAction): Presentation {
  switch (action.kind) {
    case "create-mandate":
      return { title: "Create your mandate", signer: "owner", button: actionButton(action), warning: false };
    case "set-status":
      return {
        title:
          action.status === "closed"
            ? "Close this mandate for good"
            : action.status === "paused"
              ? "Pause this mandate"
              : "Resume this mandate",
        signer: "owner",
        button: actionButton(action),
        warning: action.status === "closed",
      };
    case "submit-rebalance":
      return {
        title: "Rebalance your portfolio",
        signer: "agent",
        button: actionButton(action),
        warning: !action.evaluation.compliant,
      };
    case "settle":
      return { title: "Make the trades", signer: "agent", button: actionButton(action), warning: false };
    case "open-wallet":
      return { title: "Open your main wallet", signer: "owner", button: actionButton(action), warning: false };
    case "demo-cash":
      return { title: "Get test money", signer: "faucet", button: actionButton(action), warning: false };
    case "deposit":
      return {
        title: `Deposit ${usd(action.dollars)} into ${action.destinationLabel}`,
        signer: "owner",
        button: actionButton(action),
        warning: false,
      };
    case "trade":
      return {
        title: action.all
          ? `Sell all ${action.symbol}`
          : `${action.side === "buy" ? "Buy" : "Sell"} ${usd(action.dollars)} of ${action.symbol}`,
        signer: "agent",
        button: actionButton(action),
        warning: false,
      };
    case "fund-mandate":
      return {
        title: `Move ${usd(action.dollars)} into ${action.mandateLabel}`,
        signer: "agent",
        button: actionButton(action),
        warning: false,
      };
    case "withdraw":
      return { title: "Withdraw to your wallet", signer: "agent", button: actionButton(action), warning: false };
    case "autopilot":
      return {
        title: action.on ? `Turn on autopilot for ${action.mandateLabel}` : `Pause autopilot on ${action.mandateLabel}`,
        signer: "agent",
        button: actionButton(action),
        warning: false,
      };
    case "autopilot-run":
      return {
        title: `Run the autopilot on ${action.mandateLabel} now`,
        signer: "agent",
        button: actionButton(action),
        warning: false,
      };
    case "price-trigger":
      return {
        title: triggerTitle(action),
        signer: "agent",
        button: actionButton(action),
        warning: action.action.kind !== "notify",
      };
    case "link-telegram":
      return { title: "Connect Telegram", signer: "owner", button: actionButton(action), warning: false };
    case "unlink-telegram":
      return { title: "Disconnect Telegram", signer: "owner", button: actionButton(action), warning: false };
  }
}

/** Whether a wallet popup is coming, which is what a person wants to know before tapping. */
const SIGNER_LABEL: Record<Signer, string> = {
  agent: "no popup",
  owner: "you'll sign in your wallet",
  faucet: "free test money",
};

/** Alert when it only messages, order when it trades. */
function triggerTitle(action: Extract<PendingAction, { kind: "price-trigger" }>): string {
  const what = action.action.kind === "notify" ? "alert" : "order";
  if (action.repeat) return `Repeating ${what} on ${action.symbol}`;
  return action.condition.kind === "after" ? `Timed ${what} on ${action.symbol}` : `Price ${what} on ${action.symbol}`;
}

function isMessageAction(action: PendingAction): action is MessageAction {
  return action.kind === "link-telegram" || action.kind === "unlink-telegram";
}

function isOwnerAction(action: PendingAction): action is OwnerAction {
  return !isMessageAction(action) && present(action).signer === "owner";
}

async function postJson(route: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

function holding(h: PortfolioHoldings | undefined, symbol: string): number {
  if (!h) return 0;
  if (symbol === "CASH") return h.cash?.uiAmount ?? 0;
  return h.assets.find((a) => a.symbol === symbol)?.uiAmount ?? 0;
}

function resultCard(result: WalletResultCard): Card {
  return { kind: "wallet-result", result };
}

function failure(data: Record<string, unknown>, headline: string): Card {
  const programError = data.programError as { name?: string; message?: string } | null;
  return resultCard({
    ok: false,
    headline,
    detail:
      programError?.message ??
      (data.detail as string | undefined) ??
      (data.error as string | undefined) ??
      "That didn't go through.",
    signature: (data.signature as string | null) ?? null,
    lines: programError?.name ? [{ label: "program error", value: programError.name }] : [],
  });
}

/** The actions a server route signs: the agent's, and the faucet's. */
async function runServerAction(action: ServerAction): Promise<Card> {
  switch (action.kind) {
    case "submit-rebalance": {
      const data = await postJson("/api/agent/rebalance", {
        mandate: action.mandate,
        positions: action.positions.map((p) => ({ mint: p.mint, targetBps: p.targetBps })),
      });
      return {
        kind: "submission",
        submission: {
          accepted: Boolean(data.accepted),
          signature: (data.signature as string) ?? null,
          slot: (data.slot as number) ?? null,
          programError: (data.programError as never) ?? null,
          detail: ((data.detail ?? data.error) as string) ?? null,
        },
      };
    }

    case "settle": {
      const data = await postJson("/api/agent/settle", { mandate: action.mandate });
      return {
        kind: "settlement",
        settlement: {
          settled: Boolean(data.settled),
          signature: (data.signature as string) ?? null,
          slot: (data.slot as number) ?? null,
          before: (data.before as PortfolioHoldings) ?? null,
          after: (data.after as PortfolioHoldings) ?? null,
          programError: (data.programError as never) ?? null,
          detail: ((data.detail ?? data.error) as string) ?? null,
        },
      };
    }

    case "demo-cash": {
      const data = await postJson("/api/faucet", { owner: action.owner });
      if (!data.funded) return failure(data, "No test money was added");
      const sent = Number(data.sent ?? 0);
      return resultCard({
        ok: true,
        headline: sent > 0 ? `Added ${usd(sent)} of test money` : "You're already topped up",
        detail:
          "It's in your own wallet. Move some into your main wallet whenever you want to trade.",
        signature: (data.signature as string) ?? null,
        lines: [{ label: "your wallet", value: usd(Number(data.balance ?? 0)) }],
      });
    }

    case "trade": {
      const data = await postJson("/api/wallet/trade", {
        owner: action.owner,
        side: action.side,
        symbol: action.symbol,
        dollars: action.dollars,
        ...(action.all ? { all: true } : {}),
      });
      if (!data.traded) return failure(data, "The trade did not go through");
      const before = data.before as PortfolioHoldings;
      const after = data.after as PortfolioHoldings;
      return resultCard({
        ok: true,
        headline: `${action.side === "buy" ? "Bought" : "Sold"} ${action.symbol}`,
        detail: `Filled at ${usd(Number(data.price))}, the price on chain.`,
        signature: (data.signature as string) ?? null,
        lines: [
          {
            label: action.symbol,
            value: `${tokens(holding(before, action.symbol))} to ${tokens(holding(after, action.symbol))}`,
          },
          { label: "cash", value: `${usd(holding(before, "CASH"))} to ${usd(holding(after, "CASH"))}` },
        ],
      });
    }

    case "fund-mandate": {
      const data = await postJson("/api/wallet/move", {
        owner: action.owner,
        mandate: action.mandate,
        dollars: action.dollars,
      });
      if (!data.moved) return failure(data, "Nothing moved");
      return resultCard({
        ok: true,
        headline: `Moved ${usd(action.dollars)} into ${action.mandateLabel}`,
        detail: "I'll invest it from here, inside that mandate's rules. Only you can move it back.",
        signature: (data.signature as string) ?? null,
        lines: [
          { label: "main wallet cash", value: usd(Number(data.walletCashAfter ?? 0)) },
          { label: `${action.mandateLabel} cash`, value: usd(Number(data.mandateCashAfter ?? 0)) },
        ],
      });
    }

    case "autopilot": {
      const data = await postJson("/api/autopilot", {
        owner: action.owner,
        mandateId: action.mandateId,
        on: action.on,
        everyMinutes: action.everyMinutes,
        objective: action.objective ?? undefined,
        preIpoCapBps: action.preIpoCapBps ?? undefined,
        brakeBps: action.brakeBps ?? undefined,
      });
      if (!data.ok) return failure(data, "The autopilot didn't change");
      return resultCard({
        ok: true,
        headline: action.on
          ? `Autopilot is on for ${action.mandateLabel}, every ${action.everyMinutes} minutes`
          : `Autopilot paused on ${action.mandateLabel}`,
        detail: action.on
          ? "The first round starts within a minute, and Solana checks every move against your rules. Ask me what I've been up to anytime."
          : "Nothing I did gets undone.",
        signature: null,
        lines: [],
      });
    }

    case "price-trigger": {
      const data = await postJson("/api/triggers", {
        owner: action.owner,
        symbol: action.symbol,
        condition: action.condition,
        action: action.action,
        days: action.days,
        repeat: action.repeat,
      });
      if (!data.ok) return failure(data, "That didn't get set");
      const trigger = data.trigger as Trigger;
      if (trigger.repeat) {
        const { everyMinutes, maxRuns } = trigger.repeat;
        const most = trigger.action.kind === "notify" ? null : trigger.action.dollars * maxRuns;
        return resultCard({
          ok: true,
          headline: `Running ${describeEvery(everyMinutes)} on ${trigger.symbol}`,
          detail: `${describeTrigger(trigger)} First check within a minute. Ask me to cancel it anytime.`,
          signature: null,
          lines: [
            { label: "price now", value: `$${trigger.basePrice.toFixed(2)}` },
            { label: "runs", value: `up to ${maxRuns}` },
            ...(most === null ? [] : [{ label: "most in all", value: `$${most.toFixed(2)}` }]),
          ],
        });
      }
      const due = fireTime(trigger);
      if (due !== null) {
        const when = new Date(due).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
        return resultCard({
          ok: true,
          headline: `Set for ${when}`,
          detail: `${describeTrigger(trigger)} It goes off once, at ${when}, at that moment's price.`,
          signature: null,
          lines: [
            { label: "price now", value: `$${trigger.basePrice.toFixed(2)}` },
            { label: "goes off at", value: when },
          ],
        });
      }
      return resultCard({
        ok: true,
        headline: `Watching ${trigger.symbol}`,
        detail: `${describeTrigger(trigger)} I check every minute until ${new Date(trigger.expiresAt).toLocaleString()}, and it goes off once.`,
        signature: null,
        lines: [
          { label: "price now", value: `$${trigger.basePrice.toFixed(2)}` },
          { label: "goes off at", value: `$${targetPrice(trigger.condition, trigger.basePrice).toFixed(2)}` },
        ],
      });
    }

    case "autopilot-run": {
      const data = await postJson("/api/autopilot/run", {
        owner: action.owner,
        mandateId: action.mandateId,
      });
      const decision = data.decision as
        | {
            outcome: "rebalanced" | "held" | "skipped" | "failed" | "braked";
            summary: string;
            reasoning: string | null;
            positions: { symbol: string; targetBps: number }[];
            signatures: string[];
            preIpo?: string[];
            score?: Score;
          }
        | undefined;
      if (!decision) return failure(data, "That round didn't run");
      const headline = {
        rebalanced: "I rebalanced and made the trades",
        held: "I kept things as they are",
        skipped: "I held back this round",
        failed: "That round didn't finish",
        braked: "The safety brake kicked in and paused me",
      }[decision.outcome];
      return resultCard({
        ok: decision.outcome !== "failed",
        headline,
        detail: [
          decision.summary,
          decision.preIpo?.length ? `Pre-IPO: ${decision.preIpo.join(" ")}` : null,
          decision.score ? `Scorecard: ${describeScore(decision.score)}` : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
        signature: decision.signatures[decision.signatures.length - 1] ?? null,
        lines: decision.positions.map((p) => ({
          label: p.symbol,
          value: bpsToPercent(p.targetBps),
        })),
      });
    }

    case "withdraw": {
      const data = await postJson("/api/wallet/withdraw", {
        owner: action.owner,
        mandate: action.mandate ?? undefined,
        symbol: action.symbol,
        amount: action.amount ?? undefined,
        all: action.all,
      });
      if (!data.withdrawn) return failure(data, "Nothing was withdrawn");
      const amount = Number(data.amount ?? 0);
      const what = action.symbol === "CASH" ? usd(amount) : `${tokens(amount)} ${action.symbol}`;
      return resultCard({
        ok: true,
        headline: `Sent ${what} back to your wallet`,
        detail: `From ${data.from === "mandate" ? "the mandate" : "your main wallet"}. Money can only ever be sent back to you.`,
        signature: (data.signature as string) ?? null,
        lines: [
          {
            label: "your wallet cash",
            value: usd(holding(data.personalAfter as PortfolioHoldings, "CASH")),
          },
        ],
      });
    }
  }
}

/**
 * What the copilot is told once a card is done.
 *
 * Sent as an event rather than as something the person typed, so the copilot
 * can say what happened and what comes next. That is the difference between an
 * approval that ends the conversation and one that moves it forward.
 */
function outcomeMessage(action: PendingAction, card: Card): string {
  const title = actionTitle(action);

  if (card.kind === "wallet-result") {
    const r = card.result;
    const lines = r.lines.map((l) => `${l.label}: ${l.value}`).join("; ");
    // A deposit made to fund another request says what that request was, so
    // the copilot carries on with it rather than asking a second time.
    const next =
      action.kind === "deposit" && action.then
        ? r.ok
          ? ` This deposit was the funding step for another request. Prepare the card for ${action.then} now, straight away and without asking. That request is not done: it only happens when they approve its card too.`
          : ` The request it was funding, ${action.then}, is still waiting.`
        : "";
    return `[Card result] ${title}: ${r.ok ? "done" : "failed"}. ${r.headline}.${r.detail ? ` ${r.detail}` : ""}${lines ? ` (${lines})` : ""}${next}`;
  }
  if (card.kind === "submission") {
    const s = card.submission;
    return s.accepted
      ? `[Card result] ${title}: accepted on chain.`
      : `[Card result] ${title}: refused${s.programError ? ` by the program with ${s.programError.name}, ${s.programError.message}` : ""}.${s.detail ? ` ${s.detail}` : ""}`;
  }
  if (card.kind === "settlement") {
    const s = card.settlement;
    return s.settled
      ? `[Card result] ${title}: settled, real tokens moved.`
      : `[Card result] ${title}: not settled. ${s.programError?.message ?? s.detail ?? ""}`.trim();
  }
  return `[Card result] ${title}: done.`;
}

export function ActionCard({
  action,
  onResolved,
}: {
  action: PendingAction;
  /** The outcome to keep, and the message to send the copilot. Both null when dismissed. */
  onResolved: (outcome: Card | null, message: string | null) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signMessage } = useWallet();
  const program = useConduitProgram();

  const view = present(action);

  /** What the owner signs, for the steps only they can take. */
  async function ownerInstructions(
    owned: OwnerAction,
    owner: PublicKey,
  ): Promise<TransactionInstruction[]> {
    const cashMint = new PublicKey(desk.cashMint);

    switch (owned.kind) {
      case "create-mandate":
        return (await createMandateInstructions(program!, owner, owned.draft)).instructions;

      case "set-status":
        return [
          await setStatusInstruction(program!, owner, new PublicKey(owned.mandate), owned.status),
        ];

      case "open-wallet": {
        const wallet = walletAddress(owner);
        return [
          await program!.methods
            .openWallet(new PublicKey(owned.agent))
            .accountsStrict({ wallet, owner, systemProgram: SystemProgram.programId })
            .instruction(),
          // Its cash account, so the first deposit has somewhere to land.
          createAssociatedTokenAccountIdempotent(
            owner,
            associatedTokenAddress(wallet, cashMint),
            wallet,
            cashMint,
          ),
        ];
      }

      case "deposit": {
        const holder = owned.mandate
          ? portfolioPda(new PublicKey(owned.mandate))
          : walletAddress(owner);
        const destination = associatedTokenAddress(holder, cashMint);
        const amount = BigInt(Math.floor(owned.dollars * 10 ** desk.cashDecimals));
        return [
          createAssociatedTokenAccountIdempotent(owner, destination, holder, cashMint),
          transferTokens(associatedTokenAddress(owner, cashMint), destination, owner, amount),
        ];
      }
    }
  }

  function ownerResult(
    owned: OwnerAction,
    signature: string,
    outcome: Awaited<ReturnType<typeof confirmSignature>>,
  ): Card {
    const confirmed = outcome.status === "confirmed";

    if (confirmed && owned.kind === "open-wallet") {
      return resultCard({
        ok: true,
        headline: "Your main wallet is open",
        detail: "From now on I can trade for you with no popups. Move some money in whenever you're ready.",
        signature,
        lines: [],
      });
    }
    if (confirmed && owned.kind === "deposit") {
      return resultCard({
        ok: true,
        headline: `Deposited ${usd(owned.dollars)} into ${owned.destinationLabel}`,
        detail: null,
        signature,
        lines: [],
      });
    }

    return {
      kind: "submission",
      submission: {
        accepted: confirmed,
        signature,
        slot: confirmed ? outcome.slot : null,
        programError: outcome.status === "failed" ? extractProgramError(outcome.error) : null,
        detail:
          outcome.status === "expired"
            ? "It timed out before it landed, so nothing happened. Give it another go."
            : outcome.status === "unknown"
              ? "No answer yet. It may still land, so check the explorer link before trying again."
              : null,
      },
    };
  }

  /** Signs a proof message with the wallet and hands it to the server. */
  async function runMessageAction(messageAction: MessageAction): Promise<Card> {
    if (!publicKey) throw new Error("Connect a wallet first. Only you can sign this.");
    if (!signMessage) throw new Error("This wallet can't sign messages, so it can't prove it's yours here.");

    const owner = publicKey.toBase58();
    const purpose = messageAction.kind;
    const message = buildProofMessage(purpose, owner);
    const signed = await signMessage(new TextEncoder().encode(message));
    const body = { owner, message, signature: bs58.encode(signed) };

    if (purpose === "link-telegram") {
      const data = await postJson("/api/telegram/link", body);
      if (!data.link) return failure(data, "Telegram was not linked");
      return resultCard({
        ok: true,
        headline: "One more step: open Telegram and tap Start",
        detail: `The link works once and expires in ${Number(data.expiresInMinutes ?? 10)} minutes. When you tap Start, the bot tells you which wallet it's linked to.`,
        signature: null,
        lines: [],
        link: { label: "Open in Telegram", href: String(data.link) },
      });
    }

    const data = await postJson("/api/telegram/unlink", body);
    if (data.error) return failure(data, "Telegram was not disconnected");
    return resultCard({
      ok: true,
      headline: data.unlinked ? "Telegram disconnected" : "No Telegram chat was linked",
      detail: data.unlinked ? "No more updates will go there." : null,
      signature: null,
      lines: [],
    });
  }

  async function approve() {
    try {
      if (isMessageAction(action)) {
        setPhase({ state: "working", note: "Check your wallet" });
        const card = await runMessageAction(action);
        onResolved(card, outcomeMessage(action, card));
        return;
      }

      if (!isOwnerAction(action)) {
        setPhase({
          state: "working",
          note: view.signer === "faucet" ? "Getting test money" : "On it",
        });
        const card = await runServerAction(action);
        onResolved(card, outcomeMessage(action, card));
        return;
      }

      // Owner signed: the connected wallet, not a route.
      if (!program || !publicKey) {
        setPhase({ state: "failed", message: "Connect a wallet first. Only you can sign this." });
        return;
      }

      setPhase({ state: "working", note: "Check your wallet" });

      const instructions = await ownerInstructions(action, publicKey);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const transaction = new Transaction({
        feePayer: publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...instructions);

      const signature = await sendTransaction(transaction, connection);
      setPhase({ state: "working", note: "Confirming" });

      const outcome = await confirmSignature(connection, signature, { lastValidBlockHeight });
      const card = ownerResult(action, signature, outcome);
      onResolved(card, outcomeMessage(action, card));
    } catch (error) {
      const programError = extractProgramError(error);
      setPhase({
        state: "failed",
        message: programError?.message ?? (error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border ${
        view.warning ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-white/5 px-4 py-2.5">
        <span className="text-[11px] uppercase tracking-wider text-zinc-400">{view.title}</span>
        <span className="font-mono text-[11px] text-zinc-500">{SIGNER_LABEL[view.signer]}</span>
      </div>

      <p className="px-4 py-3 text-sm leading-relaxed text-zinc-300">{action.summary}</p>

      {action.kind === "submit-rebalance" ? (
        <div className="border-t border-white/5 px-4 py-2.5">
          {action.positions.map((p) => (
            <div key={p.mint} className="flex items-center justify-between gap-3 py-1">
              <AssetBadge symbol={p.symbol} />
              <span className="flex items-baseline gap-2 font-mono text-sm">
                {p.currentBps !== p.targetBps ? (
                  <span className="text-[11px] text-zinc-600">{bpsToPercent(p.currentBps)} to</span>
                ) : null}
                <span className="text-zinc-100">{bpsToPercent(p.targetBps)}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {action.kind === "trade" ? <TradeDetail action={action} /> : null}

      {phase.state === "failed" ? (
        <p className="border-t border-white/5 px-4 py-2.5 text-sm text-red-300">{phase.message}</p>
      ) : null}

      <div className="flex items-center gap-2 border-t border-white/5 px-4 py-2.5">
        <button
          type="button"
          onClick={() => void approve()}
          disabled={phase.state === "working"}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-wait disabled:opacity-60 ${
            view.warning
              ? "bg-amber-500 text-black hover:bg-amber-400"
              : "bg-emerald-500 text-black hover:bg-emerald-400"
          }`}
        >
          {phase.state === "working" ? phase.note : view.button}
        </button>
        <button
          type="button"
          onClick={() => onResolved(null, null)}
          disabled={phase.state === "working"}
          className="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/**
 * What a main wallet trade will do, in the terms it was asked in.
 *
 * Dollars first, the tokens they buy at the preview price beside them, and
 * where the price came from and how old it is, since the program reads that
 * same account when it runs the trade.
 */
/** The publisher's lowercase source tag, as the name a person knows it by. */
function sourceName(source: string): string {
  const known: Record<string, string> = { jupiter: "Jupiter", prestocks: "PreStocks", coinbase: "Coinbase", pyth: "Pyth" };
  return known[source.toLowerCase()] ?? source;
}

function TradeDetail({ action }: { action: Extract<PendingAction, { kind: "trade" }> }) {
  const minutes = Math.max(1, Math.round(action.priceAgeSeconds / 60));
  return (
    <div className="border-t border-white/5 px-4 py-2.5">
      <div className="flex items-center justify-between gap-3 py-1">
        <AssetBadge symbol={action.symbol} />
        <span className="font-mono text-sm text-zinc-100">
          {action.side === "buy" ? "+" : "-"}
          {tokens(action.tokens)}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3 py-1 text-[11px] text-zinc-500">
        <span>cash left after</span>
        <span className="font-mono">{usd(action.cashAfter)}</span>
      </div>
      <p className="pt-1 text-[11px] leading-relaxed text-zinc-600">
        Price from {sourceName(action.priceSource)}, updated {minutes} min ago. It is set on chain, so
        neither of us picks it.
      </p>
    </div>
  );
}
