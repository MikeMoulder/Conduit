/**
 * The background worker: everything Conduit does with nobody on the page.
 *
 *   the autopilot       runs each due mandate's cycle
 *   price triggers      checks prices every minute and fires them
 *   the day lines       refreshes the market cards' charts
 *   the Telegram bot    listens for /start, /stop and anything else
 *
 * The site on Vercel runs with CONDUIT_BACKGROUND_JOBS=off, because a
 * serverless function is frozen between requests and its timers never fire.
 * This process runs them instead, on a machine that stays on, sharing every
 * record with the site through the shared store (Upstash). Run exactly one:
 * Telegram refuses a second listener for the same bot.
 *
 * Usage, from app/:
 *
 *   node --env-file=.env --import tsx --conditions=react-server scripts/worker.ts
 *
 * The react-server condition is what lets the app's server-only modules load
 * outside Next. scripts/worker.sh supervises it on the VPS.
 */

import { backgroundJobsEnabled, startScheduler } from "../src/lib/autopilot/scheduler";
import { kv } from "../src/lib/kv";
import { botToken, lastPollAt } from "../src/lib/telegram/bot";

const started = Date.now();
const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function main(): Promise<void> {
  if (!backgroundJobsEnabled()) {
    console.error("CONDUIT_BACKGROUND_JOBS is off in this environment, so the worker has nothing to do. Remove it here.");
    process.exit(1);
  }

  const store = kv();
  // Fail at start, loudly, rather than run jobs against a store that cannot
  // be reached: every trigger and decision would be lost.
  await store.set("worker:started", String(started));
  if (store.backend === "file") {
    console.warn(`[${stamp()}] warning: using the local file store. The site on Vercel will not see these records; set Upstash.`);
  }

  startScheduler();
  console.log(`[${stamp()}] worker started: store ${store.backend}, telegram ${botToken() ? "on" : "off (no token)"}`);

  // A heartbeat in the log and in the store, so "is the worker alive" has an
  // answer from either side.
  setInterval(() => {
    const poll = lastPollAt();
    void kv().set("worker:heartbeat", String(Date.now()), { exSeconds: 600 }).catch(() => {});
    console.log(
      `[${stamp()}] alive ${Math.round((Date.now() - started) / 60_000)} min` +
        (botToken() ? `, telegram last polled ${poll ? `${Math.round((Date.now() - poll) / 1000)}s ago` : "not yet"}` : ""),
    );
  }, 5 * 60_000);
  void kv().set("worker:heartbeat", String(Date.now()), { exSeconds: 600 }).catch(() => {});
}

process.on("unhandledRejection", (reason) => {
  // Logged, not fatal: one failed job must not take the others down.
  console.error(`[${stamp()}] unhandled: ${reason instanceof Error ? reason.message : String(reason)}`);
});

main().catch((error: unknown) => {
  console.error(`[${stamp()}] worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
