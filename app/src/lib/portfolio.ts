import "server-only";

import type { PublicKey } from "@solana/web3.js";

import { assetBySymbol } from "./agent-actions";
import { getAssetBySymbol } from "./assets";
import { dayStats, plausibleLine } from "./day-stats";
import { desk } from "./holdings";
import { fetchMainWallet, fetchWalletBalances, walletAddress } from "./main-wallet";
import { snapshotMarket } from "./market";
import { fetchHeadlines } from "./news";
import { fetchPreStocks } from "./prestocks";
import { getConnection } from "./rpc";
import { readAssetPrice } from "./settlement-prices";
import { dayLines } from "./sparklines";
import type { StockBrief, WalletCard } from "./copilot/events";

/**
 * What a person holds and what a stock is doing, read once for every place
 * that shows it.
 *
 * The chat's get_wallet and get_stock_brief tools used to build these
 * inline. The portfolio panel and the stock page show the same things, and
 * two copies of how a holding is valued is how a panel and a chat reply end
 * up disagreeing about the same wallet. Both read from here.
 */

/** The day's move for an equity, from the same line the market cards draw. Null without one. */
async function dayChange(symbol: string, price: number): Promise<number | null> {
  const asset = getAssetBySymbol(symbol);
  const mint = asset?.mainnetMint;
  if (!mint || asset?.assetClass !== "equity") return null;
  const line = (await dayLines([mint]))[mint] ?? [];
  if (!plausibleLine(line, price) || line.length < 2) return null;
  return (price / line[0] - 1) * 100;
}

/**
 * The main wallet and the cash still in the person's own wallet, every asset
 * valued at the price settlement uses.
 */
export async function readWallet(owner: PublicKey): Promise<WalletCard> {
  const connection = getConnection();
  const [wallet, own] = await Promise.all([fetchMainWallet(connection, owner), fetchWalletBalances(connection, owner)]);
  const ownCash = own.cash?.uiAmount ?? 0;

  if (!wallet) return { opened: false, address: null, cash: 0, holdings: [], total: 0, ownCash };

  const balances = await fetchWalletBalances(connection, walletAddress(owner));
  const held = balances.assets.filter((a) => a.uiAmount > 0);

  const holdings = await Promise.all(
    held.map(async (h) => {
      const asset = assetBySymbol(h.symbol);
      const price = asset ? await readAssetPrice(connection, asset) : null;
      const unit = price && price.ok ? price.price.price : null;
      return {
        symbol: h.symbol,
        amount: h.uiAmount,
        value: unit === null ? null : h.uiAmount * unit,
        changePct: unit === null ? null : await dayChange(h.symbol, unit),
      };
    }),
  );

  const cash = balances.cash?.uiAmount ?? 0;
  const total = cash + holdings.reduce((sum, h) => sum + (h.value ?? 0), 0);
  // Rounding leaves crumbs behind a sell, a few billionths of a token worth
  // nothing. Listed, they read as "NVDA $0.00". One with no price is kept,
  // since its worth is unknown rather than nothing.
  const shown = holdings.filter((h) => h.value === null || h.value >= 0.01);
  return { opened: true, address: wallet.address, cash, holdings: shown, total, ownCash };
}

/** Everything the stock brief shows, and which news source answered. */
export async function readStockBrief(
  symbol: string,
  owner: PublicKey | null,
): Promise<{ brief: StockBrief; provider: string; priceSource: string | null; mint: string | undefined; line: number[] } | null> {
  const asset = getAssetBySymbol(symbol);
  if (!asset) return null;

  const mint = asset.assetClass === "equity" ? asset.mainnetMint : undefined;
  const [snapshot, news, preStocks, holding] = await Promise.all([
    snapshotMarket([asset.symbol]),
    fetchHeadlines(asset),
    asset.assetClass === "preipo" ? fetchPreStocks() : Promise.resolve(null),
    (async () => {
      if (!owner) return null;
      try {
        const connection = getConnection();
        if (!(await fetchMainWallet(connection, owner))) return null;
        const balances = await fetchWalletBalances(connection, walletAddress(owner));
        const deskMint = desk.settleable.find((a) => a.symbol === asset.symbol)?.mint;
        const held = balances.assets.find((a) => a.mint === deskMint);
        return held ? held.uiAmount : 0;
      } catch {
        return null;
      }
    })(),
  ]);

  const row = snapshot[0];
  const price = row?.price ?? null;
  const rawLine = mint ? ((await dayLines([mint]))[mint] ?? []) : [];
  const line = plausibleLine(rawLine, price) ? rawLine : [];
  const day = dayStats(line, price);
  const record = preStocks?.status === "ok" ? preStocks.assets.get(asset.symbol) : undefined;

  const brief: StockBrief = {
    symbol: asset.symbol,
    name: asset.name,
    logo: asset.logo ?? null,
    assetClass: asset.assetClass,
    price,
    reference:
      row?.referencePrice != null
        ? {
            label: asset.assetClass === "preipo" ? "company mark" : "listed share",
            price: row.referencePrice,
            spreadBps: row.spreadBps,
          }
        : null,
    day,
    points: day ? [...line, price!] : [],
    valuation: record ? { atMark: record.markValuation, atToken: record.impliedValuation } : null,
    held: holding,
    headlines: news.headlines,
  };

  return { brief, provider: news.provider, priceSource: row?.priceSource ?? null, mint, line };
}
