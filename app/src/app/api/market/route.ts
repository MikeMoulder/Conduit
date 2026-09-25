import { getAssetBySymbol } from "@/lib/assets";
import { plausibleLine } from "@/lib/day-stats";
import { snapshotMarket } from "@/lib/market";
import { dayLines } from "@/lib/sparklines";

/**
 * The market cards on the welcome screen: six tokenized equities, each with
 * its price and its last day as a line.
 *
 * The price is the one the copilot quotes, from Jupiter. The line is the
 * token's own hourly trading from GeckoTerminal, finished with that price so
 * the chart ends where the number above it says. The day's change is measured
 * from the first point of the line to the price, so the colour, the
 * percentage and the slope always agree.
 */

export const dynamic = "force-dynamic";

const SYMBOLS = ["NVDA", "AAPL", "TSLA", "MSFT", "GOOGL", "SPY"];

export interface MarketCard {
  symbol: string;
  name: string;
  logo: string | null;
  price: number | null;
  /** Percent change over the line, or null without one. */
  changePct: number | null;
  /** Oldest first, ending at the current price. */
  points: number[];
}

export async function GET(): Promise<Response> {
  const snapshot = await snapshotMarket(SYMBOLS);
  const mints = SYMBOLS.map((s) => getAssetBySymbol(s)?.mainnetMint).filter(
    (m): m is string => Boolean(m),
  );
  const lines = await dayLines(mints);

  const cards = SYMBOLS.map((symbol): MarketCard => {
    const asset = getAssetBySymbol(symbol);
    const price = snapshot.find((s) => s.symbol === symbol)?.price ?? null;
    const raw = asset?.mainnetMint ? (lines[asset.mainnetMint] ?? []) : [];
    const line = plausibleLine(raw, price) ? raw : [];
    const points = price !== null && line.length > 0 ? [...line, price] : line;
    const changePct =
      price !== null && line.length > 1 ? (price / line[0] - 1) * 100 : null;

    return {
      symbol,
      name: asset?.name ?? symbol,
      logo: asset?.logo ?? null,
      price,
      changePct,
      points,
    };
  });

  return Response.json({ cards, at: Date.now() });
}
