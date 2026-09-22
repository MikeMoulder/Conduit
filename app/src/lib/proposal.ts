import { BPS_DENOMINATOR } from "./chain";
import type { MandateConstraintsView } from "./accounts";

/**
 * A complete mirror of `evaluate_proposal` in the program.
 *
 * The compliance check inside the agent pipeline is an earlier, partial version
 * of this: it runs before a portfolio exists, so it cannot see turnover. This
 * one is given the current on chain positions and checks every clause the
 * program checks, in the order the program checks them.
 *
 * Order matters here in a way it does not in most validation code. The program
 * stops at its first failure, so predicting what a transaction will actually
 * return means knowing which clause it reaches first. The interface reports
 * every problem, because a person fixing one wants to see the rest, and reports
 * separately which one the chain would name.
 *
 * As with the mandate mirror, the program is the authority. If these two ever
 * disagree, the program is right and this is a bug. `tests/rebalance.ts` sends
 * every case below to the deployed program and asserts they agree.
 */

export interface ProposedPosition {
  mint: string;
  targetBps: number;
}

export interface CurrentPosition {
  mint: string;
  targetBps: number;
}

export interface ProposalViolation {
  rule: string;
  detail: string;
  onChainError: string;
  /** The offending mint, when the clause is about one position. */
  mint?: string;
}

export interface ProposalEvaluation {
  compliant: boolean;
  allocatedBps: number;
  /** Derived, never supplied. The program computes it the same way. */
  cashBps: number;
  turnoverBps: number;
  violations: ProposalViolation[];
  /**
   * The error the program would return, which is its first failure rather than
   * the worst one. Null when the proposal would be accepted.
   */
  firstRefusal: string | null;
}

export interface WeightedHolding {
  /** Any stable identifier, as long as both sides use the same one. */
  id: string;
  targetBps: number;
}

/**
 * Turnover between two sets of weights. Mirrors `compute_turnover_bps`.
 *
 * Two details are easy to get wrong and both are deliberate in the program.
 * Positions being closed do not appear in a proposal, so they are counted from
 * the current side, otherwise exiting a position would be free. And the cash leg
 * is counted too, because moving to cash is a trade. The total is halved because
 * every unit of turnover is counted twice, once where it left and once where it
 * arrived.
 *
 * Identity neutral so the same arithmetic serves both vocabularies in the
 * project. The chain thinks in mints. The agent pipeline thinks in symbols and
 * has no mints to hand at the point it needs this. Two copies of a formula this
 * easy to get subtly wrong would be worse than one function with a generic key.
 */
export function turnoverBetween(
  current: WeightedHolding[],
  proposed: WeightedHolding[],
  proposedCashBps: number,
): number {
  let totalDelta = 0;

  for (const position of proposed) {
    const previous = current.find((p) => p.id === position.id)?.targetBps ?? 0;
    totalDelta += Math.abs(position.targetBps - previous);
  }

  for (const position of current) {
    if (!proposed.some((p) => p.id === position.id)) {
      totalDelta += position.targetBps;
    }
  }

  const currentAllocated = current.reduce((sum, p) => sum + p.targetBps, 0);
  const currentCash = Math.max(0, BPS_DENOMINATOR - currentAllocated);
  totalDelta += Math.abs(proposedCashBps - currentCash);

  return Math.floor(totalDelta / 2);
}

export function computeTurnoverBps(
  current: CurrentPosition[],
  proposed: ProposedPosition[],
  proposedCashBps: number,
): number {
  return turnoverBetween(
    current.map((p) => ({ id: p.mint, targetBps: p.targetBps })),
    proposed.map((p) => ({ id: p.mint, targetBps: p.targetBps })),
    proposedCashBps,
  );
}

export interface EvaluationInput {
  constraints: MandateConstraintsView;
  /** Mints the mandate permits, as recorded on chain. */
  allowedMints: string[];
  current: CurrentPosition[];
  proposed: ProposedPosition[];
}

export function evaluateProposal(input: EvaluationInput): ProposalEvaluation {
  const { constraints, allowedMints, current, proposed } = input;
  const violations: ProposalViolation[] = [];

  /**
   * Recorded in program order. The first entry is what a transaction would
   * actually return, which is not always the violation a reader considers most
   * important.
   */
  const ordered: string[] = [];
  const refuse = (v: ProposalViolation) => {
    violations.push(v);
    ordered.push(v.onChainError);
  };

  if (allowedMints.length === 0) {
    refuse({
      rule: "permitted universe",
      detail: "the mandate permits no assets at all",
      onChainError: "EmptyAssetUniverse",
    });
  }

  if (proposed.length > constraints.maxAssets) {
    refuse({
      rule: "position count",
      detail: `${proposed.length} positions exceeds the limit of ${constraints.maxAssets}`,
      onChainError: "TooManyAssets",
    });
  }

  let allocatedBps = 0;
  const permitted = new Set(allowedMints);
  const seen = new Set<string>();

  for (const position of proposed) {
    if (
      !Number.isInteger(position.targetBps) ||
      position.targetBps > BPS_DENOMINATOR
    ) {
      refuse({
        rule: "basis points",
        mint: position.mint,
        detail: `${position.targetBps} is not a whole number of basis points within ${BPS_DENOMINATOR}`,
        onChainError: "InvalidBasisPoints",
      });
    } else if (position.targetBps <= 0) {
      // Not an error in spirit, but it must not consume a position slot, so the
      // program refuses it rather than storing a holding of nothing.
      refuse({
        rule: "zero weight",
        mint: position.mint,
        detail: "a weight of zero should be an omission, not a position",
        onChainError: "InvalidBasisPoints",
      });
    } else if (position.targetBps > constraints.maxPositionBps) {
      refuse({
        rule: "concentration",
        mint: position.mint,
        detail: `${position.targetBps} bps exceeds the ${constraints.maxPositionBps} bps cap on any single position`,
        onChainError: "PositionExceedsMaxSize",
      });
    }

    if (!permitted.has(position.mint)) {
      refuse({
        rule: "permitted universe",
        mint: position.mint,
        detail: "this mint is outside the universe the mandate permits",
        onChainError: "AssetNotAllowed",
      });
    }

    if (seen.has(position.mint)) {
      refuse({
        rule: "duplicate asset",
        mint: position.mint,
        detail: "this mint appears more than once in the proposal",
        onChainError: "DuplicateAsset",
      });
    }
    seen.add(position.mint);

    allocatedBps += position.targetBps;
  }

  if (allocatedBps > BPS_DENOMINATOR) {
    refuse({
      rule: "total allocation",
      detail: `allocations total ${allocatedBps} bps, which is more than the whole portfolio`,
      onChainError: "AllocationMustSumToFull",
    });
  }

  const cashBps = Math.max(0, BPS_DENOMINATOR - allocatedBps);

  if (cashBps < constraints.minCashBps) {
    refuse({
      rule: "cash floor",
      detail: `${cashBps} bps of cash is below the ${constraints.minCashBps} bps the mandate requires`,
      onChainError: "InsufficientCashReserve",
    });
  }

  const turnoverBps = computeTurnoverBps(current, proposed, cashBps);

  if (turnoverBps > constraints.maxTurnoverBps) {
    refuse({
      rule: "turnover",
      detail: `${turnoverBps} bps would change hands, above the ${constraints.maxTurnoverBps} bps limit for one rebalance`,
      onChainError: "TurnoverExceeded",
    });
  }

  return {
    compliant: violations.length === 0,
    allocatedBps,
    cashBps,
    turnoverBps,
    violations,
    firstRefusal: ordered[0] ?? null,
  };
}
