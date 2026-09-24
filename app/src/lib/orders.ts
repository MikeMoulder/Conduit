import type { MandateConstraintsView } from "./accounts";
import {
  evaluateProposal,
  type CurrentPosition,
  type ProposalEvaluation,
  type ProposedPosition,
} from "./proposal";

/**
 * Dollar orders: "buy $10,000 of NVDA", turned into something the program
 * understands.
 *
 * The program reasons only in shares of the portfolio. That is a genuine
 * strength, since a cap on a share is enforceable without knowing what anything
 * costs, but it is not how a person thinks about buying something. This module
 * is the translation, and it is deliberately code rather than something the
 * model works out: converting a dollar amount into basis points of a portfolio
 * is exactly the kind of arithmetic a language model gets subtly wrong, and
 * here being subtly wrong moves money.
 *
 * Three rules shape it.
 *
 * Only the ordered asset moves. Every other holding keeps its current value, so
 * its new target is its present weight rather than whatever it was last set to.
 * A dollar order that quietly rebalanced everything else back to stale targets
 * would be doing something nobody asked for.
 *
 * Prices are the ones settlement will use. The caller supplies the on chain
 * price accounts the program reads, not a quote from somewhere else, so the
 * preview and the settlement agree unless the price moves in between.
 *
 * The answer to "too much" is a number. When an order breaks a rule, the most
 * that would fit is found by searching with the same evaluator that mirrors the
 * program, so it is exact against the program's own arithmetic rather than an
 * estimate from a formula that ignores turnover.
 *
 * Cash is the settlement currency, one unit to a dollar.
 */

export type Side = "buy" | "sell";

export interface PricedHolding {
  mint: string;
  /** Whole tokens held. */
  units: number;
  /** Dollars per whole token, as settlement will price it. */
  price: number;
}

export interface Book {
  cash: number;
  holdings: PricedHolding[];
  /** Cash plus every holding at its price. */
  nav: number;
}

export interface MandateContext {
  constraints: MandateConstraintsView;
  allowedMints: string[];
  /** The targets currently recorded on chain, which turnover is measured from. */
  current: CurrentPosition[];
}

export interface OrderPlan {
  /** The full target vector to propose. Cash is whatever it leaves. */
  positions: ProposedPosition[];
  /** The ordered asset's new target. */
  orderedBps: number;
  /** Its target before the order, as a share of the book at today's prices. */
  orderedBpsBefore: number;
  /**
   * Dollars that will actually change hands. Targets are whole basis points,
   * so this differs from the request by at most half a basis point of the book.
   */
  executedDollars: number;
}

const BPS = 10_000;

export function bookFrom(cash: number, holdings: PricedHolding[]): Book {
  const invested = holdings.reduce((sum, h) => sum + h.units * h.price, 0);
  return { cash, holdings, nav: cash + invested };
}

export function valueOf(book: Book, mint: string): number {
  const h = book.holdings.find((x) => x.mint === mint);
  return h ? h.units * h.price : 0;
}

/** Dollars, to the cent, for anything shown to a person. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The target vector for one order, or the reason there is none.
 *
 * Does not consult the mandate. Whether the plan is allowed is a separate
 * question, answered by `checkOrder`, because "you do not have that much cash"
 * and "your mandate forbids it" are different kinds of no.
 */
export function planOrder(
  book: Book,
  mint: string,
  side: Side,
  dollars: number,
): OrderPlan | { error: string } {
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return { error: "The amount has to be a positive number of dollars." };
  }
  if (book.nav <= 0) {
    return { error: "The portfolio holds nothing, so there is nothing to trade with." };
  }
  if (!book.holdings.some((h) => h.mint === mint)) {
    return { error: "That asset is not one this portfolio can hold." };
  }

  const held = valueOf(book, mint);

  if (side === "buy" && dollars > book.cash) {
    return {
      error: `The portfolio has $${cents(book.cash).toLocaleString()} in cash, which is less than $${cents(dollars).toLocaleString()}.`,
    };
  }
  if (side === "sell" && dollars > held) {
    return {
      error: `The portfolio holds $${cents(held).toLocaleString()} of it, which is less than $${cents(dollars).toLocaleString()}.`,
    };
  }

  const toBps = (value: number) => Math.round((value / book.nav) * BPS);

  const after = side === "buy" ? held + dollars : held - dollars;

  const positions: ProposedPosition[] = [];
  let orderedBps = 0;

  for (const h of book.holdings) {
    const value = h.mint === mint ? after : h.units * h.price;
    const bps = toBps(value);
    if (h.mint === mint) orderedBps = bps;
    // A position of zero is not a position. Proposing one is refused by the
    // program, and leaving it out is how a holding is sold to nothing.
    if (bps > 0) positions.push({ mint: h.mint, targetBps: bps });
  }

  // Rounding every weight to the nearest point can overshoot the whole book by
  // a point or two. The ordered asset absorbs it, since it is the one moving.
  const total = positions.reduce((sum, p) => sum + p.targetBps, 0);
  if (total > BPS) {
    const excess = total - BPS;
    const row = positions.find((p) => p.mint === mint);
    if (row) {
      row.targetBps = Math.max(0, row.targetBps - excess);
      orderedBps = row.targetBps;
    }
  }

  return {
    positions: positions.filter((p) => p.targetBps > 0),
    orderedBps,
    orderedBpsBefore: toBps(held),
    executedDollars: cents(Math.abs((orderedBps / BPS) * book.nav - held)),
  };
}

export interface CheckedOrder {
  plan: OrderPlan;
  evaluation: ProposalEvaluation;
}

/** A plan, and what the program would say about it. */
export function checkOrder(
  book: Book,
  mint: string,
  side: Side,
  dollars: number,
  mandate: MandateContext,
): CheckedOrder | { error: string } {
  const plan = planOrder(book, mint, side, dollars);
  if ("error" in plan) return plan;

  const evaluation = evaluateProposal({
    constraints: mandate.constraints,
    allowedMints: mandate.allowedMints,
    current: mandate.current,
    proposed: plan.positions,
  });

  return { plan, evaluation };
}

/**
 * The largest order, in whole dollars, the mandate would accept.
 *
 * A binary search rather than a formula. The cap and the cash floor each have
 * a closed form, but turnover is measured against the targets recorded on
 * chain, which drift from actual weights as prices move, and a formula that
 * ignored that would name a figure the program then refuses. Every limit here
 * only tightens as the order grows, so the accepted region is a single range
 * from zero and a search over it is exact.
 *
 * Zero means no amount at all fits, which is a real answer: a portfolio
 * already at its asset limit cannot buy a new name for any price.
 */
export function largestOrder(
  book: Book,
  mint: string,
  side: Side,
  mandate: MandateContext,
): number {
  const ceiling = Math.floor(side === "buy" ? book.cash : valueOf(book, mint));

  const fits = (dollars: number): boolean => {
    const result = checkOrder(book, mint, side, dollars, mandate);
    return !("error" in result) && result.evaluation.compliant;
  };

  if (ceiling < 1 || !fits(1)) return 0;
  if (fits(ceiling)) return ceiling;

  let lo = 1;
  let hi = ceiling;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
