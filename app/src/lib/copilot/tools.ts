import "server-only";

import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

import { fetchMandate, fetchPortfolio, type MandateView } from "../accounts";
import { getAssetByMint, getAssetBySymbol, listAssets } from "../assets";
import { MAX_ASSETS, bpsToPercent, mandatePda, portfolioPda } from "../chain";
import { fetchActivity } from "../events";
import type { ToolDeclaration } from "../gemini";
import { runPipeline, type MandateSpec } from "../agents/pipeline";
import { snapshotMarket, pricedSymbols } from "../market";
import { validateConstraints, validateUniverse } from "../mandate";
import { evaluateProposal } from "../proposal";
import { getConnection } from "../rpc";
import { fetchHoldings, isSettleable, settleableAsset } from "../holdings";
import { FUND_UNITS } from "../faucet";
import { getAgentIdentity } from "../agent-identity";
import type {
  Card,
  PendingAction,
  Source,
  UniverseRow,
  WeightRow,
} from "./events";

/**
 * The capabilities the copilot can reach.
 *
 * Everything here already existed as a route or a library function. Nothing new
 * is being invented: the pipeline, the price providers, the account readers and
 * the proposal mirror are all the same code the earlier screens used. What this
 * file adds is a description the model can read and a boundary it cannot cross.
 *
 * Two rules shape the whole file.
 *
 * The model never chooses whose data to read. There is no `owner` argument
 * anywhere below. It comes from the connected wallet on the request, so a
 * sentence in a conversation cannot point the copilot at somebody else.
 *
 * What goes back to the model and what goes on screen are different things, on
 * purpose. The card carries everything a person wants: full histories, every
 * thesis, all the reasoning. The result handed back to the model is a summary,
 * because feeding an entire activity log into the next turn spends context on
 * text it has already caused to be displayed, and a model that is drowning in
 * its own tool output starts answering worse.
 */

export interface ToolContext {
  /** The connected wallet. Null when nobody is connected. */
  owner: PublicKey | null;
  /** Lets a slow tool report progress into the step list. */
  onProgress?: (label: string, detail?: string) => void;
}

export interface ToolOutcome {
  /** Compact, for the model. */
  result: Record<string, unknown>;
  /** One line for the step list. */
  summary: string;
  /** Rich, for the person. */
  card?: Card;
  sources?: Source[];
  /** Set when the tool prepared something that needs a human decision. */
  action?: PendingAction;
}

