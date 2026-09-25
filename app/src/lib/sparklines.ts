import "server-only";

import { readFileSync } from "fs";
import path from "path";

import { writeJsonAtomic } from "./atomic-write";

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
 * outright, so a page load that asked for six lines at once got one. Instead
 * the lines are refreshed in the background, one request at a time and
 * spaced under the limit, and a page reads whatever is already cached. They
 * are kept on disk so a restart does not begin blank.
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

interface Stored {
  pools: Record<string, { address: string | null; at: number }>;
  lines: Record<string, { points: number[]; at: number }>;
}

const file = () =>
  process.env.SPARKLINE_STATE_FILE ?? path.join(process.cwd(), ".data", "sparklines.json");

function load(): Stored {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as Partial<Stored>;
    return { pools: parsed.pools ?? {}, lines: parsed.lines ?? {} };
  } catch {
    return { pools: {}, lines: {} };
  }
}

// Shared on the global object: in development the module can be evaluated
// more than once, and two refreshers would double the calls.
const shared = globalThis as typeof globalThis & {
  __conduitSparklines?: Stored;
  __conduitSparklineRefresh?: Promise<void> | null;
  __conduitSparklineCooldownUntil?: number;
};

class RateLimited extends Error {}
const state = () => (shared.__conduitSparklines ??= load());

function save(): void {
  try {
    writeJsonAtomic(file(), state());
  } catch {
    // The cache is a convenience. Failing to write it loses nothing but speed.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 429) throw new RateLimited("geckoterminal is rate limiting");
  if (!response.ok) throw new Error(`geckoterminal responded http ${response.status}`);
  return response.json();
}

/** The deepest pool for a mint: the one whose price means the most. */
async function refreshPool(mint: string): Promise<string | null> {
  const body = (await getJson(`${API}/tokens/${mint}/pools?page=1`)) as {
    data?: { attributes?: { address?: string; reserve_in_usd?: string } }[];
  };
  const deepest = (body.data ?? [])
    .map((p) => ({ address: p.attributes?.address, reserve: Number(p.attributes?.reserve_in_usd ?? 0) }))
    .filter((p): p is { address: string; reserve: number } => Boolean(p.address))
    .sort((a, b) => b.reserve - a.reserve)[0];
  const address = deepest?.address ?? null;
  state().pools[mint] = { address, at: Date.now() };
  return address;
}

/** Hourly closes for the last 24 hours, oldest first. */
async function refreshLine(mint: string, pool: string): Promise<void> {
  const body = (await getJson(
    // Priced as this token whichever side of the pool it sits on. Asking for
    // the base token drew SPY upside down, from a pool where it is the quote.
    `${API}/pools/${pool}/ohlcv/hour?aggregate=1&limit=24&currency=usd&token=${mint}`,
  )) as { data?: { attributes?: { ohlcv_list?: number[][] } } };

  // Each row is [time, open, high, low, close, volume], newest first.
  const points = (body.data?.attributes?.ohlcv_list ?? [])
    .filter((row) => Array.isArray(row) && Number.isFinite(row[4]) && row[4] > 0)
    .sort((a, b) => a[0] - b[0])
    .map((row) => row[4]);

  if (points.length > 0) state().lines[mint] = { points, at: Date.now() };
}

/**
 * Brings every stale line up to date, one request at a time.
 *
 * A refused or failed request is skipped, not retried: the old line stays on
 * screen and the next refresh tries again.
 */
async function refreshAll(mints: string[]): Promise<void> {
  const now = Date.now();
  let first = true;
  const pace = async () => {
    if (!first) await sleep(SPACING_MS);
    first = false;
  };

  for (const mint of mints) {
    try {
      let pool = state().pools[mint];
      if (!pool || now - pool.at > POOL_TTL_MS) {
        await pace();
        pool = { address: await refreshPool(mint), at: Date.now() };
      }
      const line = state().lines[mint];
      if (pool.address && (!line || now - line.at > LINE_TTL_MS)) {
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
      // Anything else skips this mint; see above.
    }
  }
  save();
}

/**
 * The cached lines for these mints, and a background refresh of any that are
 * stale. Returns at once.
 */
export function dayLines(mints: string[]): Record<string, number[]> {
  const now = Date.now();
  const stale = mints.some((m) => {
    const line = state().lines[m];
    return !line || now - line.at > LINE_TTL_MS;
  });

  const cooling = (shared.__conduitSparklineCooldownUntil ?? 0) > now;
  if (stale && !cooling && !shared.__conduitSparklineRefresh) {
    shared.__conduitSparklineRefresh = refreshAll(mints).finally(() => {
      shared.__conduitSparklineRefresh = null;
    });
  }

  return Object.fromEntries(mints.map((m) => [m, state().lines[m]?.points ?? []]));
}
