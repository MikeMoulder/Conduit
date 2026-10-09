"use client";

import { useId, useState } from "react";

/**
 * The stock page's chart: a line with a soft fill, and the price under the
 * pointer or finger.
 *
 * Drawn the same way as the market cards' sparkline, so the two read as one
 * family, only taller and with a readout. The points carry no timestamps, so
 * the readout is the price alone; the range tabs above say what span it is.
 */
export function PriceChart({ points, up }: { points: number[]; up: boolean }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-line text-xs text-ink-faint">
        No chart for this range
      </div>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const W = 100;
  const H = 50;
  const PAD = 3;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, PAD + (1 - (p - min) / span) * (H - PAD * 2)]);
  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const colour = up ? "#34d399" : "#f87171";

  const pick = (clientX: number, rect: DOMRect) => {
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (points.length - 1)));
  };

  const at = hover === null ? null : xy[hover];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-40 w-full touch-none overflow-visible"
        role="img"
        aria-label={`Price chart, ${up ? "up" : "down"} over the range`}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity="0.25" />
            <stop offset="100%" stopColor={colour} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id})`} />
        <path
          d={line}
          fill="none"
          stroke={colour}
          strokeWidth="1.75"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {at ? (
          <line
            x1={at[0]}
            x2={at[0]}
            y1={0}
            y2={H}
            stroke="currentColor"
            className="text-ink-ghost"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
        <span className="font-mono">low ${min.toFixed(2)}</span>
        {hover !== null ? (
          <span className="font-mono text-ink">${points[hover].toFixed(2)}</span>
        ) : null}
        <span className="font-mono">high ${max.toFixed(2)}</span>
      </div>
    </div>
  );
}
