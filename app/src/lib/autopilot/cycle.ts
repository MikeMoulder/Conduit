import "server-only";

import { PublicKey } from "@solana/web3.js";

import { fetchMandate, fetchPortfolio, type MandateView } from "../accounts";
import { getAgentIdentity } from "../agent-identity";
import { executeRebalance, executeSettle } from "../agent-execution";
import { runPipeline, type MandateSpec } from "../agents/pipeline";
import { getAssetByMint, getAssetBySymbol } from "../assets";
import { bpsToPercent, portfolioPda } from "../chain";
import { fetchHoldings, type PortfolioHoldings } from "../holdings";
import { pricedSymbols, snapshotMarket } from "../market";
import { evaluateProposal } from "../proposal";
import { getConnection } from "../rpc";
import { DEFAULT_BRAKE_BPS, describeBrake, isTripped, towardCash } from "./brakes";
import { applyPreIpoRules, DEFAULT_PRE_IPO_CAP_BPS } from "./pre-ipo";
import {
  advanceScore,
  describeScore,
  drawdownBps,
  recordTrade,
  startScore,
  summarise,
  type ScoreState,
} from "./scorecard";
import { snapshotFrom, takeSnapshot } from "./snapshot";
import {
  brakeEntry,
  getScore,
  listDecisions,
  saveScore,
  type AutopilotEntry,
  type Decision,
} from "./state";

/**
 * One autonomous cycle for one mandate: look, decide, act, write it down.
 *
 * This is the part of the product the mandate exists for. Everywhere else a
 * person approves each step. Here nobody does, and that is safe for one reason
 * only: every transaction the cycle sends is checked by the program against
 * the rules the owner signed, so the worst the agent can do unsupervised is
 * what the mandate already allows.
 *
 * Two choices keep it honest rather than merely safe.
 *
 * It never sends a proposal it knows will be refused. The analysis can produce
 * an allocation the mandate forbids, and in the approval flow the person may
 * send one anyway to watch the chain refuse it. Unsupervised, that would only
 * burn fees and litter the history, so the cycle checks first and records why
 * it held back instead.
 *
 * It does not churn. If the analysis moves less than one percent of the book,
 * the targets stay as they are. Rebalancing on noise is how an agent with
 * unlimited patience turns a small edge into a large fee bill.
 */

/** Below this much turnover the targets are left alone. */
const MIN_TURNOVER_BPS = 100;

function describe(positions: { symbol: string; targetBps: number }[]): string {
  const invested = positions.reduce((sum, p) => sum + p.targetBps, 0);
  const parts = positions.map((p) => `${p.symbol} ${bpsToPercent(p.targetBps)}`);
  parts.push(`cash ${bpsToPercent(10_000 - invested)}`);
  return parts.join(", ");
}

/**
 * What the analysis is told about its own record on this mandate.
 *
 * So it can see whether its recent choices worked. Paired with a warning,
 * because a record of hours is mostly noise, and an agent chasing its own
 * score would trade more to look better and do worse.
 */
function trackRecord(score: ScoreState, recent: Decision[]): string {
  const lines = [describeScore(summarise(score))];
  for (const d of recent) {
    lines.push(`- ${new Date(d.at).toISOString().slice(0, 16).replace("T", " ")} UTC, ${d.outcome}: ${d.summary}`);
  }
  lines.push(
    "Judge your recent decisions by this record. If the book has lagged SPY, say why you expect it to do better from here, or move closer to the index. A record of hours or days is mostly noise: do not chase it, and never trade only to change it.",
  );
  return lines.join("\n");
}

/**
 * Moves the book toward cash and stops the autopilot.
 *
 * The autopilot is paused whether or not the trades go through. A brake that
 * tripped and then failed to sell must still stop the agent from buying more
 * on the next cycle, and the owner is told exactly what did and did not happen.
 */