export interface CopilotTool {
  declaration: ToolDeclaration;
  /** What the step list says while this runs. */
  label: string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

/** Thrown when a tool cannot proceed. The message goes back to the model. */
class ToolError extends Error {}

function requireOwner(ctx: ToolContext): PublicKey {
  if (!ctx.owner) {
    throw new ToolError(
      "No wallet is connected, so there is no owner whose mandate could be read. Ask the person to connect one.",
    );
  }
  return ctx.owner;
}

const mandateIdArg = z.number().int().min(0).max(1_000_000).optional();

function addresses(ctx: ToolContext, mandateId: number) {
  const owner = requireOwner(ctx);
  const mandate = mandatePda(owner, mandateId);
  return { owner, mandate, portfolio: portfolioPda(mandate) };
}

async function loadMandate(
  ctx: ToolContext,
  mandateId: number,
): Promise<{ mandate: MandateView; address: PublicKey }> {
  const { mandate: address } = addresses(ctx, mandateId);
  const mandate = await fetchMandate(getConnection(), address);
  if (!mandate) {
    throw new ToolError(
      `There is no mandate ${mandateId} for this wallet yet. One has to be created before it can be read or rebalanced.`,
    );
  }
  return { mandate, address };
}

const SOLANA_SOURCE: Source[] = [
  { provider: "solana", detail: "read from the account on devnet", ok: true },
];

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

const listUniverse: CopilotTool = {
  label: "Listing the tradable universe",
  declaration: {
    name: "list_universe",
    description:
      "Every asset this deployment can hold or price, with its mint and how it is priced. Use this before answering any question about what is available, and never name an asset that is not in the result.",
    parameters: { type: "OBJECT", properties: {} },
  },
  async run() {
    const assets = listAssets();
    const rows: UniverseRow[] = assets.map((a) => ({
      symbol: a.symbol,
      name: a.name,
      assetClass: a.assetClass,
      priceSource: a.priceSource,
      mint: a.mint,
      feed: a.feeds?.primary ?? null,
    }));

    return {
      result: {
        count: rows.length,
        assets: rows.map((r) => ({
          symbol: r.symbol,
          name: r.name,
          assetClass: r.assetClass,
          priceSource: r.priceSource,
        })),
      },
      summary: `${rows.length} assets available`,
      card: { kind: "universe", assets: rows },
    };
  },
};

const getPrices: CopilotTool = {
  label: "Fetching live prices",
  declaration: {
    name: "get_prices",
    description:
      "Live prices for registry symbols. Jupiter prices the tokenized equities from what they actually trade at on Solana, Pyth covers crypto, and PreStocks covers pre IPO names. Returns the traded price, the underlying share or mark where one exists, and the spread between them in basis points. A token above its underlying is at a premium, below it is at a discount. Call this for any question involving a price, a valuation or a discount. Never state a price you did not get from here.",
    parameters: {
      type: "OBJECT",
      properties: {
        symbols: {
          type: "ARRAY",
          description:
            "Symbols to price. Omit to price everything, which is slower.",
          items: { type: "STRING" },
        },
      },
    },
  },
  async run(args) {
    const parsed = z
      .object({ symbols: z.array(z.string().min(1).max(16)).max(20).optional() })
      .parse(args);

    const unknown = (parsed.symbols ?? []).filter((s) => !getAssetBySymbol(s));
    if (unknown.length > 0) {
      throw new ToolError(
        `Not in the registry: ${unknown.join(", ")}. Call list_universe to see what exists.`,
      );
    }

    const snapshot = await snapshotMarket(parsed.symbols);
    const priced = pricedSymbols(snapshot);

    const rows = snapshot.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      price: s.price,
      referencePrice: s.referencePrice,
      spreadBps: s.spreadBps,
      priceSource: s.priceSource,
      unavailable:
        s.price === null
          ? s.priceSource === "pyth"
            ? "Pyth does not serve this feed to our key"
            : s.priceSource === "jupiter"
              ? "Jupiter has no price for this mint right now"
              : "the provider returned no record"
          : null,
    }));

    const missing = rows.filter((r) => r.price === null).map((r) => r.symbol);

    const sources: Source[] = [];
    if (snapshot.some((s) => s.priceSource === "pyth")) {
      sources.push({
        provider: "pyth",
        detail: `${rows.filter((r) => r.priceSource === "pyth" && r.price !== null).length} of ${rows.filter((r) => r.priceSource === "pyth").length} feeds served`,
        ok: !rows.some((r) => r.priceSource === "pyth" && r.price === null),
      });
    }
    if (snapshot.some((s) => s.priceSource === "jupiter")) {
      const all = rows.filter((r) => r.priceSource === "jupiter");
      const served = all.filter((r) => r.price !== null);
      sources.push({
        provider: "jupiter",
        detail: `${served.length} of ${all.length} tokenized equities priced from mainnet trading`,
        ok: served.length === all.length,
      });
    }
    if (snapshot.some((s) => s.priceSource === "prestocks")) {
      sources.push({
        provider: "prestocks",
        detail: `${rows.filter((r) => r.priceSource === "prestocks" && r.price !== null).length} pre IPO names priced`,
        ok: true,
      });
    }

    return {
      result: {
        priced: rows
          .filter((r) => r.price !== null)
          .map((r) => ({
            symbol: r.symbol,
            price: r.price,
            underlying: r.referencePrice,
            spreadBps: r.spreadBps,
          })),
        unpriced: missing,
        note:
          missing.length > 0
            ? "Assets listed under unpriced have no price. Say so plainly rather than estimating one."
            : undefined,
      },
      summary: `${priced.length} priced${missing.length ? `, ${missing.length} unavailable` : ""}`,
      card: { kind: "prices", rows },
      sources,
    };
  },
};

