import "server-only";

import { getJson, kv } from "./kv";

/**
 * The last day of trading for a tokenized equity, for a small chart.
 *
 * From GeckoTerminal, which records every swap in the token's pools on
 * Solana mainnet, so the line is what the token itself did rather than the
 * listed share. That is the right line to draw next to a Jupiter price: both
 * describe the same token, and they agree to a few cents.
 *
 * Only the equities. The pre IPO tokens trade in pools thin enough that
 * their pool prices disagree with PreStocks by multiples, and a chart that
 * contradicts the price above it is worse than no chart.
 *
 * Never fetched while a page waits. GeckoTerminal's free tier refuses bursts
 * outright, so a page load that asked for six lines at once got one. The
 * background jobs refresh the lines one request at a time, spaced under the
 * limit, and keep them in the shared store; a page, on Vercel or anywhere,
 * only reads them. The refresh cannot run on Vercel itself: a serverless
 * function is frozen the moment it has answered, which would cut a spaced
 * run of requests off after the first.
 *
 *   spark:pool:v<rule>:<mint>  the pool a line is read from
 *   spark:line:<mint>          the last day of hourly closes
 */

const API = "https://api.geckoterminal.com/api/v2/networks/solana";
/** A pool address practically never changes. */
const POOL_TTL_MS = 24 * 60 * 60 * 1000;
/** An hourly line changes once an hour; five minutes keeps the last hour live. */
const LINE_TTL_MS = 5 * 60 * 1000;
/**
 * Thirty calls a minute is the published limit, but in practice it refuses
 * sooner, so this stays well under it.
 */
const SPACING_MS = 4_000;
/** After a refusal, how long to leave it alone before asking again. */
const COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 8_000;

/**
 * Part of the pool's key, so pools picked by an older rule are chosen again
 * rather than kept for a day. Version 2 requires the token to be the pool's
 * base: SPY's deepest pool is STONK/SPYx, with SPY on the quote side, and its
 * line came out at 33 cents.
 */
const POOL_RULE = 2;

interface Pool {
  address: string | null;
  at: number;
}

interface Line {
  points: number[];
  at: number;
  /** Which pool the line came from, so a new pool redraws it. */
  pool?: string;
}

const poolKey = (mint: string) => `spark:pool:v${POOL_RULE}:${mint}`;
const lineKey = (mint: string) => `spark:line:${mint}`;

// Per process: only the one running the background jobs refreshes.
const shared = globalThis as typeof globalThis & {
  __conduitSparklineRefresh?: Promise<void> | null;
  __conduitSparklineCooldownUntil?: number;
};

class RateLimited extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJsonFrom(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 429) throw new RateLimited("geckoterminal is rate limiting");
  if (!response.ok) throw new Error(`geckoterminal responded http ${response.status}`);
  return response.json();
}

/** The deepest pool that prices this token as its base. */
async function refreshPool(mint: string): Promise<Pool> {
  const body = (await getJsonFrom(`${API}/tokens/${mint}/pools?page=1`)) as {
    data?: {
      attributes?: { address?: string; reserve_in_usd?: string };
      relationships?: { base_token?: { data?: { id?: string } } };
    }[];
  };
  const deepest = (body.data ?? [])
    .filter((p) => p.relationships?.base_token?.data?.id === `solana_${mint}`)
    .map((p) => ({ address: p.attributes?.address, reserve: Number(p.attributes?.reserve_in_usd ?? 0) }))
    .filter((p): p is { address: string; reserve: number } => Boolean(p.address))
    .sort((a, b) => b.reserve - a.reserve)[0];
  const pool: Pool = { address: deepest?.address ?? null, at: Date.now() };
  await kv().set(poolKey(mint), JSON.stringify(pool));
  return pool;
}

/** Hourly closes for the last 24 hours, oldest first. */
async function refreshLine(mint: string, pool: string): Promise<void> {
  const body = (await getJsonFrom(
    `${API}/pools/${pool}/ohlcv/hour?aggregate=1&limit=24&currency=usd&token=base`,
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };

  // Each row is [time, open, high, low, close, volume], newest first.
  const points = (body.data?.attributes?.ohlcv_list ?? [])
    .filter((row) => Array.isArray(row) && Number.isFinite(row[4]) && row[4] > 0)
    .sort((a, b) => a[0] - b[0])
    .map((row) => row[4]);

  if (points.length > 0) {
    const line: Line = { points, at: Date.now(), pool };
    await kv().set(lineKey(mint), JSON.stringify(line));
  }
}

async function refreshAll(mints: string[]): Promise<void> {
  const now = Date.now();
  let first = true;
  const pace = async () => {
    if (!first) await sleep(SPACING_MS);
    first = false;
  };

  for (const mint of mints) {
    try {
      let pool = await getJson<Pool>(poolKey(mint));
      if (!pool || now - pool.at > POOL_TTL_MS) {
        await pace();
        pool = await refreshPool(mint);
      }
      const line = await getJson<Line>(lineKey(mint));
      const fresh = line && now - line.at <= LINE_TTL_MS && (line.pool === undefined || line.pool === pool.address);
      if (pool.address && !fresh) {
        await pace();
        await refreshLine(mint, pool.address);
      }
    } catch (error) {
      // A refusal means every further call would be refused too, and each one
      // extends the wait. Stop, and leave it alone for a minute.
      if (error instanceof RateLimited) {
        shared.__conduitSparklineCooldownUntil = Date.now() + COOLDOWN_MS;
        break;
      }
      // Anything else skips this mint; the next refresh tries again.
    }
  }
}

/**
 * Brings stale lines up to date, one request at a time. Called by the
 * background jobs every minute; returns at once if a refresh is already
 * running or GeckoTerminal asked to be left alone.
 */
export function refreshDayLines(mints: string[]): Promise<void> {
  if (shared.__conduitSparklineRefresh) return shared.__conduitSparklineRefresh;
  if ((shared.__conduitSparklineCooldownUntil ?? 0) > Date.now()) return Promise.resolve();
  shared.__conduitSparklineRefresh = refreshAll(mints).finally(() => {
    shared.__conduitSparklineRefresh = null;
  });
  return shared.__conduitSparklineRefresh;
}

/** The stored lines for these mints, empty where none has been fetched yet. */
export async function dayLines(mints: string[]): Promise<Record<string, number[]>> {
  const lines = await Promise.all(mints.map((m) => getJson<Line>(lineKey(m)).catch(() => null)));
  return Object.fromEntries(mints.map((m, i) => [m, lines[i]?.points ?? []]));
}