async function applyBrake(input: {
  entry: AutopilotEntry;
  mandate: MandateView;
  positions: { mint: string; targetBps: number }[];
  score: ScoreState;
  brakeBps: number;
  base: Pick<Decision, "mandate" | "owner" | "at" | "reasoning" | "positions" | "signatures">;
}): Promise<Decision> {
  const { entry, mandate, score, brakeBps, base } = input;
  const fall = drawdownBps(score);
  const after = towardCash(
    input.positions.map((p) => ({ symbol: p.mint, targetBps: p.targetBps })),
    mandate.constraints.maxTurnoverBps,
  );
  const named = (weights: { symbol: string; targetBps: number }[]) =>
    weights.map((w) => ({ symbol: getAssetByMint(w.symbol)?.symbol ?? w.symbol, targetBps: w.targetBps }));

  brakeEntry(entry.mandate, Date.now());

  const stopped = (summary: string, signatures: string[], final: ScoreState): Decision => ({
    ...base,
    outcome: "braked",
    positions: named(after),
    signatures,
    summary,
    score: summarise(final),
  });

  const signatures: string[] = [];
  if (input.positions.length > 0) {
    const rebalance = await executeRebalance({
      mandate: entry.mandate,
      positions: after.map((w) => ({ mint: w.symbol, targetBps: w.targetBps })),
    });
    if (!rebalance.body.accepted) {
      return stopped(
        `Safety brake: the mandate fell ${bpsToPercent(fall)} from its best point, past your ${bpsToPercent(brakeBps)} limit. The autopilot is paused, but the move to cash was not accepted (${String(rebalance.body.detail ?? rebalance.body.error ?? "no detail")}). Your holdings are unchanged; sell from the chat if you want out.`,
        signatures,
        score,
      );
    }
    signatures.push(String(rebalance.body.signature));
  }

  const settle = await executeSettle({ mandate: entry.mandate });
  if (!settle.body.settled) {
    return stopped(
      `Safety brake: the mandate fell ${bpsToPercent(fall)} from its best point, past your ${bpsToPercent(brakeBps)} limit. The autopilot is paused and the targets now point to cash, but the settlement did not go through (${String(settle.body.detail ?? settle.body.error ?? "no detail")}). Ask for a settlement to finish the move.`,
      signatures,
      score,
    );
  }
  signatures.push(String(settle.body.signature));

  const final = settle.body.after
    ? recordTrade(score, snapshotFrom(settle.body.after as PortfolioHoldings, score.last.prices, score.last.spyPrice, Date.now()))
    : score;
  saveScore(entry.mandate, final);

  return stopped(describeBrake({ drawdownBps: fall, brakeBps, after }), signatures, final);
}

