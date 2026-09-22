"use client";

import { useState } from "react";

import { CLUSTER } from "@/lib/cluster";
import { bpsToPercent, explorerUrl } from "@/lib/chain";
import { getAssetByMint } from "@/lib/assets";
import type { Card } from "@/lib/copilot/events";

/**
 * Structured answers, drawn rather than described.
 *
 * A price, a holding or a refusal is a fact with a shape, and prose is a poor
 * container for one. The copilot is told not to repeat what these show, so the
 * text beside a card should say what it means while the card says what it is.
 */

export function CardView({ card }: { card: Card }) {
  switch (card.kind) {
    case "universe":
      return <UniverseCard card={card} />;
    case "prices":
      return <PricesCard card={card} />;
    case "mandate":
      return <MandateCard card={card} />;
    case "portfolio":
      return <PortfolioCard card={card} />;
    case "history":
      return <HistoryCard card={card} />;
    case "analysis":
      return <AnalysisCard card={card} />;
    case "verdict":
      return <VerdictCard card={card} />;
    case "submission":
      return <SubmissionCard card={card} />;
  }
}

function Shell({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60">
      <div className="flex items-baseline justify-between gap-3 border-b border-zinc-900 px-4 py-2.5">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
          {title}
        </span>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Row({
  children,
  last,
}: {
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 px-4 py-2 ${
        last ? "" : "border-b border-zinc-900/70"
      }`}
    >
      {children}
    </div>
  );
}

function money(value: number): string {
  return value >= 1000
    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Positive is a premium, negative a discount. Both are worth seeing signed. */
function Spread({ bps }: { bps: number | null }) {
  if (bps === null) return <span className="text-zinc-700">no underlying</span>;
  const tone = bps > 0 ? "text-amber-400" : bps < 0 ? "text-emerald-400" : "text-zinc-500";
  return (
    <span className={tone}>
      {bps > 0 ? "+" : ""}
      {bps} bps
    </span>
  );
}

function UniverseCard({ card }: { card: Extract<Card, { kind: "universe" }> }) {
  const [open, setOpen] = useState(false);
  const shown = open ? card.assets : card.assets.slice(0, 6);

  return (
    <Shell
      title={`${card.assets.length} assets available`}
      aside={
        card.assets.length > 6 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-zinc-500 underline underline-offset-4 hover:text-zinc-300"
          >
            {open ? "show fewer" : `show all ${card.assets.length}`}
          </button>
        ) : null
      }
    >
      {shown.map((asset, i) => (
        <Row key={asset.symbol} last={i === shown.length - 1}>
          <span className="flex items-baseline gap-2">
            <span className="text-sm text-zinc-200">{asset.symbol}</span>
            <span className="text-xs text-zinc-500">{asset.name}</span>
          </span>
          <span className="font-mono text-[11px] text-zinc-600">
            {asset.feed
              ? `pyth ${asset.feed.slice(0, 6)}`
              : `${asset.priceSource}, no pyth feed`}
          </span>
        </Row>
      ))}
    </Shell>
  );
}

function PricesCard({ card }: { card: Extract<Card, { kind: "prices" }> }) {
  return (
    <Shell title="Prices">
      {card.rows.map((row, i) => (
        <Row key={row.symbol} last={i === card.rows.length - 1}>
          <span className="flex items-baseline gap-2">
            <span className="text-sm text-zinc-200">{row.symbol}</span>
            <span className="hidden text-xs text-zinc-500 sm:inline">
              {row.name}
            </span>
          </span>
          {row.price === null ? (
            <span className="text-xs text-amber-400/80">{row.unavailable}</span>
          ) : (
            <span className="flex items-baseline gap-3 font-mono text-sm">
              <span className="text-zinc-100">{money(row.price)}</span>
              {row.referencePrice !== null ? (
                <span className="text-[11px] text-zinc-600">
                  vs {money(row.referencePrice)}
                </span>
              ) : null}
              <span className="text-[11px]">
                <Spread bps={row.spreadBps} />
              </span>
            </span>
          )}
        </Row>
      ))}
    </Shell>
  );
}

function MandateCard({ card }: { card: Extract<Card, { kind: "mandate" }> }) {
  const { mandate } = card;
  const tone =
    mandate.status === "active"
      ? "text-emerald-400"
      : mandate.status === "paused"
        ? "text-amber-400"
        : "text-red-400";

  return (
    <Shell
      title="The mandate"
      aside={<span className={`font-mono text-[11px] ${tone}`}>{mandate.status}</span>}
    >
      <div className="grid grid-cols-2 gap-px bg-zinc-900 sm:grid-cols-4">
        <Limit label="max position" value={bpsToPercent(mandate.constraints.maxPositionBps)} />
        <Limit label="min cash" value={bpsToPercent(mandate.constraints.minCashBps)} />
        <Limit label="max turnover" value={bpsToPercent(mandate.constraints.maxTurnoverBps)} />
        <Limit label="max positions" value={String(mandate.constraints.maxAssets)} />
      </div>
      <div className="flex flex-wrap gap-1.5 px-4 py-3">
        {mandate.allowedAssets.map((a) => (
          <span
            key={a.mint}
            title={a.mint}
            className="rounded-full border border-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400"
          >
            {getAssetByMint(a.mint)?.symbol ?? `${a.mint.slice(0, 6)}..`}
          </span>
        ))}
      </div>
      <p className="border-t border-zinc-900 px-4 py-2.5 text-[11px] leading-relaxed text-zinc-600">
        The agent may propose a rebalance. It cannot amend these limits, widen
        this list, replace itself or withdraw.
      </p>
    </Shell>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-950 px-4 py-2.5">
      <span className="block text-[10px] uppercase tracking-wide text-zinc-600">
        {label}
      </span>
      <span className="block font-mono text-sm text-zinc-100">{value}</span>
    </div>
  );
}

function PortfolioCard({ card }: { card: Extract<Card, { kind: "portfolio" }> }) {
  const { portfolio, mandate } = card;
  const cap = mandate?.constraints.maxPositionBps ?? null;

  return (
    <Shell
      title="Held now"
      aside={
        <span className="font-mono text-[11px] text-zinc-500">
          {bpsToPercent(10_000 - portfolio.cashBps)} invested
        </span>
      }
    >
      {portfolio.positions.length === 0 ? (
        <p className="px-4 py-3 text-sm text-zinc-500">
          Fully in cash. No well formed mandate can forbid that, which is why a
          portfolio opens this way.
        </p>
      ) : (
        portfolio.positions.map((p) => {
          const asset = getAssetByMint(p.mint);
          const share = cap ? Math.min(100, (p.targetBps / cap) * 100) : 0;
          return (
            <Row key={p.mint}>
              <span className="flex items-baseline gap-2">
                <span className="text-sm text-zinc-200">
                  {asset?.symbol ?? `${p.mint.slice(0, 8)}..`}
                </span>
                <span className="hidden text-xs text-zinc-500 sm:inline">
                  {asset?.name}
                </span>
              </span>
              <span className="flex items-center gap-3">
                {cap ? (
                  <span
                    className="hidden h-1 w-24 overflow-hidden rounded-full bg-zinc-900 sm:block"
                    title={`${bpsToPercent(p.targetBps)} of a ${bpsToPercent(cap)} cap`}
                  >
                    <span
                      className="block h-full rounded-full bg-emerald-500/70"
                      style={{ width: `${share}%` }}
                    />
                  </span>
                ) : null}
                <span className="w-12 text-right font-mono text-sm text-zinc-200">
                  {bpsToPercent(p.targetBps)}
                </span>
              </span>
            </Row>
          );
        })
      )}
      <div className="flex items-baseline justify-between bg-zinc-900/40 px-4 py-2">
        <span className="text-sm text-zinc-400">cash</span>
        <span className="font-mono text-sm text-zinc-400">
          {bpsToPercent(portfolio.cashBps)}
        </span>
      </div>
    </Shell>
  );
}

function HistoryCard({ card }: { card: Extract<Card, { kind: "history" }> }) {
  return (
    <Shell title="History" aside={<span className="text-[11px] text-zinc-600">from the chain</span>}>
      {card.records.map((record, i) => (
        <Row key={record.signature} last={i === card.records.length - 1}>
          <span className="flex items-baseline gap-2">
            <span
              className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                record.kind === "accepted"
                  ? "bg-emerald-500"
                  : record.kind === "refused"
                    ? "bg-red-500"
                    : "bg-zinc-600"
              }`}
            />
            <span className="text-sm text-zinc-200">
              {record.kind === "accepted"
                ? `Rebalance ${record.event.sequence}`
                : record.kind === "refused"
                  ? (record.error?.name ?? "Refused")
                  : record.kind === "instruction"
                    ? record.instruction
                    : "Activity"}
            </span>
            {record.kind === "accepted" ? (
              <span className="font-mono text-[11px] text-zinc-600">
                {record.event.positionCount} pos,{" "}
                {bpsToPercent(record.event.turnoverBps)} turnover
              </span>
            ) : null}
          </span>
          <a
            href={explorerUrl(record.signature, "tx", CLUSTER)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] text-zinc-600 underline-offset-4 hover:text-zinc-400 hover:underline"
          >
            {record.signature.slice(0, 8)}..
          </a>
        </Row>
      ))}
    </Shell>
  );
}

