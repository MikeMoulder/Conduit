import { bpsToPercent } from "../chain";
import { drawdownBps, type ScoreState } from "./scorecard";

/**
 * The autopilot's safety brake: a fall of a set size from the mandate's best
 * point moves it toward cash and stops the agent.
 *
 * The mandate already limits what the agent may hold. This limits what it may
 * lose. The two answer different questions: a mandate allowing 50% in NVDA is
 * fine until NVDA halves, and nothing about the allocation rules says when to
 * stop.
 *
 * Measured on the scorecard's index, not the portfolio's value, so money the
 * owner takes out never trips it and money they put in never hides a fall.
 *
 * Deliberately not the analysis's call. The brake is for when the analysis
 * may be what is going wrong, so it is a fixed rule checked before the
 * analysis runs, and once tripped it stays tripped until the owner switches
 * the autopilot back on.
 *
 * Pure: the cycle does the reading and sending.
 */

/** The brake when the owner has not chosen one: 10% below the best point. */
export const DEFAULT_BRAKE_BPS = 1_000;

export interface Weight {
  symbol: string;
  targetBps: number;
}

/** Whether the fall from the best point has reached the owner's limit. Zero means no brake. */
export function isTripped(score: ScoreState, brakeBps: number): boolean {
  return brakeBps > 0 && drawdownBps(score) >= brakeBps;
}

/**
 * The allocation that moves as much of the book to cash as one rebalance
 * allows.
 *
 * All of it where the turnover limit permits, which is the usual case. A
 * mandate with a tight limit cannot empty in one step, so every position is
 * cut by the same fraction until the limit is used, rounding each weight up so
 * the total cut never exceeds it. The program would refuse anything more, and
 * a brake that is refused does nothing.
 */
export function towardCash(current: Weight[], maxTurnoverBps: number): Weight[] {
  const invested = current.reduce((sum, p) => sum + p.targetBps, 0);
  if (invested === 0) return [];

  const cut = Math.min(invested, maxTurnoverBps);
  const keep = invested - cut;

  return current
    .map((p) => ({ ...p, targetBps: Math.ceil((p.targetBps * keep) / invested) }))
    .filter((p) => p.targetBps > 0);
}

/** What the owner is told when the brake trips. */
export function describeBrake(input: {
  drawdownBps: number;
  brakeBps: number;
  after: Weight[];
}): string {
  const left = input.after.reduce((sum, p) => sum + p.targetBps, 0);
  const moved =
    left === 0
      ? "Moved everything to cash"
      : `Moved as much to cash as the turnover limit allows, ${bpsToPercent(left)} is still invested and the next step needs you`;
  return (
    `Safety brake: the mandate fell ${bpsToPercent(input.drawdownBps)} from its best point, past your ${bpsToPercent(input.brakeBps)} limit. ` +
    `${moved}, and paused the autopilot. Nothing more is traded until you switch it back on.`
  );
}