const getMandate: CopilotTool = {
  label: "Reading the mandate",
  declaration: {
    name: "get_mandate",
    description:
      "The mandate account: the limits the program enforces, the permitted assets, the delegated agent and the status. Read this before discussing any limit. These are the binding numbers, not a description of them.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
      },
    },
  },
  async run(args, ctx) {
    const { mandateId = 0 } = z.object({ mandateId: mandateIdArg }).parse(args);
    const { mandate } = await loadMandate(ctx, mandateId);

    return {
      result: {
        status: mandate.status,
        maxPositionBps: mandate.constraints.maxPositionBps,
        minCashBps: mandate.constraints.minCashBps,
        maxTurnoverBps: mandate.constraints.maxTurnoverBps,
        maxAssets: mandate.constraints.maxAssets,
        permitted: mandate.allowedAssets.map(
          (a) => getAssetByMint(a.mint)?.symbol ?? a.mint,
        ),
        agent: mandate.agent,
        rebalanceCount: mandate.rebalanceCount,
      },
      summary: `${mandate.status}, ${mandate.allowedAssets.length} assets permitted`,
      card: { kind: "mandate", mandate },
      sources: SOLANA_SOURCE,
    };
  },
};

const getPortfolio: CopilotTool = {
  label: "Reading the portfolio",
  declaration: {
    name: "get_portfolio",
    description:
      "What the portfolio holds right now, as target weights in basis points, plus cash. Read this before answering anything about positions, exposure or what the person owns.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
      },
    },
  },
  async run(args, ctx) {
    const { mandateId = 0 } = z.object({ mandateId: mandateIdArg }).parse(args);
    const { mandate } = await loadMandate(ctx, mandateId);
    const { portfolio: address } = addresses(ctx, mandateId);

    const portfolio = await fetchPortfolio(getConnection(), address);
    if (!portfolio) {
      throw new ToolError(
        "The mandate exists but has no portfolio account, so there is nothing to hold.",
      );
    }

    const holdings = await fetchHoldings(getConnection(), address, mandate);

    return {
      result: {
        // Targets and holdings are reported separately and labelled, because
        // conflating them is the exact mistake this interface used to make.
        targets: {
          cashBps: portfolio.cashBps,
          positions: portfolio.positions.map((p) => ({
            symbol: getAssetByMint(p.mint)?.symbol ?? p.mint,
            targetBps: p.targetBps,
          })),
          note: "Weights the program enforces. Not custody.",
        },
        holdings: holdings.settleable
          ? {
              cash: holdings.cash?.uiAmount ?? 0,
              assets: holdings.assets
                .filter((a) => a.uiAmount > 0)
                .map((a) => ({ symbol: a.symbol, amount: a.uiAmount })),
              note: holdings.funded
                ? "Actual token balances."
                : "Nothing has been settled yet, so the portfolio owns no tokens.",
            }
          : {
              note: "This mandate permits an asset with no on chain price, so it holds targets only. Every asset in the current registry is priced; this means the mandate names something outside it.",
            },
      },
      summary:
        portfolio.positions.length === 0
          ? "no targets set"
          : `${portfolio.positions.length} targets` +
            (holdings.settleable
              ? holdings.funded
                ? ", settled"
                : ", not yet settled"
              : ", policy only"),
      card: { kind: "portfolio", portfolio, mandate, holdings },
      sources: SOLANA_SOURCE,
    };
  },
};

