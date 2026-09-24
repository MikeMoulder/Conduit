"use client";

import { useMemo, useState } from "react";

import { getAssetByMint, getAssetBySymbol } from "@/lib/assets";
import { CLUSTER } from "@/lib/cluster";
import { bpsToPercent, explorerUrl, type ProgramErrorInfo } from "@/lib/chain";
import type { MandateView, PortfolioView } from "@/lib/accounts";
import { evaluateProposal, type ProposalEvaluation } from "@/lib/proposal";

/**
 * Reviewing what the agent wants to do, and sending it.
 *
 * The weights are editable. That is not a convenience feature, it is the point
 * of the screen. An allocation nobody can alter is one you have to take on
 * trust, and the claim being made here is the opposite: that it does not matter
 * what is submitted, because the mandate is what decides. Being able to push a
 * weight past a limit and watch the chain refuse it is the demonstration.
 *
 * Every edit is re-evaluated against the mandate as it exists on chain, and the
 * panel names the error the program would return. Submitting anyway is allowed,
 * and is the only way to see the difference between a prediction and an
 * enforcement.
 */

interface ProposalPosition {
  symbol: string;
  targetBps: number;
  thesis: string;
  thesisBreakers: string[];
}

interface PipelineResponse {
  proposal: {
    positions: ProposalPosition[];
    reasoning: string;
    confidence: number;
  };
  research: { marketSummary: string };
  bull: { cases: { symbol: string; argument: string; weight: number }[] };
  bear: { cases: { symbol: string; argument: string; weight: number }[] };
  risk: {
    portfolioConcerns: string[];
    assessments: { symbol: string; maxRecommendedBps: number; concern: string }[];
  };
  stages: { stage: string; model: string; durationMs: number }[];
  totalDurationMs: number;
  excludedForMissingPrice: string[];
}

interface SubmitResponse {
  accepted: boolean;
  signature?: string;
  slot?: number;
  stage?: string;
  outcome?: string;
  detail?: string;
  error?: string;
  programError?: ProgramErrorInfo | null;
  portfolio?: PortfolioView;
  evaluation?: ProposalEvaluation;
}

const DEFAULT_OBJECTIVE =
  "Put the cash to work under this mandate. Favour quality over excitement, " +
  "and size each position for what would happen if you are wrong.";

