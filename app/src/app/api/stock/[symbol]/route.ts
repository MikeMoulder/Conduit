import { parseAddress } from "@/lib/agent-actions";
import { getAssetBySymbol } from "@/lib/assets";
import { readStockBrief } from "@/lib/portfolio";
import { rangeLine, type ChartRange } from "@/lib/sparklines";

/**
 * One stock, for the stock page: the brief the chat shows, and a chart for
 * the range asked for.
 *
 * A day is the line the market cards and the brief already draw, ending at
 * the live price. A week or a month comes from GeckoTerminal candles, cached,
 * and is also finished at the live price so the chart ends where the number
 * above it says. Works without a wallet; with one, it says what is held.
 */

export const dynamic = "force-dynamic";

const RANGES: ChartRange[] = ["1d", "1w", "1m"];

export async function GET(request: Request, context: RouteContext<"/api/stock/[symbol]">): Promise<Response> {
  const { symbol } = await context.params;
  const url = new URL(request.url);
  const range = (url.searchParams.get("range") ?? "1d") as ChartRange;
  if (!RANGES.includes(range)) return Response.json({ error: "range must be 1d, 1w or 1m" }, { status: 400 });

  const asset = getAssetBySymbol(symbol.toUpperCase());
  if (!asset) return Response.json({ error: `${symbol} is not in the universe` }, { status: 404 });

  const ownerParam = url.searchParams.get("owner");
  const owner = ownerParam ? parseAddress(ownerParam) : null;
  if (ownerParam && !owner) return Response.json({ error: "owner is not a valid address" }, { status: 400 });

  const read = await readStockBrief(asset.symbol, owner);
  if (!read) return Response.json({ error: `${symbol} is not in the universe` }, { status: 404 });
  const { brief, mint } = read;

  let points = brief.points;
  if (range !== "1d") {
    const line = mint ? await rangeLine(mint, range) : null;
    points = line && brief.price !== null ? [...line, brief.price] : [];
  }
  const changePct = points.length > 1 ? (points[points.length - 1] / points[0] - 1) * 100 : null;

  return Response.json({ brief, chart: { range, points, changePct }, at: Date.now() });
}