export async function runCycle(entry: AutopilotEntry): Promise<Decision> {
  const base = {
    mandate: entry.mandate,
    owner: entry.owner,
    at: Date.now(),
    reasoning: null,
    positions: [],
    signatures: [],
  };
  const skip = (summary: string): Decision => ({ ...base, outcome: "skipped", summary });

  const connection = getConnection();
  const mandateKey = new PublicKey(entry.mandate);
  const mandate = await fetchMandate(connection, mandateKey);

  if (!mandate) return skip("The mandate no longer exists.");
  if (mandate.status !== "active") {
    return skip(`The mandate is ${mandate.status}, so the program would refuse the agent. Nothing was sent.`);
  }

  const agent = getAgentIdentity();
  if (!agent.configured || mandate.agent !== agent.publicKey) {
    return skip("This mandate names a different agent than the one this server holds.");
  }

  const portfolioKey = portfolioPda(mandateKey);
  const [portfolio, holdings] = await Promise.all([
    fetchPortfolio(connection, portfolioKey),
    fetchHoldings(connection, portfolioKey, mandate),
  ]);

  if (!portfolio) return skip("The mandate has no portfolio yet.");
  if (!holdings.funded) {
    return skip("The mandate holds no cash to invest yet. Move some in from the main wallet.");
  }

  // Brought up to date before the agent acts, so what the market did since the
  // last cycle is credited to the book the agent chose then. A cycle whose
  // prices cannot be read leaves the score where it was.
  const reading = await takeSnapshot(connection, mandate, holdings);
  let score = getScore(entry.mandate);
  if (reading) {
    score = score ? advanceScore(score, reading).state : startScore(reading);
    saveScore(entry.mandate, score);
  }

  // A braked mandate stays braked however the cycle was started, including
  // by hand, until the owner switches the autopilot back on.
  if (entry.brakedAt) {
    return {
      ...skip("The safety brake is on, so the agent does not trade this mandate. Switch the autopilot back on to resume; the brake then measures from that day."),
      score: score ? summarise(score) : undefined,
    };
  }

  // Checked before the analysis, and not by it. The brake is for when the
  // analysis may be what is going wrong.
  const brakeBps = entry.brakeBps ?? DEFAULT_BRAKE_BPS;
  if (score && isTripped(score, brakeBps)) {
    return applyBrake({ entry, mandate, positions: portfolio.positions, score, brakeBps, base });
  }

  const symbols = mandate.allowedAssets
    .map((a) => getAssetByMint(a.mint)?.symbol)
    .filter((s): s is string => Boolean(s));
  const snapshot = await snapshotMarket(symbols);
  const tradable = snapshot.filter((s) => s.price !== null);
  if (tradable.length === 0) return skip("No permitted asset has a price right now.");

  const current = portfolio.positions;
  const spec: MandateSpec = {
    objective: entry.objective,
    maxPositionBps: mandate.constraints.maxPositionBps,
    minCashBps: mandate.constraints.minCashBps,
    maxTurnoverBps: mandate.constraints.maxTurnoverBps,
    maxAssets: Math.min(mandate.constraints.maxAssets, tradable.length),
    allowedSymbols: pricedSymbols(tradable),
    currentPositions: current.flatMap((p) => {
      const known = getAssetByMint(p.mint);
      return known ? [{ symbol: known.symbol, targetBps: p.targetBps }] : [];
    }),
    preIpoCapBps: entry.preIpoCapBps ?? DEFAULT_PRE_IPO_CAP_BPS,
    trackRecord: score ? trackRecord(score, listDecisions({ mandate: entry.mandate }, 3)) : undefined,
  };

  const run = await runPipeline(spec, tradable);
  const reasoning = run.proposal.reasoning;

  const allowed = new Set(mandate.allowedAssets.map((a) => a.mint));
  const permitted = run.proposal.positions.filter((p) => {
    const mint = getAssetBySymbol(p.symbol)?.mint;
    return Boolean(mint) && allowed.has(mint!) && p.targetBps > 0;
  });

  // The analysis was told the pre IPO limits. This is the backstop in case it
  // did not keep to them, and it reads the whole snapshot, not only what is
  // priced, so a held name that lost its price cannot grow.
  const rules = applyPreIpoRules({
    proposed: permitted.map((p) => ({ symbol: p.symbol, targetBps: p.targetBps })),
    current: spec.currentPositions ?? [],
    market: snapshot,
    capBps: spec.preIpoCapBps!,
  });
  const proposed = rules.positions.map((p) => ({ ...p, mint: getAssetBySymbol(p.symbol)!.mint }));
  const analysed = {
    ...base,
    preIpo: rules.notes.length > 0 ? rules.notes : undefined,
    score: score ? summarise(score) : undefined,
  };

  const evaluation = evaluateProposal({
    constraints: mandate.constraints,
    allowedMints: [...allowed],
    current,
    proposed: proposed.map((p) => ({ mint: p.mint, targetBps: p.targetBps })),
  });

  const positions = proposed.map((p) => ({ symbol: p.symbol, targetBps: p.targetBps }));

  if (!evaluation.compliant) {
    return {
      ...analysed,
      outcome: "skipped",
      reasoning,
      positions,
      summary: `The analysis proposed ${describe(positions)}, which the mandate would refuse with ${evaluation.firstRefusal}. Nothing was sent.`,
    };
  }

  const signatures: string[] = [];
  const changed = evaluation.turnoverBps >= MIN_TURNOVER_BPS;

  if (changed) {
    const rebalance = await executeRebalance({
      mandate: entry.mandate,
      positions: proposed.map((p) => ({ mint: p.mint, targetBps: p.targetBps })),
    });
    if (!rebalance.body.accepted) {
      const error = rebalance.body.programError as { name?: string } | null;
      return {
        ...analysed,
        outcome: "failed",
        reasoning,
        positions,
        summary: `The rebalance was not accepted${error?.name ? `: ${error.name}` : ""}. ${String(rebalance.body.detail ?? rebalance.body.error ?? "")}`.trim(),
      };
    }
    signatures.push(String(rebalance.body.signature));
  }

  // Settled every cycle, changed or not: prices move, holdings drift from
  // their targets, and settling is what brings them back.
  const settle = await executeSettle({ mandate: entry.mandate });
  if (!settle.body.settled) {
    const error = settle.body.programError as { name?: string } | null;
    return {
      ...analysed,
      outcome: "failed",
      reasoning,
      positions,
      signatures,
      summary: `${changed ? "The new targets were accepted, but the" : "The"} settlement did not go through${error?.name ? `: ${error.name}` : ""}. ${String(settle.body.detail ?? settle.body.error ?? "")}`.trim(),
    };
  }
  signatures.push(String(settle.body.signature));

  // The book after trading, at the prices the score just used, so any gap is
  // the cost of the trades rather than the market moving.
  if (score && settle.body.after) {
    score = recordTrade(
      score,
      snapshotFrom(settle.body.after as PortfolioHoldings, score.last.prices, score.last.spyPrice, Date.now()),
    );
    saveScore(entry.mandate, score);
  }

  return {
    ...analysed,
    score: score ? summarise(score) : undefined,
    outcome: changed ? "rebalanced" : "held",
    reasoning,
    positions,
    signatures,
    summary: changed
      ? `Rebalanced to ${describe(positions)}, then settled into real tokens.`
      : `Kept the allocation: the analysis moved less than ${bpsToPercent(MIN_TURNOVER_BPS)} of the book. Settled any drift back to target.`,
  };
}
