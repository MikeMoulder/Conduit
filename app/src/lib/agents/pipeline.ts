import "server-only";

import { generateStructured } from "../gemini";
import {
  argumentGeminiSchema,
  argumentSchema,
  proposalGeminiSchema,
  proposalSchema,
  researchGeminiSchema,
  researchSchema,
  riskGeminiSchema,
  riskSchema,
  type Argument,
  type Proposal,
  type Research,
  type RiskAssessment,
} from "./schemas";

/**
 * The five stage allocation pipeline.
 *
 * Research gathers what the data says. Bull and Bear argue the opposite sides of
 * it. Risk applies limits. The Portfolio Manager decides. Bull and Bear run
 * concurrently because neither should see the other's argument: the point is two
 * independent readings of the same evidence, not a conversation that converges.
 *
 * Nothing this pipeline produces is trusted. Every stage is schema checked on
 * arrival, the final proposal is measured against the mandate here, and the
 * chain re-derives every constraint again before anything moves. This function
 * can be wrong without being dangerous, which is the entire design.
 */

export interface MandateSpec {
  /** The user's instruction in their own words. */
  objective: string;
  maxPositionBps: number;
  minCashBps: number;
  maxTurnoverBps: number;
  maxAssets: number;
  allowedSymbols: string[];
}

export interface MarketSnapshot {
  symbol: string;
  name: string;
  assetClass: string;
  priceSource: string;
  /** Price of the held instrument, or null when unavailable. */
  price: number | null;
  /** Price of the underlying, where one exists. */
  referencePrice: number | null;
  /** Premium or discount of held against underlying, in basis points. */
  spreadBps: number | null;
}

export interface StageRecord {
  stage: string;
  model: string;
  totalTokens: number | null;
  attempts: number;
  durationMs: number;
}

export interface Violation {
  rule: string;
  detail: string;
  /** Matching on chain error, so the interface can name what would happen. */
  onChainError: string;
}

export interface ComplianceReport {
  compliant: boolean;
  cashBps: number;
  allocatedBps: number;
  violations: Violation[];
}

export interface PipelineResult {
  research: Research;
  bull: Argument;
  bear: Argument;
  risk: RiskAssessment;
  proposal: Proposal;
  compliance: ComplianceReport;
  stages: StageRecord[];
  totalDurationMs: number;
}

/** Renders the market table the way every stage will see it. */
function marketTable(market: MarketSnapshot[]): string {
  const rows = market.map((m) => {
    const price = m.price === null ? "unavailable" : `$${m.price.toFixed(2)}`;
    const ref =
      m.referencePrice === null ? "n/a" : `$${m.referencePrice.toFixed(2)}`;
    const spread =
      m.spreadBps === null
        ? "n/a"
        : `${m.spreadBps > 0 ? "+" : ""}${m.spreadBps} bps`;
    return `${m.symbol} | ${m.name} | ${m.assetClass} | price ${price} | underlying ${ref} | spread ${spread}`;
  });

  return rows.join("\n");
}

function mandateBlock(mandate: MandateSpec): string {
  return [
    `Objective (the investor's own words): ${mandate.objective}`,
    `Maximum any single position: ${mandate.maxPositionBps} bps (${mandate.maxPositionBps / 100}%)`,
    `Minimum cash: ${mandate.minCashBps} bps (${mandate.minCashBps / 100}%)`,
    `Maximum positions: ${mandate.maxAssets}`,
    `Permitted symbols: ${mandate.allowedSymbols.join(", ")}`,
  ].join("\n");
}

const HOUSE_RULES = `
You are one stage of an automated portfolio process operating under a binding mandate.

Rules that are not negotiable:
- Use only the symbols listed as permitted. Never introduce another.
- Use only the figures supplied. Never invent a price, a spread or a statistic.
- An asset whose price is unavailable cannot be assessed on price. Say so rather than guessing.
- A spread is the premium or discount of the held instrument against its underlying. A negative spread means it trades below the thing it represents.
- Basis points, always. 2500 bps is 25 percent.
`.trim();

async function runStage<T>(
  stage: string,
  systemInstruction: string,
  prompt: string,
  schema: Parameters<typeof generateStructured>[0]["schema"],
  validator: Parameters<typeof generateStructured<T>>[0]["validator"],
  records: StageRecord[],
  maxOutputTokens?: number,
): Promise<T> {
  const startedAt = Date.now();

  const result = await generateStructured<T>({
    stage,
    systemInstruction,
    prompt,
    schema,
    validator,
    maxOutputTokens,
  });

  records.push({
    stage,
    model: result.model,
    totalTokens: result.totalTokens,
    attempts: result.attempts,
    durationMs: Date.now() - startedAt,
  });

  return result.value;
}

/**
 * Measures a proposal against the mandate.
 *
 * This deliberately mirrors the Anchor program's policy engine rather than
 * sharing code with it, because the two run in different languages on different
 * machines. The copy here exists so the interface can tell a user what the chain
 * will say before they sign, and the `onChainError` field names the exact error
 * they would see. Where the two ever disagree, the chain is right and this is a
 * bug.
 */
