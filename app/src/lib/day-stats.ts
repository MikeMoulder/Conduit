/**
 * What a day of hourly prices says, in the terms a person asks about.
 *
 * Pure, and measured from the same points the market cards draw, so the
 * brief and the card a person clicked can never disagree about the day.
 */

export interface DayStats {
  /** The first hourly close in the window, about 24 hours ago. */
  open: number;
  changePct: number;
  high: number;
  low: number;
  /** Where the current price sits between the low (0) and the high (100). */
  rangePosition: number;
}

/** Null without at least two points and a price, which is not a day. */
export function dayStats(points: number[], price: number | null): DayStats | null {
  if (points.length < 2 || price === null) return null;
  const all = [...points, price];
  const high = Math.max(...all);
  const low = Math.min(...all);
  const open = points[0];
  return {
    open,
    changePct: (price / open - 1) * 100,
    high,
    low,
    rangePosition: high === low ? 50 : Math.round(((price - low) / (high - low)) * 100),
  };
}

/** "near the day's high", in words, for a person rather than a chart. */
export function describeRange(position: number): string {
  if (position >= 85) return "near the day's high";
  if (position <= 15) return "near the day's low";
  if (position >= 60) return "in the upper part of the day's range";
  if (position <= 40) return "in the lower part of the day's range";
  return "mid range for the day";
}

/**
 * Whether a line describes the same thing as the price beside it.
 *
 * A pool can be priced the wrong way up or be too thin to mean anything; the
 * first version of the market cards showed SPY up 229,828% because of it. A
 * line whose last point is more than 10% from the live price is not used.
 */
export function plausibleLine(line: number[], price: number | null): boolean {
  if (line.length === 0) return false;
  if (price === null) return true;
  return Math.abs(line[line.length - 1] / price - 1) <= 0.1;
}

/**
 * The day's change as words, ready to quote: "up 0.02%", "down 1.77%", "flat".
 *
 * Handed to the model instead of a bare number, because a small model given
 * 0.02 once wrote "up 2 percent", a hundred times the real move. A figure it
 * only has to copy is a figure it cannot misread.
 */
export function describeChange(changePct: number): string {
  const rounded = Math.round(changePct * 100) / 100;
  if (rounded === 0) return "flat";
  return `${rounded > 0 ? "up" : "down"} ${Math.abs(rounded).toFixed(2)}%`;
}