export function ProposalReview({
  mandate,
  portfolio,
  onSubmitted,
}: {
  mandate: MandateView;
  portfolio: PortfolioView;
  /**
   * Called after any submission settles, accepted or refused. The portfolio is
   * only supplied when it changed. A refusal is submitted without preflight so
   * that it lands, which means the history moves either way and the feed has to
   * be told either way.
   */
  onSubmitted: (portfolio: PortfolioView | null) => void;
}) {
  const [objective, setObjective] = useState(DEFAULT_OBJECTIVE);
  const [running, setRunning] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineResponse | null>(null);

  /** Keyed by mint, because the chain works in mints and symbols only label them. */
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submission, setSubmission] = useState<SubmitResponse | null>(null);

  const proposed = useMemo(
    () =>
      Object.entries(weights)
        .filter(([, bps]) => bps > 0)
        .map(([mint, targetBps]) => ({ mint, targetBps })),
    [weights],
  );

  const evaluation = useMemo(
    () =>
      evaluateProposal({
        constraints: mandate.constraints,
        allowedMints: mandate.allowedAssets.map((a) => a.mint),
        current: portfolio.positions,
        proposed,
      }),
    [mandate, portfolio, proposed],
  );

  async function run() {
    setRunning(true);
    setPipelineError(null);
    setSubmission(null);
    try {
      const response = await fetch("/api/agent/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mandate: mandate.address, objective }),
      });
      const data = await response.json();

      if (!response.ok) {
        setPipelineError(data.detail ?? data.error ?? "the agent failed");
        return;
      }

      const pipeline = data as PipelineResponse;
      setResult(pipeline);

      const next: Record<string, number> = {};
      for (const position of pipeline.proposal.positions) {
        const asset = getAssetBySymbol(position.symbol);
        if (asset) next[asset.mint] = position.targetBps;
      }
      setWeights(next);
    } catch (error) {
      setPipelineError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    setSubmission(null);
    try {
      const response = await fetch("/api/agent/rebalance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mandate: mandate.address, positions: proposed }),
      });
      const data = (await response.json()) as SubmitResponse;
      setSubmission(data);
      onSubmitted(data.accepted && data.portfolio ? data.portfolio : null);
    } catch (error) {
      setSubmission({
        accepted: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const paused = mandate.status !== "active";

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-200">What to aim for</h2>
          <p className="text-xs leading-relaxed text-zinc-500">
            The agent reads this alongside live prices. It reads the limits from
            the mandate account, not from this box.
          </p>
        </div>
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-xl border border-line bg-zinc-950 px-3 py-2 text-sm leading-relaxed text-zinc-100 focus:border-emerald-500 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || objective.trim().length === 0}
            className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Five stages running" : "Ask the agent"}
          </button>
          {running ? (
            <span className="text-xs text-zinc-500">
              research, then bull and bear independently, then risk, then the
              manager. Around twenty seconds.
            </span>
          ) : null}
        </div>
        {pipelineError ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
            {pipelineError}
          </p>
        ) : null}
      </section>

      {result ? (
        <>
          <Reasoning result={result} />

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium text-zinc-200">
                  Proposed allocation
                </h2>
                <p className="text-xs leading-relaxed text-zinc-500">
                  Editable. Push a weight past a limit and the panel below names
                  the error the program would return. Submitting anyway is the
                  point.
                </p>
              </div>
              <span className="font-mono text-xs text-zinc-500">
                confidence {result.proposal.confidence}/100
              </span>
            </div>

            <div className="overflow-hidden rounded-2xl border border-line">
              {result.proposal.positions.map((position) => {
                const asset = getAssetBySymbol(position.symbol);
                if (!asset) return null;
                const bps = weights[asset.mint] ?? 0;
                const previous =
                  portfolio.positions.find((p) => p.mint === asset.mint)
                    ?.targetBps ?? 0;
                const breached = bps > mandate.constraints.maxPositionBps;

                return (
                  <div
                    key={asset.mint}
                    className="flex flex-col gap-2 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="flex items-baseline gap-2">
                        <span className="text-sm font-medium text-zinc-100">
                          {position.symbol}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {asset.name}
                        </span>
                        {previous > 0 ? (
                          <span className="font-mono text-[11px] text-zinc-600">
                            held {bpsToPercent(previous)}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={10_000}
                          step={100}
                          value={bps}
                          onChange={(e) =>
                            setWeights({
                              ...weights,
                              [asset.mint]: Number(e.target.value),
                            })
                          }
                          className={`w-24 rounded-md border bg-zinc-950 px-2 py-1 text-right font-mono text-sm focus:outline-none ${
                            breached
                              ? "border-red-500/60 text-red-300"
                              : "border-zinc-800 text-zinc-100 focus:border-emerald-500"
                          }`}
                        />
                        <span className="w-12 text-right font-mono text-xs text-zinc-500">
                          {bpsToPercent(bps)}
                        </span>
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-zinc-400">
                      {position.thesis}
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {position.thesisBreakers.map((breaker, i) => (
                        <li key={i} className="text-[11px] text-zinc-600">
                          would change this: {breaker}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>

          <Verdict
            evaluation={evaluation}
            mandate={mandate}
            paused={paused}
            submitting={submitting}
            onSubmit={() => void submit()}
          />

          {submission ? <SubmissionResult submission={submission} /> : null}
        </>
      ) : null}
    </div>
  );
}

function Verdict({
  evaluation,
  mandate,
  paused,
  submitting,
  onSubmit,
}: {
  evaluation: ProposalEvaluation;
  mandate: MandateView;
  paused: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="allocated"
          value={bpsToPercent(evaluation.allocatedBps)}
          raw={`${evaluation.allocatedBps} bps`}
        />
        <Metric
          label="cash left"
          value={bpsToPercent(evaluation.cashBps)}
          raw={`floor ${mandate.constraints.minCashBps} bps`}
          bad={evaluation.cashBps < mandate.constraints.minCashBps}
        />
        <Metric
          label="turnover"
          value={bpsToPercent(evaluation.turnoverBps)}
          raw={`limit ${mandate.constraints.maxTurnoverBps} bps`}
          bad={evaluation.turnoverBps > mandate.constraints.maxTurnoverBps}
        />
      </div>

      {evaluation.compliant ? (
        <p className="text-sm text-emerald-400">
          Within the mandate on every clause.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-300">
            The program would refuse this, returning{" "}
            <span className="font-mono">{evaluation.firstRefusal}</span>.
          </p>
          <ul className="flex flex-col gap-1">
            {evaluation.violations.map((v, i) => (
              <li key={i} className="text-xs leading-relaxed text-red-200/70">
                <span className="text-red-200/50">{v.rule}:</span> {v.detail}
                {v.mint ? (
                  <span className="ml-1 text-red-200/50">
                    ({getAssetByMint(v.mint)?.symbol ?? v.mint.slice(0, 8)})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {paused ? (
        <p className="text-sm text-amber-400">
          This mandate is {mandate.status}. The program refuses every proposal
          with MandateNotActive until the owner resumes it.
        </p>
      ) : null}

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting || evaluation.allocatedBps === 0}
        className={`self-start rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          evaluation.compliant
            ? "bg-emerald-500 text-black hover:bg-emerald-400"
            : "border border-red-500/50 text-red-300 hover:bg-red-500/10"
        }`}
      >
        {submitting
          ? "The agent is signing"
          : evaluation.compliant
            ? "Submit as the agent"
            : "Submit anyway and let the chain refuse it"}
      </button>
      <p className="text-xs leading-relaxed text-zinc-600">
        Signed by the agent key, not by your wallet. The agent can reach this one
        instruction and nothing else.
      </p>
    </section>
  );
}

function SubmissionResult({ submission }: { submission: SubmitResponse }) {
  if (submission.accepted) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
        <p className="text-sm text-emerald-300">
          Accepted on chain at slot {submission.slot}. The portfolio now holds
          what the agent proposed.
        </p>
        {submission.signature ? (
          <a
            href={explorerUrl(submission.signature, "tx", CLUSTER)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-emerald-400 underline underline-offset-4"
          >
            {submission.signature.slice(0, 12)}..{submission.signature.slice(-12)}
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
      <p className="text-sm font-medium text-red-300">Refused on chain.</p>
      {submission.programError ? (
        <>
          <p className="font-mono text-sm text-red-200">
            {submission.programError.name}
          </p>
          <p className="text-sm leading-relaxed text-red-200/80">
            {submission.programError.message}
          </p>
          <p className="text-xs text-red-200/50">
            error {submission.programError.code}, returned by the program. No
            client check stopped this. The transaction was sent and the cluster
            rejected it.
          </p>
        </>
      ) : (
        <p className="text-sm leading-relaxed text-red-200/80">
          {submission.detail ?? submission.error ?? "no detail given"}
        </p>
      )}
      {submission.signature ? (
        <a
          href={explorerUrl(submission.signature, "tx", CLUSTER)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-red-300 underline underline-offset-4"
        >
          {submission.signature.slice(0, 12)}..{submission.signature.slice(-12)}
        </a>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  raw,
  bad,
}: {
  label: string;
  value: string;
  raw: string;
  bad?: boolean;
}) {
  return (
    <div>
      <span className="block text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span
        className={`block font-mono text-lg ${bad ? "text-red-400" : "text-zinc-100"}`}
      >
        {value}
      </span>
      <span className="block font-mono text-[11px] text-zinc-600">{raw}</span>
    </div>
  );
}

function Reasoning({ result }: { result: PipelineResponse }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-200">How it got there</h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-zinc-500 underline underline-offset-4 hover:text-zinc-300"
        >
          {open ? "hide the stages" : "show all five stages"}
        </button>
      </div>

      <p className="rounded-2xl border border-line bg-zinc-900/40 px-4 py-3 text-sm leading-relaxed text-zinc-300">
        {result.proposal.reasoning}
      </p>

      {open ? (
        <div className="flex flex-col gap-4">
          <Stage title="Research">
            <p>{result.research.marketSummary}</p>
          </Stage>

          <div className="grid gap-4 md:grid-cols-2">
            <Stage title="Bull" accent="text-emerald-400">
              <Cases cases={result.bull.cases} />
            </Stage>
            <Stage title="Bear" accent="text-red-400">
              <Cases cases={result.bear.cases} />
            </Stage>
          </div>
          <p className="text-xs text-zinc-600">
            Bull and bear run at the same time and never see each other. The
            manager receives two independent readings rather than a negotiated
            middle.
          </p>

          <Stage title="Risk">
            <ul className="flex flex-col gap-1">
              {result.risk.portfolioConcerns.map((concern, i) => (
                <li key={i}>{concern}</li>
              ))}
            </ul>
            <ul className="mt-2 flex flex-col gap-1">
              {result.risk.assessments.map((a, i) => (
                <li key={i} className="text-zinc-500">
                  <span className="font-mono text-zinc-400">{a.symbol}</span> at
                  most {bpsToPercent(a.maxRecommendedBps)}, {a.concern}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-zinc-600">
              Advisory. The mandate is the binding limit and the chain enforces
              it. This stage can lower a weight, never raise a cap.
            </p>
          </Stage>

          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-zinc-600">
            {result.stages.map((s) => (
              <span key={s.stage} className="font-mono">
                {s.stage} {Math.round(s.durationMs / 100) / 10}s {s.model}
              </span>
            ))}
            <span className="font-mono">
              total {Math.round(result.totalDurationMs / 100) / 10}s
            </span>
          </div>
        </div>
      ) : null}

      {result.excludedForMissingPrice.length > 0 ? (
        <p className="text-xs text-amber-400/80">
          Left out for want of a price:{" "}
          {result.excludedForMissingPrice.join(", ")}. An asset with no price
          cannot be reasoned about, and offering it invites an allocation
          justified by nothing.
        </p>
      ) : null}
    </section>
  );
}

function Stage({
  title,
  accent,
  children,
}: {
  title: string;
  accent?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line px-4 py-3">
      <h3
        className={`mb-2 text-xs uppercase tracking-wide ${accent ?? "text-zinc-500"}`}
      >
        {title}
      </h3>
      <div className="flex flex-col gap-1 text-xs leading-relaxed text-zinc-400">
        {children}
      </div>
    </div>
  );
}

function Cases({
  cases,
}: {
  cases: { symbol: string; argument: string; weight: number }[];
}) {
  return (
    <ul className="flex flex-col gap-2">
      {cases.map((c, i) => (
        <li key={i}>
          <span className="font-mono text-zinc-300">{c.symbol}</span>
          <span className="ml-2 text-zinc-600">{c.weight}/10</span>
          <span className="block">{c.argument}</span>
        </li>
      ))}
    </ul>
  );
}