const getHistory: CopilotTool = {
  label: "Reading the account history",
  declaration: {
    name: "get_history",
    description:
      "Everything that has happened to this mandate, rebuilt from the chain: accepted rebalances with their turnover and cash, and refusals with the clause that stopped them. Use this for any question about what has happened before.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
        limit: { type: "INTEGER", description: "How many entries. Defaults to 12." },
      },
    },
  },
  async run(args, ctx) {
    const { mandateId = 0, limit = 12 } = z
      .object({ mandateId: mandateIdArg, limit: z.number().int().min(1).max(25).optional() })
      .parse(args);

    const { mandate: address } = addresses(ctx, mandateId);
    const records = await fetchActivity(getConnection(), address, { limit });

    const accepted = records.filter((r) => r.kind === "accepted").length;
    const refused = records.filter((r) => r.kind === "refused").length;

    return {
      result: {
        accepted,
        refused,
        entries: records.map((r) =>
          r.kind === "accepted"
            ? {
                kind: "accepted",
                sequence: r.event.sequence,
                positions: r.event.positionCount,
                turnoverBps: r.event.turnoverBps,
                cashBps: r.event.cashBps,
              }
            : r.kind === "refused"
              ? { kind: "refused", error: r.error?.name ?? "unknown" }
              : { kind: r.kind },
        ),
      },
      summary: `${records.length} entries, ${accepted} accepted, ${refused} refused`,
      card: { kind: "history", records },
      sources: SOLANA_SOURCE,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Judging                                                                    */
/* -------------------------------------------------------------------------- */

function weightRows(
  mandate: MandateView,
  current: { mint: string; targetBps: number }[],
  positions: { symbol: string; targetBps: number }[],
): WeightRow[] {
  return positions.map((p) => {
    const asset = getAssetBySymbol(p.symbol);
    if (!asset) throw new ToolError(`${p.symbol} is not in the registry.`);
    if (!mandate.allowedAssets.some((a) => a.mint === asset.mint)) {
      throw new ToolError(
        `${p.symbol} is not in this mandate's permitted universe, so the program would refuse it.`,
      );
    }
    return {
      symbol: p.symbol,
      mint: asset.mint,
      targetBps: p.targetBps,
      currentBps: current.find((c) => c.mint === asset.mint)?.targetBps ?? 0,
    };
  });
}

const positionsArg = {
  type: "ARRAY" as const,
  description: "The proposed allocation. Weights are basis points, 2500 is 25 percent.",
  items: {
    type: "OBJECT" as const,
    properties: {
      symbol: { type: "STRING" as const },
      targetBps: { type: "INTEGER" as const },
    },
    required: ["symbol", "targetBps"],
  },
};

const positionsSchema = z
  .array(
    z.object({
      symbol: z.string().min(1).max(16),
      targetBps: z.number().int().min(0).max(10_000),
    }),
  )
  .min(1)
  .max(MAX_ASSETS);

const checkProposal: CopilotTool = {
  label: "Checking it against the mandate",
  declaration: {
    name: "check_proposal",
    description:
      "Tests an allocation against the mandate exactly as the program would, including turnover, and reports which clause would refuse it first. Use this whenever weights are being discussed. It changes nothing on chain.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
        positions: positionsArg,
      },
      required: ["positions"],
    },
  },
  async run(args, ctx) {
    const { mandateId = 0, positions } = z
      .object({ mandateId: mandateIdArg, positions: positionsSchema })
      .parse(args);

    const { mandate } = await loadMandate(ctx, mandateId);
    const { portfolio: address } = addresses(ctx, mandateId);
    const portfolio = await fetchPortfolio(getConnection(), address);
    const current = portfolio?.positions ?? [];

    const rows = weightRows(mandate, current, positions);
    const evaluation = evaluateProposal({
      constraints: mandate.constraints,
      allowedMints: mandate.allowedAssets.map((a) => a.mint),
      current,
      proposed: rows.map((r) => ({ mint: r.mint, targetBps: r.targetBps })),
    });

    return {
      result: {
        compliant: evaluation.compliant,
        wouldReturn: evaluation.firstRefusal,
        allocatedBps: evaluation.allocatedBps,
        cashBps: evaluation.cashBps,
        turnoverBps: evaluation.turnoverBps,
        violations: evaluation.violations.map((v) => v.detail),
      },
      summary: evaluation.compliant
        ? `within the mandate, ${evaluation.turnoverBps} bps turnover`
        : `would be refused with ${evaluation.firstRefusal}`,
      card: { kind: "verdict", evaluation, positions: rows },
    };
  },
};

