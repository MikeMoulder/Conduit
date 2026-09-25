import type { MandateView, PortfolioView } from "../accounts";
import type { ActivityRecord } from "../events";
import type { ProposalEvaluation } from "../proposal";
import type { AutopilotEntry, Decision } from "../autopilot/state";
import type { PortfolioHoldings } from "../holdings";

/**
 * What the copilot sends to the browser while it works, and what the browser
 * is able to draw.
 *
 * Shared on purpose. The server can only emit a card the client already knows
 * how to render, so a tool that starts returning a new shape fails at the type
 * level here rather than silently rendering as nothing in a conversation.
 *
 * The events are deliberately close to what Orion shows: a running list of
 * steps with timings, structured results rather than prose, and a record of
 * where every number came from. The reason is the same in both products. An
 * assistant that reports a figure without saying where it got it is asking to
 * be trusted, and this one should not be trusted, it should be checkable.
 */

/** A number on screen, and the thing that produced it. */
export interface Source {
  /** `pyth`, `prestocks`, `solana`, or `gemini` for a judgement rather than a fact. */
  provider: string;
  detail: string;
  /** False when the provider was unreachable and the answer worked around it. */
  ok: boolean;
}

export type Card =
  | { kind: "universe"; assets: UniverseRow[] }
  | { kind: "prices"; rows: PriceRow[] }
  | { kind: "mandate"; mandate: MandateView }
  | {
      kind: "portfolio";
      portfolio: PortfolioView;
      /** Present so weights can be shown against the limits that bind them. */
      mandate: MandateView | null;
      /**
       * What is actually held, where the mandate can be settled.
       *
       * Separate from the positions above because they are different claims.
       * A position is a target the program will enforce. A holding is a token
       * account balance. Showing one and calling it the other was wrong, and
       * this field is how the card can stop doing that.
       */
      holdings: PortfolioHoldings | null;
    }
  | { kind: "history"; records: ActivityRecord[] }
  | { kind: "analysis"; analysis: AnalysisCard }
  | { kind: "verdict"; evaluation: ProposalEvaluation; positions: WeightRow[] }
  | { kind: "submission"; submission: SubmissionCard }
  | { kind: "settlement"; settlement: SettlementCard }
  | { kind: "wallet"; wallet: WalletCard }
  | { kind: "wallet-result"; result: WalletResultCard }
  | { kind: "autopilot"; entries: AutopilotEntry[]; decisions: Decision[] };

export interface UniverseRow {
  symbol: string;
  name: string;
  assetClass: string;
  priceSource: string;
  mint: string;
  /** How valuation is bound. Absent when no Pyth feed exists for it. */
  feed: string | null;
}

export interface PriceRow {
  symbol: string;
  name: string;
  price: number | null;
  referencePrice: number | null;
  spreadBps: number | null;
  priceSource: string;
  /** Why there is no price, when there is none. */
  unavailable: string | null;
}

export interface WeightRow {
  symbol: string;
  mint: string;
  targetBps: number;
  /** The target this replaces, so a proposal reads as a change, not a list. */
  currentBps: number;
}

export interface AnalysisCard {
  positions: {
    symbol: string;
    mint: string;
    targetBps: number;
    currentBps: number;
    thesis: string;
    thesisBreakers: string[];
    /**
     * The market the thesis was formed against.
     *
     * Carried because a weight on its own is an assertion. The price it was
     * chosen at, and the gap to the instrument it tracks, are what make the
     * reasoning checkable rather than something to be taken on faith.
     */
    price: number | null;
    referencePrice: number | null;
    spreadBps: number | null;
  }[];
  reasoning: string;
  confidence: number;
  marketSummary: string;
  bull: { symbol: string; argument: string; weight: number }[];
  bear: { symbol: string; argument: string; weight: number }[];
  riskConcerns: string[];
  riskCeilings: { symbol: string; maxRecommendedBps: number; concern: string }[];
  stages: { stage: string; model: string; durationMs: number }[];
  evaluation: ProposalEvaluation;
  excludedForMissingPrice: string[];
}

export interface WalletLine {
  symbol: string;
  /** Whole tokens. */
  amount: number;
  /** Dollars at the settlement price, null when there is no fresh price. */
  value: number | null;
}

/** A person's main wallet, and the cash still in their own wallet. */
export interface WalletCard {
  opened: boolean;
  address: string | null;
  cash: number;
  holdings: WalletLine[];
  /** Cash plus every holding that has a price. */
  total: number;
  /** Demo cash sitting in the connected wallet, not yet deposited. */
  ownCash: number;
}

/**
 * The outcome of anything done to a wallet: a deposit, a trade, a move into a
 * mandate, a withdrawal. One shape for all of them, because what a person needs
 * to see is the same each time: did it happen, what changed, and the proof.
 */
export interface WalletResultCard {
  ok: boolean;
  headline: string;
  detail: string | null;
  signature: string | null;
  lines: { label: string; value: string }[];
  /** A next step that is a place to go, such as opening Telegram. */
  link?: { label: string; href: string } | null;
}

export interface SettlementCard {
  settled: boolean;
  signature: string | null;
  slot: number | null;
  /** Balances either side of the transfer, so the change is visible. */
  before: PortfolioHoldings | null;
  after: PortfolioHoldings | null;
  programError: { code: number; name: string; message: string } | null;
  detail: string | null;
}

