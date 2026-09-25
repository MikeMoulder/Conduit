"use client";

import { useEffect, useId, useState } from "react";
import Image from "next/image";

import type { MarketCard } from "@/app/api/market/route";

/**
 * Six tokenized equities on the welcome screen: price, the day's change, and
 * the last 24 hours as a line.
 *
 * Something to look at before the first question, and a way to ask it: a
 * card sends "how is NVDA doing today" once a wallet is connected. The line
 * is the token's own trading on Solana, green when the day is up and red when
 * it is down, and the colour, the percentage and the slope are all measured
 * from the same two points so they can never disagree.
 */

/** While any line is still being fetched in the background. */
const FILL_POLL_MS = 6_000;
const REFRESH_MS = 60_000;

export function MarketCards({
  onAsk,
  enabled,
}: {
  onAsk: (question: string) => void;
  enabled: boolean;
}) {
  const [cards, setCards] = useState<MarketCard[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      let next = REFRESH_MS;
      try {
        const response = await fetch("/api/market", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { cards: MarketCard[] };
        if (!alive) return;
        setCards(body.cards);
        setFailed(false);
        if (body.cards.some((c) => c.points.length === 0)) next = FILL_POLL_MS;
      } catch {
        if (alive) setFailed(true);
      }
      if (alive) timer = setTimeout(load, next);
    }

    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (failed && !cards) return null;

  return (
    <section aria-label="Markets" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink-faint">
          Tokenized stocks on Solana
        </h2>
        <span className="text-[11px] text-ink-ghost">last 24 hours</span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {cards
          ? cards.map((card) => (
              <Card key={card.symbol} card={card} enabled={enabled} onAsk={onAsk} />
            ))
          : Array.from({ length: 6 }, (_, i) => <Placeholder key={i} />)}
      </div>
    </section>
  );
}

function Card({
  card,
  enabled,
  onAsk,
}: {
  card: MarketCard;
  enabled: boolean;
  onAsk: (question: string) => void;
}) {
  const up = (card.changePct ?? 0) >= 0;
  const known = card.changePct !== null;

  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => onAsk(`How is ${card.symbol} doing today?`)}
      title={enabled ? `Ask about ${card.name}` : "Connect a wallet to ask about it"}
      className="group flex aspect-square flex-col rounded-2xl border border-line bg-surface p-3.5 text-left transition-colors enabled:hover:border-line-strong enabled:hover:bg-raised disabled:cursor-default sm:aspect-[5/4]"
    >
      <div className="flex items-center gap-2.5">
        {card.logo ? (
          <Image
            src={card.logo}
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded-full bg-raised object-cover"
          />
        ) : (
          <span className="h-7 w-7 shrink-0 rounded-full bg-raised" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight text-ink">{card.symbol}</p>
          <p className="truncate text-[11px] leading-tight text-ink-faint">{card.name}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[15px] text-ink">
          {card.price === null
            ? "n/a"
            : `$${card.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        </span>
        {known ? (
          <span
            className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
              up ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
            }`}
          >
            {up ? "+" : ""}
            {card.changePct!.toFixed(2)}%
          </span>
        ) : null}
      </div>

      <div className="mt-auto pt-2">
        {card.points.length > 1 ? (
          <Sparkline points={card.points} up={up} />
        ) : (
          <div className="h-10 animate-pulse rounded-md bg-raised/60" />
        )}
      </div>
    </button>
  );
}

/**
 * The line, with a soft fill under it.
 *
 * Stretched to the card's width rather than drawn at a fixed size, with a
 * stroke that does not stretch with it, so it stays a hairline at any width.
 */
function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  const id = useId();
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const W = 100;
  const H = 40;
  const PAD = 3;

  const xy = points.map((p, i) => [
    (i / (points.length - 1)) * W,
    PAD + (1 - (p - min) / span) * (H - PAD * 2),
  ]);
  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const colour = up ? "#34d399" : "#f87171";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-10 w-full overflow-visible"
      role="img"
      aria-label={up ? "Up over the last 24 hours" : "Down over the last 24 hours"}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.28" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={colour}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Placeholder() {
  return (
    <div className="flex aspect-square flex-col rounded-2xl border border-line bg-surface p-3.5 sm:aspect-[5/4]">
      <div className="flex items-center gap-2.5">
        <span className="h-7 w-7 animate-pulse rounded-full bg-raised" />
        <span className="h-3 w-12 animate-pulse rounded bg-raised" />
      </div>
      <span className="mt-3 h-4 w-20 animate-pulse rounded bg-raised" />
      <span className="mt-auto h-10 animate-pulse rounded-md bg-raised/60" />
    </div>
  );
}