const runAnalysis: CopilotTool = {
  label: "Running the five stage analysis",
  declaration: {
    name: "run_analysis",
    description:
      "Runs the full research pipeline over live prices and produces a proposed allocation with a thesis per position. Five stages: research, then bull and bear independently, then risk, then a portfolio manager. Takes around twenty seconds, so only call it when an allocation is actually wanted, not to answer a simple question.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
        objective: {
          type: "STRING",
          description:
            "What the allocation should aim for, in the person's own words where they gave them.",
        },
      },
      required: ["objective"],
    },
  },
  async run(args, ctx) {
    const { mandateId = 0, objective } = z
      .object({ mandateId: mandateIdArg, objective: z.string().min(1).max(2000) })
      .parse(args);

    const { mandate } = await loadMandate(ctx, mandateId);
    const { portfolio: address } = addresses(ctx, mandateId);
    const portfolio = await fetchPortfolio(getConnection(), address);
    const current = portfolio?.positions ?? [];

    const symbols = mandate.allowedAssets
      .map((a) => getAssetByMint(a.mint)?.symbol)
      .filter((s): s is string => Boolean(s));

    ctx.onProgress?.("Pricing the permitted universe");
    const snapshot = await snapshotMarket(symbols);
    const tradable = snapshot.filter((s) => s.price !== null);
    const excluded = snapshot.filter((s) => s.price === null).map((s) => s.symbol);

    if (tradable.length === 0) {
      throw new ToolError(
        "No permitted asset currently has a price, so no allocation could be justified.",
      );
    }

    const spec: MandateSpec = {
      objective,
      maxPositionBps: mandate.constraints.maxPositionBps,
      minCashBps: mandate.constraints.minCashBps,
      maxTurnoverBps: mandate.constraints.maxTurnoverBps,
      maxAssets: Math.min(mandate.constraints.maxAssets, tradable.length),
      allowedSymbols: pricedSymbols(tradable),
      currentPositions: current.flatMap((p) => {
        const known = getAssetByMint(p.mint);
        return known ? [{ symbol: known.symbol, targetBps: p.targetBps }] : [];
      }),
    };

    ctx.onProgress?.("Research, bull and bear, risk, then the manager");
    const run = await runPipeline(spec, tradable);

    const rows = weightRows(
      mandate,
      current,
      run.proposal.positions.map((p) => ({
        symbol: p.symbol,
        targetBps: p.targetBps,
      })),
    );

    const evaluation = evaluateProposal({
      constraints: mandate.constraints,
      allowedMints: mandate.allowedAssets.map((a) => a.mint),
      current,
      proposed: rows.map((r) => ({ mint: r.mint, targetBps: r.targetBps })),
    });

    return {
      result: {
        positions: run.proposal.positions.map((p) => ({
          symbol: p.symbol,
          targetBps: p.targetBps,
        })),
        reasoning: run.proposal.reasoning,
        confidence: run.proposal.confidence,
        compliant: evaluation.compliant,
        wouldReturn: evaluation.firstRefusal,
        turnoverBps: evaluation.turnoverBps,
        cashBps: evaluation.cashBps,
        excluded,
        note: "The allocation is a proposal. It has not been submitted and will not be unless the person approves it.",
      },
      summary: `${run.proposal.positions.length} positions, ${evaluation.compliant ? "within the mandate" : `would be refused with ${evaluation.firstRefusal}`}`,
      card: {
        kind: "analysis",
        analysis: {
          positions: rows.map((r) => {
            const source = run.proposal.positions.find((p) => p.symbol === r.symbol);
            // The snapshot the manager actually reasoned over, carried through
            // rather than thrown away, so the card can show what each weight
            // was chosen against.
            const market = tradable.find((m) => m.symbol === r.symbol);
            return {
              symbol: r.symbol,
              mint: r.mint,
              targetBps: r.targetBps,
              currentBps: r.currentBps,
              thesis: source?.thesis ?? "",
              thesisBreakers: source?.thesisBreakers ?? [],
              price: market?.price ?? null,
              referencePrice: market?.referencePrice ?? null,
              spreadBps: market?.spreadBps ?? null,
            };
          }),
          reasoning: run.proposal.reasoning,
          confidence: run.proposal.confidence,
          marketSummary: run.research.marketSummary,
          bull: run.bull.cases,
          bear: run.bear.cases,
          riskConcerns: run.risk.portfolioConcerns,
          riskCeilings: run.risk.assessments,
          stages: run.stages.map((s) => ({
            stage: s.stage,
            model: s.model,
            durationMs: s.durationMs,
          })),
          evaluation,
          excludedForMissingPrice: excluded,
        },
      },
      sources: [
        { provider: "pyth", detail: "live feeds for listed and crypto names", ok: true },
        { provider: "prestocks", detail: "pre IPO marks", ok: true },
        {
          provider: "gemini",
          detail: `${run.stages.length} reasoning stages, judgement not fact`,
          ok: true,
        },
      ],
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Acting, all of which needs a person to agree                               */
/* -------------------------------------------------------------------------- */

const proposeRebalance: CopilotTool = {
  label: "Preparing the rebalance",
  declaration: {
    name: "propose_rebalance",
    description:
      "Prepares a rebalance for the person to approve. This does NOT submit anything: it returns a card with the allocation and what the chain would do, and the person decides. Say plainly that it is waiting on them.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
        positions: positionsArg,
      },
      required: ["positions"],
    },
  },
  async run(args, ctx) {
    const { mandateId = 0, positions } = z
      .object({ mandateId: mandateIdArg, positions: positionsSchema })
      .parse(args);

    const { mandate, address } = await loadMandate(ctx, mandateId);
    const { portfolio: portfolioAddress } = addresses(ctx, mandateId);
    const portfolio = await fetchPortfolio(getConnection(), portfolioAddress);
    const current = portfolio?.positions ?? [];

    const rows = weightRows(mandate, current, positions);
    const evaluation = evaluateProposal({
      constraints: mandate.constraints,
      allowedMints: mandate.allowedAssets.map((a) => a.mint),
      current,
      proposed: rows.map((r) => ({ mint: r.mint, targetBps: r.targetBps })),
    });

    return {
      result: {
        prepared: true,
        compliant: evaluation.compliant,
        wouldReturn: evaluation.firstRefusal,
        note: "Waiting for the person to approve. Nothing has been sent.",
      },
      summary: evaluation.compliant
        ? "prepared, awaiting approval"
        : `prepared, but the chain would refuse it with ${evaluation.firstRefusal}`,
      action: {
        kind: "submit-rebalance",
        mandate: address.toBase58(),
        positions: rows,
        evaluation,
        summary: evaluation.compliant
          ? `${rows.length} positions. ${bpsToPercent(evaluation.turnoverBps)} of the book changes hands, leaving ${bpsToPercent(evaluation.cashBps)} in cash.`
          : `The program would refuse this with ${evaluation.firstRefusal}. Submitting it anyway records the refusal on chain.`,
      },
    };
  },
};