export interface SubmissionCard {
  accepted: boolean;
  signature: string | null;
  slot: number | null;
  programError: { code: number; name: string; message: string } | null;
  detail: string | null;
}

/**
 * Something the copilot wants to do that it is not allowed to do by itself.
 *
 * Every write surfaces as one of these. The model proposes, a card appears, and
 * nothing happens until the person presses the button. That is not a safety
 * decoration bolted onto a chat window: it is the same separation the program
 * enforces, finally visible in the interface.
 */
export type PendingAction =
  | {
      kind: "create-mandate";
      /** Signed by the owner in the browser, because only the owner may create one. */
      draft: {
        mandateId: number;
        maxPositionBps: number;
        minCashBps: number;
        maxTurnoverBps: number;
        maxAssets: number;
        symbols: string[];
        agent: string;
      };
      summary: string;
    }
  | {
      kind: "submit-rebalance";
      /** Signed by the agent on the server once approved. */
      mandate: string;
      positions: WeightRow[];
      evaluation: ProposalEvaluation;
      summary: string;
    }
  | {
      kind: "set-status";
      mandate: string;
      status: "active" | "paused" | "closed";
      summary: string;
    }
  | {
      kind: "open-wallet";
      /** The one signature for convenience. Signed by the person's wallet. */
      agent: string;
      summary: string;
    }
  | {
      kind: "demo-cash";
      /** Paid by the devnet faucet into the person's own wallet. */
      owner: string;
      summary: string;
    }
  | {
      kind: "deposit";
      /** Signed by the person's wallet: money leaving it needs their consent. */
      mandate: string | null;
      destinationLabel: string;
      dollars: number;
      summary: string;
    }
  | {
      kind: "trade";
      /** Signed by the agent. The program fixes the price and the destination. */
      owner: string;
      side: "buy" | "sell";
      symbol: string;
      dollars: number;
      price: number;
      priceSource: string;
      priceAgeSeconds: number;
      /** Whole tokens the dollars buy or sell at the preview price. */
      tokens: number;
      cashAfter: number;
      summary: string;
    }
  | {
      kind: "fund-mandate";
      /** Signed by the agent, from the main wallet into the same owner's mandate. */
      owner: string;
      mandate: string;
      mandateLabel: string;
      dollars: number;
      summary: string;
    }
  | {
      kind: "withdraw";
      /** Signed by the agent. The program only lets it reach the owner. */
      owner: string;
      mandate: string | null;
      symbol: string;
      amount: number | null;
      all: boolean;
      summary: string;
    }
  | {
      kind: "autopilot";
      /** Recorded on the server once approved. No signature: see the route. */
      owner: string;
      mandateId: number;
      mandateLabel: string;
      on: boolean;
      everyMinutes: number;
      objective: string | null;
      /** Null keeps the one already set, or the default for a new entry. */
      preIpoCapBps: number | null;
      summary: string;
    }
  | {
      kind: "link-telegram" | "unlink-telegram";
      /** Proven by a message the wallet signs. Not a transaction. */
      owner: string;
      summary: string;
    }
  | {
      kind: "autopilot-run";
      /** One cycle now, signed by the agent inside the mandate. */
      owner: string;
      mandateId: number;
      mandateLabel: string;
      summary: string;
    }
  | {
      kind: "settle";
      /** Signed by the agent on the server once approved. */
      mandate: string;
      summary: string;
    };

/** A short name for an action, for places that cannot show the whole card. */
export function actionTitle(action: PendingAction): string {
  switch (action.kind) {
    case "create-mandate":
      return "Create a mandate";
    case "set-status":
      return `Set the mandate to ${action.status}`;
    case "submit-rebalance":
      return "Submit a rebalance";
    case "settle":
      return "Settle the portfolio";
    case "open-wallet":
      return "Open your main wallet";
    case "demo-cash":
      return "Add demo cash";
    case "deposit":
      return `Deposit $${action.dollars.toLocaleString()} into ${action.destinationLabel}`;
    case "trade":
      return `${action.side === "buy" ? "Buy" : "Sell"} $${action.dollars.toLocaleString()} of ${action.symbol}`;
    case "fund-mandate":
      return `Move $${action.dollars.toLocaleString()} into ${action.mandateLabel}`;
    case "withdraw":
      return "Withdraw to your wallet";
    case "autopilot":
      return action.on
        ? `Run ${action.mandateLabel} on its own every ${action.everyMinutes} minutes`
        : `Stop the autopilot on ${action.mandateLabel}`;
    case "autopilot-run":
      return `Run one autopilot cycle on ${action.mandateLabel}`;
    case "link-telegram":
      return "Connect Telegram";
    case "unlink-telegram":
      return "Disconnect Telegram";
  }
}

export type CopilotEvent =
  /** A line in the running step list, before any tool is known. */
  | { type: "status"; label: string; detail?: string }
  | { type: "tool_start"; id: string; name: string; label: string }
  | {
      type: "tool_end";
      id: string;
      name: string;
      ok: boolean;
      durationMs: number;
      /** One line for the step list, whether or not a card follows. */
      summary: string;
      card?: Card;
      sources?: Source[];
      error?: string;
    }
  | { type: "text"; delta: string }
  | { type: "action"; action: PendingAction }
  | {
      type: "done";
      model: string;
      totalMs: number;
      toolCalls: number;
      totalTokens: number | null;
    }
  | { type: "error"; message: string; detail?: string };