export function checkCompliance(
  proposal: Proposal,
  mandate: MandateSpec,
): ComplianceReport {
  const violations: Violation[] = [];
  const permitted = new Set(mandate.allowedSymbols);
  const seen = new Set<string>();

  let allocatedBps = 0;

  for (const position of proposal.positions) {
    allocatedBps += position.targetBps;

    if (!permitted.has(position.symbol)) {
      violations.push({
        rule: "permitted universe",
        detail: `${position.symbol} is not in the mandate's permitted list`,
        onChainError: "AssetNotAllowed",
      });
    }

    if (seen.has(position.symbol)) {
      violations.push({
        rule: "duplicate asset",
        detail: `${position.symbol} appears more than once`,
        onChainError: "DuplicateAsset",
      });
    }
    seen.add(position.symbol);

    if (position.targetBps > mandate.maxPositionBps) {
      violations.push({
        rule: "concentration",
        detail: `${position.symbol} at ${position.targetBps} bps exceeds the ${mandate.maxPositionBps} bps cap`,
        onChainError: "PositionExceedsMaxSize",
      });
    }

    if (position.targetBps === 0) {
      violations.push({
        rule: "zero weight",
        detail: `${position.symbol} has a zero weight and should be omitted instead`,
        onChainError: "InvalidBasisPoints",
      });
    }
  }

  if (proposal.positions.length > mandate.maxAssets) {
    violations.push({
      rule: "position count",
      detail: `${proposal.positions.length} positions exceeds the limit of ${mandate.maxAssets}`,
      onChainError: "TooManyAssets",
    });
  }

  if (allocatedBps > 10_000) {
    violations.push({
      rule: "total allocation",
      detail: `allocations total ${allocatedBps} bps, which is more than the whole portfolio`,
      onChainError: "AllocationMustSumToFull",
    });
  }

  const cashBps = Math.max(0, 10_000 - allocatedBps);

  if (cashBps < mandate.minCashBps) {
    violations.push({
      rule: "cash floor",
      detail: `${cashBps} bps of cash is below the ${mandate.minCashBps} bps minimum`,
      onChainError: "InsufficientCashReserve",
    });
  }

  return {
    compliant: violations.length === 0,
    cashBps,
    allocatedBps,
    violations,
  };
}

export async function runPipeline(
  mandate: MandateSpec,
  market: MarketSnapshot[],
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const stages: StageRecord[] = [];

  const context = `${mandateBlock(mandate)}\n\nMarket data:\n${marketTable(market)}`;

  const research = await runStage<Research>(
    "research",
    `${HOUSE_RULES}\n\nYou are the Research stage. Report what the data shows. Do not recommend anything.`,
    `${context}\n\nFor every permitted asset with usable data, state what the figures show. Pay particular attention to spreads: a large discount or premium against the underlying is the most decision relevant fact available here.`,
    researchGeminiSchema,
    researchSchema,
    stages,
  );

  const evidence = `${context}\n\nResearch summary: ${research.marketSummary}\nFindings:\n${research.findings
    .map((f) => `- ${f.symbol} (signal ${f.signalStrength}/10): ${f.observation}`)
    .join("\n")}`;

  // Independent readings of the same evidence. Neither sees the other, so the
  // manager gets two genuine positions rather than a negotiated middle.
  const [bull, bear] = await Promise.all([
    runStage<Argument>(
      "bull",
      `${HOUSE_RULES}\n\nYou are the Bull stage. Argue the strongest honest case FOR exposure. Do not argue against anything.`,
      `${evidence}\n\nMake the strongest case for holding each asset you believe merits exposure.`,
      argumentGeminiSchema,
      argumentSchema,
      stages,
    ),
    runStage<Argument>(
      "bear",
      `${HOUSE_RULES}\n\nYou are the Bear stage. Argue the strongest honest case AGAINST exposure. Attack the evidence.`,
      `${evidence}\n\nMake the strongest case against holding each asset, including the ones that look attractive.`,
      argumentGeminiSchema,
      argumentSchema,
      stages,
    ),
  ]);

  const debate = `${evidence}\n\nBull case:\n${bull.cases
    .map((c) => `- ${c.symbol} (conviction ${c.weight}/10): ${c.argument}`)
    .join("\n")}\n\nBear case:\n${bear.cases
    .map((c) => `- ${c.symbol} (severity ${c.weight}/10): ${c.argument}`)
    .join("\n")}`;

  const risk = await runStage<RiskAssessment>(
    "risk",
    `${HOUSE_RULES}\n\nYou are the Risk stage. You set ceilings, never floors. You may recommend a weight lower than the mandate cap but never higher.`,
    `${debate}\n\nFor each asset, give the largest weight you would tolerate and why. Treat a persistently wide spread as a liquidity warning that should reduce the size you allow. Then list risks that apply to the portfolio as a whole.`,
    riskGeminiSchema,
    riskSchema,
    stages,
  );

  const decision = `${debate}\n\nRisk assessment:\n${risk.assessments
    .map((a) => `- ${a.symbol}: at most ${a.maxRecommendedBps} bps. ${a.concern}`)
    .join("\n")}\n\nPortfolio level concerns:\n${risk.portfolioConcerns
    .map((c) => `- ${c}`)
    .join("\n")}`;

  const proposal = await runStage<Proposal>(
    "manager",
    `${HOUSE_RULES}\n\nYou are the Portfolio Manager. You decide. Weigh the bull case against the bear case, respect the risk ceilings, and stay inside the mandate. Every position needs a thesis and the specific conditions that would break it.`,
    `${decision}\n\nProduce the final allocation.\n\nHard constraints, which will be enforced on chain and will cause the transaction to fail if breached:\n- No position above ${mandate.maxPositionBps} bps.\n- At most ${mandate.maxAssets} positions.\n- Allocations must leave at least ${mandate.minCashBps} bps in cash, so they must total no more than ${10_000 - mandate.minCashBps} bps.\n- Only permitted symbols.\n\nOmit any asset you do not want rather than giving it a zero weight.`,
    proposalGeminiSchema,
    proposalSchema,
    stages,
  );

  return {
    research,
    bull,
    bear,
    risk,
    proposal,
    compliance: checkCompliance(proposal, mandate),
    stages,
    totalDurationMs: Date.now() - startedAt,
  };
}
