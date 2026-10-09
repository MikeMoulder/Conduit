"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

import type { StockBrief } from "@/lib/copilot/events";
import { closeStock, useSheets } from "@/lib/ui-sheets";
import { AssetBadge } from "./cards";
import { PriceChart } from "./price-chart";

/**
 * A stock on its own page: the price, a chart over a day, a week or a month,
 * the numbers that matter, the news, and the next step.
 *
 * Opened from a welcome card, a brief in the chat, or a holding. It reads
 * without a wallet, because looking costs nothing; the buttons that trade or
 * ask need one, like the composer. Each button sends a sentence to the chat
 * rather than acting here, so every trade still comes back as a card to
 * approve.
 */

type Range = "1d" | "1w" | "1m";

interface StockData {
  brief: StockBrief;
  chart: { range: Range; points: number[]; changePct: number | null };
}

const RANGE_LABEL: Record<Range, string> = { "1d": "today", "1w": "past week", "1m": "past month" };

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function ago(at: number): string {
  const hours = Math.round((Date.now() - at) / 3_600_000);
  if (hours < 1) return "just now";
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function StockSheet({
  owner,
  canAsk,
  onAsk,
}: {
  owner: string | null;
  canAsk: boolean;
  onAsk: (question: string) => void;
}) {
  const { stock } = useSheets();
  if (!stock) return null;
  // Keyed by symbol, so opening another stock starts from its own first range.
  return <Sheet key={stock} symbol={stock} owner={owner} canAsk={canAsk} onAsk={onAsk} />;
}

function Sheet({
  symbol,
  owner,
  canAsk,
  onAsk,
}: {
  symbol: string;
  owner: string | null;
  canAsk: boolean;
  onAsk: (question: string) => void;
}) {
  const [range, setRange] = useState<Range>("1d");
  const key = `${range}:${owner ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; data: StockData | null; error: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    const url = `/api/stock/${symbol}?range=${range}${owner ? `&owner=${owner}` : ""}`;
    fetch(url)
      .then((r) => r.json())
      .then((body: StockData & { error?: string }) => {
        if (alive) setLoaded({ key, data: body.error ? null : body, error: body.error ?? null });
      })
      .catch(() => {
        if (alive) setLoaded({ key, data: null, error: "Couldn't load this stock. Check your connection and try again." });
      });
    return () => {
      alive = false;
    };
  }, [key, symbol, range, owner]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeStock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fresh = loaded?.key === key;
  // While another range loads, the page keeps what it already shows.
  const data = loaded?.data ?? null;
  const brief = data?.brief;
  const change = fresh ? data?.chart.changePct ?? null : null;
  const up = (change ?? 0) >= 0;

  const act = (question: string) => {
    onAsk(question);
    closeStock();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-label={`${symbol} details`}>
      <button type="button" aria-label="Close" onClick={closeStock} className="absolute inset-0 bg-black/50" />
      <div className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border border-line bg-surface px-5 pt-5 animate-[rise-in_0.2s_ease-out_both] sm:max-w-xl sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3">
          <AssetBadge symbol={symbol} size={36} />
          <button
            type="button"
            onClick={closeStock}
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-full text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {loaded?.error && !brief ? (
          <p className="mt-6 text-sm text-ink-muted">{loaded.error}</p>
        ) : !brief ? (
          <div className="mt-5 flex flex-col gap-3" aria-label="Loading">
            <div className="h-8 w-40 animate-pulse rounded-lg bg-raised" />
            <div className="h-40 animate-pulse rounded-xl bg-raised" />
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-3xl font-semibold tracking-tight">
                {brief.price === null ? "no price" : usd(brief.price)}
              </span>
              {change !== null ? (
                <span className={`font-mono text-sm ${up ? "text-emerald-400" : "text-red-400"}`}>
                  {up ? "+" : ""}
                  {change.toFixed(2)}% {RANGE_LABEL[range]}
                </span>
              ) : null}
            </div>

            <div className="mt-4 flex gap-1" role="tablist" aria-label="Chart range">
              {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  role="tab"
                  aria-selected={r === range}
                  onClick={() => setRange(r)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    r === range ? "bg-raised text-ink" : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {r.toUpperCase()}
                </button>
              ))}
            </div>

            <div className={`mt-3 transition-opacity ${fresh ? "" : "opacity-40"}`}>
              <PriceChart points={data?.chart.points ?? []} up={up} />
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line text-sm [&>*:last-child:nth-child(odd)]:col-span-2">
              {brief.day ? (
                <Stat label="Today's range" value={`${usd(brief.day.low)} to ${usd(brief.day.high)}`} />
              ) : null}
              {brief.reference ? (
                <Stat
                  label={brief.reference.label === "company mark" ? "Company value per share" : "vs the real share"}
                  value={
                    brief.reference.spreadBps === null
                      ? usd(brief.reference.price)
                      : `${usd(brief.reference.price)} (${brief.reference.spreadBps >= 0 ? "+" : ""}${(brief.reference.spreadBps / 100).toFixed(2)}%)`
                  }
                />
              ) : null}
              {brief.valuation ? (
                <Stat
                  label="Valuation"
                  value={`$${Math.round(brief.valuation.atToken / 1e9)}B at the token price, $${Math.round(brief.valuation.atMark / 1e9)}B at the mark`}
                />
              ) : null}
              <Stat
                label="You hold"
                value={
                  brief.held === null
                    ? owner
                      ? "no main wallet yet"
                      : "connect a wallet"
                    : brief.held === 0
                      ? "none"
                      : `${brief.held.toLocaleString(undefined, { maximumFractionDigits: 4 })}${
                          brief.price === null ? "" : ` (${usd(brief.held * brief.price)})`
                        }`
                }
              />
            </dl>

            {brief.headlines.length > 0 ? (
              <section className="mt-5">
                <h3 className="text-[11px] uppercase tracking-wider text-ink-faint">In the news</h3>
                <ul className="mt-2 flex flex-col gap-2.5">
                  {brief.headlines.slice(0, 5).map((h) => (
                    <li key={h.url}>
                      <a
                        href={h.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm leading-snug text-ink hover:underline [overflow-wrap:anywhere]"
                      >
                        {h.title}
                      </a>
                      <p className="text-[11px] text-ink-faint">
                        {h.source} · {ago(h.publishedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="sticky bottom-0 -mx-5 mt-5 flex flex-wrap gap-2 border-t border-line bg-surface px-5 py-4">
              <button
                type="button"
                disabled={!canAsk}
                onClick={() => act(`Buy $50 of ${symbol}`)}
                className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:opacity-40"
              >
                Buy $50
              </button>
              <button
                type="button"
                disabled={!canAsk}
                onClick={() => act(`Ping me if ${symbol} drops 3%`)}
                className="rounded-full border border-line-strong px-4 py-2 text-sm text-ink transition-colors hover:bg-raised disabled:opacity-40"
              >
                Set an alert
              </button>
              <button
                type="button"
                disabled={!canAsk}
                onClick={() => act(`How's ${symbol} doing?`)}
                className="rounded-full px-4 py-2 text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
              >
                Ask about it
              </button>
              {!canAsk ? (
                <p className="basis-full text-[11px] text-ink-faint">Connect a wallet to trade or ask about it.</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <dt className="text-[11px] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-ink [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