const prepareMandate: CopilotTool = {
  label: "Drafting the mandate",
  declaration: {
    name: "prepare_mandate",
    description:
      "Prepares a new mandate for the owner to sign. Choose limits that match what the person asked for. This does NOT create anything: the owner signs it themselves. If the limits are incoherent the tool will say so and you should fix them and call again.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which slot. Defaults to 0." },
        maxPositionBps: { type: "INTEGER", description: "Largest single position, basis points." },
        minCashBps: { type: "INTEGER", description: "Cash that must always remain." },
        maxTurnoverBps: { type: "INTEGER", description: "Most that may change hands per rebalance." },
        maxAssets: { type: "INTEGER", description: `Most simultaneous positions, 1 to ${MAX_ASSETS}.` },
        symbols: {
          type: "ARRAY",
          description: "The permitted universe, from the registry only.",
          items: { type: "STRING" },
        },
      },
      required: [
        "maxPositionBps",
        "minCashBps",
        "maxTurnoverBps",
        "maxAssets",
        "symbols",
      ],
    },
  },
  async run(args, ctx) {
    const input = z
      .object({
        mandateId: mandateIdArg,
        maxPositionBps: z.number().int(),
        minCashBps: z.number().int(),
        maxTurnoverBps: z.number().int(),
        maxAssets: z.number().int(),
        symbols: z.array(z.string().min(1).max(16)).min(1).max(MAX_ASSETS),
      })
      .parse(args);

    requireOwner(ctx);

    const violations = [
      ...validateConstraints(input),
      ...validateUniverse(input.symbols),
    ];

    if (violations.length > 0) {
      throw new ToolError(
        `These limits would be refused: ${violations
          .map((v) => `${v.onChainError} (${v.message})`)
          .join("; ")}`,
      );
    }

    const agent = getAgentIdentity();
    if (!agent.configured) {
      throw new ToolError(
        `No agent key is configured, so there is nothing to delegate to: ${agent.reason}`,
      );
    }

    const mandateId = input.mandateId ?? 0;

    return {
      result: {
        prepared: true,
        note: "Waiting for the owner to sign. Nothing has been created.",
      },
      summary: `drafted, ${input.symbols.length} assets, awaiting signature`,
      action: {
        kind: "create-mandate",
        draft: {
          mandateId,
          maxPositionBps: input.maxPositionBps,
          minCashBps: input.minCashBps,
          maxTurnoverBps: input.maxTurnoverBps,
          maxAssets: input.maxAssets,
          symbols: input.symbols,
          agent: agent.publicKey,
        },
        summary:
          `No single position above ${bpsToPercent(input.maxPositionBps)}. ` +
          `At least ${bpsToPercent(input.minCashBps)} held in cash. ` +
          `At most ${bpsToPercent(input.maxTurnoverBps)} of the book may change hands in one rebalance. ` +
          `Up to ${input.maxAssets} positions, chosen from ${input.symbols.join(", ")}.`,
      },
    };
  },
};

