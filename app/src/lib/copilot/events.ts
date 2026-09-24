import type { MandateView, PortfolioView } from "../accounts";
import type { ActivityRecord } from "../events";
import type { ProposalEvaluation } from "../proposal";
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
  | { kind: "funding"; funding: FundingCard };

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

/** The result of topping a portfolio up with devnet demo cash. */
export interface FundingCard {
  funded: boolean;
  signature: string | null;
  slot: number | null;
  /** Whole units of cash sent. Zero when the portfolio was already topped up. */
  sent: number;
  after: PortfolioHoldings | null;
  detail: string | null;
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
      kind: "order";
      /** Signed by the agent on approval: the target, then the settlement. */
      mandate: string;
      side: "buy" | "sell";
      symbol: string;
      mint: string;
      requestedDollars: number;
      /** What rounding to whole basis points will actually trade. */
      executedDollars: number;
      /** The settlement price used for the preview, dollars per token. */
      price: number;
      priceSource: string;
      priceAgeSeconds: number;
      valueBefore: number;
      valueAfter: number;
      bpsBefore: number;
      bpsAfter: number;
      cashAfter: number;
      /** The full target vector proposed, every other holding at its weight. */
      positions: WeightRow[];
      evaluation: ProposalEvaluation;
      summary: string;
    }
  | {
      kind: "fund";
      /** Paid by the devnet faucet key on the server once approved. */
      mandate: string;
      summary: string;
    }
  | {
      kind: "settle";
      /** Signed by the agent on the server once approved. */
      mandate: string;
      summary: string;
    };

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