function VerdictCard({ card }: { card: Extract<Card, { kind: "verdict" }> }) {
  const { evaluation, positions } = card;

  return (
    <Shell
      title="Checked against the mandate"
      aside={
        <span
          className={`font-mono text-[11px] ${
            evaluation.compliant ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {evaluation.compliant ? "would be accepted" : evaluation.firstRefusal}
        </span>
      }
    >
      {positions.map((p) => (
        <Row key={p.mint}>
          <span className="text-sm text-zinc-200">{p.symbol}</span>
          <span className="flex items-baseline gap-2 font-mono text-sm">
            {p.currentBps !== p.targetBps ? (
              <span className="text-[11px] text-zinc-600">
                {bpsToPercent(p.currentBps)} to
              </span>
            ) : null}
            <span className="text-zinc-100">{bpsToPercent(p.targetBps)}</span>
          </span>
        </Row>
      ))}
      <div className="grid grid-cols-3 gap-px border-t border-zinc-900 bg-zinc-900">
        <Limit label="allocated" value={bpsToPercent(evaluation.allocatedBps)} />
        <Limit label="cash" value={bpsToPercent(evaluation.cashBps)} />
        <Limit label="turnover" value={bpsToPercent(evaluation.turnoverBps)} />
      </div>
      {evaluation.violations.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-zinc-900 px-4 py-2.5">
          {evaluation.violations.map((v, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-red-300/80">
              <span className="text-red-300/50">{v.rule}:</span> {v.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </Shell>
  );
}

function AnalysisCard({ card }: { card: Extract<Card, { kind: "analysis" }> }) {
  const [open, setOpen] = useState(false);
  const { analysis } = card;

  return (
    <Shell
      title="Proposed allocation"
      aside={
        <span className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] text-zinc-600">
            confidence {analysis.confidence}/100
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] text-zinc-500 underline underline-offset-4 hover:text-zinc-300"
          >
            {open ? "hide reasoning" : "reasoning"}
          </button>
        </span>
      }
    >
      {analysis.positions.map((p) => (
        <div key={p.mint} className="border-b border-zinc-900/70 px-4 py-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-zinc-200">{p.symbol}</span>
            <span className="flex items-baseline gap-2 font-mono text-sm">
              {p.currentBps > 0 ? (
                <span className="text-[11px] text-zinc-600">
                  {bpsToPercent(p.currentBps)} to
                </span>
              ) : null}
              <span className="text-zinc-100">{bpsToPercent(p.targetBps)}</span>
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            {p.thesis}
          </p>
          {open ? (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {p.thesisBreakers.map((b, i) => (
                <li key={i} className="text-[10px] text-zinc-600">
                  would change this: {b}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}

      <div className="grid grid-cols-3 gap-px bg-zinc-900">
        <Limit label="allocated" value={bpsToPercent(analysis.evaluation.allocatedBps)} />
        <Limit label="cash" value={bpsToPercent(analysis.evaluation.cashBps)} />
        <Limit label="turnover" value={bpsToPercent(analysis.evaluation.turnoverBps)} />
      </div>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-zinc-900 px-4 py-3 text-[11px] leading-relaxed text-zinc-500">
          <p>{analysis.marketSummary}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Side title="Bull" tone="text-emerald-400" cases={analysis.bull} />
            <Side title="Bear" tone="text-red-400" cases={analysis.bear} />
          </div>
          <p className="text-zinc-600">
            Bull and bear run at the same time and never see each other, so the
            manager gets two independent readings rather than a negotiated
            middle.
          </p>
          <div>
            <span className="text-zinc-400">Risk ceilings</span>
            <ul className="mt-1 flex flex-col gap-0.5">
              {analysis.riskCeilings.map((r, i) => (
                <li key={i}>
                  <span className="font-mono text-zinc-400">{r.symbol}</span> at
                  most {bpsToPercent(r.maxRecommendedBps)}, {r.concern}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-zinc-600">
              Advisory. The mandate is the binding limit and the chain enforces
              it. This stage can lower a weight, never raise a cap.
            </p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-600">
            {analysis.stages.map((s) => (
              <span key={s.stage}>
                {s.stage} {Math.round(s.durationMs / 100) / 10}s
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {analysis.excludedForMissingPrice.length > 0 ? (
        <p className="border-t border-zinc-900 px-4 py-2 text-[11px] text-amber-400/80">
          Left out for want of a price:{" "}
          {analysis.excludedForMissingPrice.join(", ")}
        </p>
      ) : null}
    </Shell>
  );
}

function Side({
  title,
  tone,
  cases,
}: {
  title: string;
  tone: string;
  cases: { symbol: string; argument: string; weight: number }[];
}) {
  return (
    <div>
      <span className={tone}>{title}</span>
      <ul className="mt-1 flex flex-col gap-1.5">
        {cases.map((c, i) => (
          <li key={i}>
            <span className="font-mono text-zinc-400">{c.symbol}</span>
            <span className="ml-1.5 text-zinc-600">{c.weight}/10</span>
            <span className="block">{c.argument}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SubmissionCard({ card }: { card: Extract<Card, { kind: "submission" }> }) {
  const { submission } = card;

  return (
    <div
      className={`overflow-hidden rounded-xl border px-4 py-3 ${
        submission.accepted
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-red-500/30 bg-red-500/5"
      }`}
    >
      {submission.accepted ? (
        <p className="text-sm text-emerald-300">
          Accepted on chain at slot {submission.slot}.
        </p>
      ) : (
        <>
          <p className="text-sm font-medium text-red-300">
            {submission.programError?.name ?? "Refused"}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-red-200/70">
            {submission.programError?.message ?? submission.detail}
          </p>
          {submission.programError ? (
            <p className="mt-1 text-[10px] text-red-200/50">
              error {submission.programError.code}, returned by the program. No
              client check stopped this. The transaction was sent and the
              cluster rejected it.
            </p>
          ) : null}
        </>
      )}
      {submission.signature ? (
        <a
          href={explorerUrl(submission.signature, "tx", CLUSTER)}
          target="_blank"
          rel="noopener noreferrer"
          className={`mt-1.5 inline-block font-mono text-[11px] underline underline-offset-4 ${
            submission.accepted ? "text-emerald-400" : "text-red-300"
          }`}
        >
          {submission.signature.slice(0, 10)}..{submission.signature.slice(-10)}
        </a>
      ) : null}
    </div>
  );
}