const setStatus: CopilotTool = {
  label: "Preparing the status change",
  declaration: {
    name: "set_mandate_status",
    description:
      "Prepares a pause, resume or permanent close for the owner to sign. Pausing stops the agent proposing while leaving positions untouched. Closing is permanent and can never be undone, so say so before preparing one.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
        status: {
          type: "STRING",
          description: "The new status.",
          enum: ["active", "paused", "closed"],
        },
      },
      required: ["status"],
    },
  },
  async run(args, ctx) {
    const { mandateId = 0, status } = z
      .object({
        mandateId: mandateIdArg,
        status: z.enum(["active", "paused", "closed"]),
      })
      .parse(args);

    const { mandate, address } = await loadMandate(ctx, mandateId);

    if (mandate.status === "closed") {
      throw new ToolError(
        "This mandate is closed. That is permanent and cannot be changed.",
      );
    }
    if (mandate.status === status) {
      throw new ToolError(`The mandate is already ${status}.`);
    }

    return {
      result: { prepared: true, from: mandate.status, to: status },
      summary: `${mandate.status} to ${status}, awaiting signature`,
      action: {
        kind: "set-status",
        mandate: address.toBase58(),
        status,
        summary:
          status === "closed"
            ? "Closing is permanent. The agent will never propose again under this mandate."
            : status === "paused"
              ? "The agent stops proposing. Positions are untouched and it can be resumed."
              : "The agent may propose again.",
      },
    };
  },
};

const fundPortfolio: CopilotTool = {
  label: "Preparing demo cash",
  declaration: {
    name: "fund_portfolio",
    description:
      "Prepares a devnet top up of demo cash into the portfolio, and creates the token accounts settlement needs. Use it when a portfolio has no cash to settle with, typically right after a mandate is created. The cash is worthless test currency from a faucet, not a deposit, and nothing leaves the person's wallet. This does NOT execute: it returns a card the person approves.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
      },
    },
  },
  async run(args, ctx) {
    const { mandateId = 0 } = z.object({ mandateId: mandateIdArg }).parse(args);
    const { mandate, address } = await loadMandate(ctx, mandateId);

    const { portfolio: portfolioAddress } = addresses(ctx, mandateId);
    const holdings = await fetchHoldings(getConnection(), portfolioAddress, mandate);
    const cash = holdings.cash?.uiAmount ?? 0;

    if (cash >= FUND_UNITS) {
      throw new ToolError(
        `The portfolio already holds ${cash.toLocaleString()} in cash, at or above the ${FUND_UNITS.toLocaleString()} the faucet tops up to. There is nothing to add.`,
      );
    }

    return {
      result: {
        prepared: true,
        currentCash: cash,
        topUpTo: FUND_UNITS,
        note: "Waiting for the person to approve. Devnet demo cash, not a deposit.",
      },
      summary: `ready to top up to ${FUND_UNITS.toLocaleString()} demo cash`,
      action: {
        kind: "fund",
        mandate: address.toBase58(),
        summary: `Top the portfolio up to ${FUND_UNITS.toLocaleString()} in devnet demo cash and open the token accounts settlement needs. Paid by a faucet: nothing leaves your wallet, and the cash has no value outside this demo.`,
      },
    };
  },
};

