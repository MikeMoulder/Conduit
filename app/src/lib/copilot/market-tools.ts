import "server-only";

import { getAssetBySymbol } from "../assets";
import { describeChange, describeRange } from "../day-stats";
import { readStockBrief } from "../portfolio";
import { ToolError, type CopilotTool } from "./tool-types";

/**
 * "How is NVDA doing?" answered properly.
 *
 * A price alone is not an answer to that question, and the first version of
 * the market cards led to exactly that: one tool, one number, one sentence.
 * A person asking how something is doing wants the day's move and where it
 * sits in its range, why it is moving, anything particular to how they hold
 * it, and whether they hold it at all. This gathers all of that in one call,
 * from the sources each part should come from:
 *
 *   price and premium  Jupiter, PreStocks        what the chat quotes everywhere
 *   the day            GeckoTerminal             the same line the card draws
 *   why                Finnhub, Yahoo, Google    headlines and summaries, named as such
 *   valuation          PreStocks                 pre IPO names only
 *   their position     the chain                 their main wallet
 *
 * Every part can be missing without failing the rest, and says so.
 */

function hoursAgo(at: number): string {
  const hours = Math.round((Date.now() - at) / 3_600_000);
  if (hours < 1) return "under an hour ago";
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const getStockBrief: CopilotTool = {
  label: "Putting together a brief",
  declaration: {
    name: "get_stock_brief",
    description:
      "A full brief on one asset: live price, the day's change, high, low and where the price sits in that range, the token's premium or discount to the real share (or, for pre IPO names, the company's valuation at its mark and at the token price), the latest headlines naming it with source and age, and how much of it the person holds in their main wallet. Use it whenever someone asks how a stock is doing, what is happening with it, why it moved, or clicks a market card. Prefer it over get_prices for any single asset question.",
    parameters: {
      type: "OBJECT",
      properties: {
        symbol: { type: "STRING", description: "The registry symbol, such as NVDA, SPY, BTC or OPENAI." },
      },
      required: ["symbol"],
    },
  },
  async run(args, ctx) {
    const symbol = String(args.symbol ?? "").trim().toUpperCase();
    const asset = getAssetBySymbol(symbol);
    if (!asset) throw new ToolError(`${symbol} is not in the universe. Call list_universe to see what is.`);

    const read = await readStockBrief(asset.symbol, ctx.owner ?? null);
    if (!read) throw new ToolError(`${symbol} is not in the universe. Call list_universe to see what is.`);
    const { brief, provider, priceSource, mint } = read;
    const { price, day, headlines, held: holding } = brief;

    return {
      result: {
        symbol: asset.symbol,
        name: asset.name,
        assetClass: asset.assetClass,
        price,
        day: day
          ? {
              change: describeChange(day.changePct),
              changePercent: Number(day.changePct.toFixed(2)),
              open24hAgo: Number(day.open.toFixed(2)),
              high: Number(day.high.toFixed(2)),
              low: Number(day.low.toFixed(2)),
              where: describeRange(day.rangePosition),
            }
          : "no intraday line for this asset",
        premiumToReference: brief.reference
          ? {
              against: brief.reference.label,
              referencePrice: brief.reference.price,
              percent: brief.reference.spreadBps === null ? null : brief.reference.spreadBps / 100,
            }
          : null,
        valuation: brief.valuation
          ? {
              atCompanyMarkBillions: Math.round(brief.valuation.atMark / 1e9),
              atTokenPriceBillions: Math.round(brief.valuation.atToken / 1e9),
            }
          : null,
        heldInMainWallet:
          holding === null
            ? "unknown: no wallet connected, or no main wallet yet"
            : holding === 0
              ? "none"
              : { units: holding, approxValue: price === null ? null : Number((holding * price).toFixed(2)) },
        headlines:
          headlines.length === 0
            ? "none found in the last three days"
            : headlines.map((h) => ({
                title: h.title,
                source: h.source,
                age: hoursAgo(h.publishedAt),
                ...(h.summary ? { summary: h.summary } : {}),
              })),
      },
      summary: `${asset.symbol}${price === null ? "" : ` $${price.toFixed(2)}`}${day ? `, ${day.changePct >= 0 ? "+" : ""}${day.changePct.toFixed(2)}% on the day` : ""}, ${headlines.length} headline${headlines.length === 1 ? "" : "s"}`,
      card: { kind: "stock-brief", brief },
      sources: [
        { provider: priceSource ?? "prices", detail: "live price", ok: price !== null },
        ...(mint ? [{ provider: "geckoterminal", detail: "24 hour line", ok: day !== null }] : []),
        { provider, detail: `${headlines.length} headlines`, ok: headlines.length > 0 },
      ],
    };
  },
};

export const MARKET_TOOLS: Record<string, CopilotTool> = {
  get_stock_brief: getStockBrief,
};
