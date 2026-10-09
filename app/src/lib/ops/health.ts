/**
 * Is Conduit working, and if not, what exactly is broken.
 *
 * Built after the shared store ran out of its monthly allowance and refused
 * every command for a day and a half while the worker's log kept saying
 * "alive". Nothing was watching the parts the product depends on, so the
 * first anyone heard of it was by looking.
 *
 * Pure on purpose: a reading goes in, problems come out, and the rules can be
 * tested without a chain, a store or Telegram. Gathering the reading lives in
 * check.ts; deciding when to say something lives in alerts.ts.
 */

export interface HealthReading {
  /** The shared store took a write, or why it did not. */
  store: { ok: boolean; error?: string };
  /** Age of every on chain price settlement reads; null where none was ever published. */
  prices: { symbol: string; ageSeconds: number | null }[];
  /** SOL left on the keys that pay for things. Null when the key is not configured here. */
  balances: { name: BalanceName; sol: number | null }[];
  /** The worker's own Telegram listener, when this reading comes from the worker. */
  telegram?: { enabled: boolean; lastPollAgoSeconds: number | null; upSeconds: number };
  /** When the reading comes from the site: how long since the worker last checked in. */
  workerHeartbeatAgoSeconds?: number | null;
}

export type BalanceName = "faucet" | "agent" | "publisher";

export interface Problem {
  /** Stable while the same thing is wrong, so it is reported once rather than every check. */
  key: string;
  text: string;
}

/** Warn before the program's ten minute refusal, not after it. */
export const STALE_PRICE_SECONDS = 8 * 60;
/** Enough SOL for a few hundred transactions on devnet. */
export const LOW_SOL = 0.1;
/** A long poll returns within 35 seconds; three minutes of silence is not a slow network. */
export const TELEGRAM_SILENT_SECONDS = 3 * 60;
/** The worker writes its heartbeat every five minutes with a ten minute expiry. */
export const WORKER_SILENT_SECONDS = 15 * 60;

const WHAT_IT_PAYS: Record<BalanceName, string> = {
  faucet: "the fees for trades, moves and demo cash",
  agent: "the autopilot's rebalances and settlements",
  publisher: "writing prices on chain, so every price will go stale",
};

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

export function findProblems(reading: HealthReading): Problem[] {
  const problems: Problem[] = [];

  if (!reading.store.ok) {
    problems.push({
      key: "store",
      text: `The shared store is refusing commands (${reading.store.error ?? "no reason given"}). Price triggers, the autopilot, Telegram linking and the chart lines are all stopped until it answers.`,
    });
  }

  const stale = reading.prices.filter((p) => p.ageSeconds === null || p.ageSeconds > STALE_PRICE_SECONDS);
  if (stale.length > 0 && stale.length === reading.prices.length) {
    problems.push({
      key: "prices:all",
      text: `Every on chain price is stale or missing. The price publisher looks stopped, so every trade and settlement will be refused. Run scripts/publisher.sh status on the server.`,
    });
  } else if (stale.length > 0) {
    const names = stale.map((p) => (p.ageSeconds === null ? `${p.symbol} (never published)` : `${p.symbol} (${minutes(p.ageSeconds)} old)`));
    problems.push({
      key: `prices:${stale.map((p) => p.symbol).sort().join(",")}`,
      text: `Stale on chain prices: ${names.join(", ")}. Trades in ${stale.length === 1 ? "that asset" : "those assets"} will be refused until the publisher writes a fresh price.`,
    });
  }

  for (const balance of reading.balances) {
    if (balance.sol !== null && balance.sol < LOW_SOL) {
      problems.push({
        key: `balance:${balance.name}`,
        text: `The ${balance.name} key has ${balance.sol.toFixed(3)} SOL left. It pays for ${WHAT_IT_PAYS[balance.name]}. Top it up on devnet.`,
      });
    }
  }

  const tg = reading.telegram;
  if (tg?.enabled) {
    const silent = tg.lastPollAgoSeconds === null ? tg.upSeconds : tg.lastPollAgoSeconds;
    if (silent > TELEGRAM_SILENT_SECONDS) {
      problems.push({
        key: "telegram",
        text: `The Telegram listener has not heard from Telegram for ${minutes(silent)}. Linking and replies to the bot are stuck.`,
      });
    }
  }

  if (reading.workerHeartbeatAgoSeconds !== undefined) {
    const ago = reading.workerHeartbeatAgoSeconds;
    if (ago === null || ago > WORKER_SILENT_SECONDS) {
      problems.push({
        key: "worker",
        text:
          ago === null
            ? "The background worker has not checked in. Price triggers, the autopilot and Telegram are stopped. Run scripts/worker.sh status on the server."
            : `The background worker last checked in ${minutes(ago)} ago. Price triggers, the autopilot and Telegram are stopped. Run scripts/worker.sh status on the server.`,
      });
    }
  }

  return problems;
}