const settlePortfolio: CopilotTool = {
  label: "Preparing the settlement",
  declaration: {
    name: "settle_portfolio",
    description:
      "Prepares a settlement, which moves real tokens until the portfolio actually holds what it targets. Everything before this is policy: a position is a weight the program enforces, not custody. Works for any mandate over the registry: crypto, tokenized equities and pre IPO names are all priced on chain. This does NOT execute: it returns a card the person approves.",
    parameters: {
      type: "OBJECT",
      properties: {
        mandateId: { type: "INTEGER", description: "Which mandate. Defaults to 0." },
      },
    },
  },
  async run(args, ctx) {
    const { mandateId = 0 } = z.object({ mandateId: mandateIdArg }).parse(args);
    const { mandate, address } = await loadMandate(ctx, mandateId);

    if (!isSettleable(mandate)) {
      const blocked = mandate.allowedAssets
        .filter((a) => !settleableAsset(a.mint))
        .map((a) => getAssetByMint(a.mint)?.symbol ?? a.mint);

      throw new ToolError(
        `This mandate cannot be settled on chain. Settlement needs a price the program can read itself, and there is none for ${blocked.join(", ")}.`,
      );
    }

    const { portfolio: portfolioAddress } = addresses(ctx, mandateId);
    const portfolio = await fetchPortfolio(getConnection(), portfolioAddress);

    if (!portfolio || portfolio.positions.length === 0) {
      throw new ToolError(
        "There are no targets to settle into. Propose and approve a rebalance first.",
      );
    }

    const holdings = await fetchHoldings(getConnection(), portfolioAddress, mandate);

    if (!holdings.funded) {
      throw new ToolError(
        "The portfolio has no cash and no tokens, so there is nothing to settle with. It has to be funded before it can hold anything. Offer to top it up with devnet demo cash using fund_portfolio.",
      );
    }

    const targets = portfolio.positions
      .map(
        (p) =>
          `${getAssetByMint(p.mint)?.symbol ?? p.mint} at ${bpsToPercent(p.targetBps)}`,
      )
      .join(", ");

    return {
      result: {
        prepared: true,
        targets: portfolio.positions.map((p) => ({
          symbol: getAssetByMint(p.mint)?.symbol ?? p.mint,
          targetBps: p.targetBps,
        })),
        note: "Waiting for the person to approve. No tokens have moved.",
      },
      summary: `ready to settle ${portfolio.positions.length} positions`,
      action: {
        kind: "settle",
        mandate: address.toBase58(),
        summary: `Buy and sell until the portfolio actually holds ${targets}. Prices come from the Pyth accounts the mandate named, and the program checks the result against the mandate again once the tokens have moved.`,
      },
    };
  },
};

export const TOOLS: Record<string, CopilotTool> = {
  list_universe: listUniverse,
  get_prices: getPrices,
  get_mandate: getMandate,
  get_portfolio: getPortfolio,
  get_history: getHistory,
  check_proposal: checkProposal,
  run_analysis: runAnalysis,
  propose_rebalance: proposeRebalance,
  prepare_mandate: prepareMandate,
  set_mandate_status: setStatus,
  fund_portfolio: fundPortfolio,
  settle_portfolio: settlePortfolio,
};

export const TOOL_DECLARATIONS: ToolDeclaration[] = Object.values(TOOLS).map(
  (t) => t.declaration,
);

export { ToolError };
