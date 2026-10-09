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
import { kv, storeCommands } from "../src/lib/kv";
import { AlertBook } from "../src/lib/ops/alerts";
import { readBalances, readPriceAges } from "../src/lib/ops/check";
import { findProblems, type HealthReading } from "../src/lib/ops/health";
import { getConnection } from "../src/lib/rpc";
import { botToken, deliver, lastPollAt } from "../src/lib/telegram/bot";

const started = Date.now();
const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

async function main(): Promise<void> {
  if (!backgroundJobsEnabled()) {
    console.error("CONDUIT_BACKGROUND_JOBS is off in this environment, so the worker has nothing to do. Remove it here.");
    process.exit(1);
  }

  const store = kv();
  // A store that refuses at start used to end the process, and the supervisor
  // restarted it every fifteen seconds in a loop nobody saw. It starts anyway
  // now: every job already survives a failed store call, and the health check
  // below is what tells someone, which a crash loop never did.
  await store.set("worker:started", String(started)).catch((error: unknown) => {
    console.error(`[${stamp()}] STORE FAILING at start: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (store.backend === "file") {
    console.warn(`[${stamp()}] warning: using the local file store. The site on Vercel will not see these records; set Upstash.`);
  }

  startScheduler();
  console.log(`[${stamp()}] worker started: store ${store.backend}, telegram ${botToken() ? "on" : "off (no token)"}`);

  // A heartbeat in the log and in the store, so "is the worker alive" has an
  // answer from either side.
  //
  // Alive is not the same as working. The store once ran out of its monthly
  // allowance and refused every command for a day and a half while this line
  // kept saying alive, because nothing here looked at the store's answer. The
  // heartbeat's own write is that check now, and the line says how many
  // commands the last five minutes cost, so a rate that would run the
  // allowance out shows up long before it does.
  let counted = storeCommands();
  const book = new AlertBook();
  const check = async () => {
    const poll = lastPollAt();
    const store = await beat();
    const used = storeCommands() - counted;
    counted = storeCommands();
    const problems = await healthProblems(store, poll);
    console.log(
      `[${stamp()}] alive ${Math.round((Date.now() - started) / 60_000)} min, ${store.ok ? "store ok" : `STORE FAILING: ${store.error}`}, ${used} store commands in 5 min` +
        (botToken() ? `, telegram last polled ${poll ? `${Math.round((Date.now() - poll) / 1000)}s ago` : "not yet"}` : "") +
        `, ${problems.length === 0 ? "healthy" : `${problems.length} problem${problems.length === 1 ? "" : "s"}`}`,
    );
    for (const message of book.update(problems, Date.now())) await alert(message);
  };
  setInterval(() => void check().catch(() => {}), 5 * 60_000);
  // The first check waits a minute, so the Telegram listener has had time to
  // poll before its silence counts against it.
  void beat();
  setTimeout(() => void check().catch(() => {}), 60_000);
}

/** Writes the heartbeat and says whether the store took it. */
async function beat(): Promise<HealthReading["store"]> {
  try {
    await kv().set("worker:heartbeat", String(Date.now()), { exSeconds: 600 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

/** Everything the worker can see is wrong, with the store already checked by the heartbeat. */
async function healthProblems(store: HealthReading["store"], poll: number | null) {
  const connection = getConnection();
  const [prices, balances] = await Promise.all([
    readPriceAges(connection).catch(() => []),
    readBalances(connection).catch(() => []),
  ]);
  return findProblems({
    store,
    prices,
    balances,
    telegram: {
      enabled: Boolean(botToken()),
      lastPollAgoSeconds: poll ? Math.round((Date.now() - poll) / 1000) : null,
      upSeconds: Math.round((Date.now() - started) / 1000),
    },
  });
}

/**
 * Logs a health message, and sends it to the operator's Telegram chat when
 * OPS_TELEGRAM_CHAT_ID is set. Send /chatid to the bot to find the number.
 */
let hinted = false;
async function alert(message: string): Promise<void> {
  console.log(`[${stamp()}] ${message}`);
  const chatId = Number(process.env.OPS_TELEGRAM_CHAT_ID);
  if (!botToken() || !Number.isFinite(chatId) || chatId === 0) {
    if (!hinted) {
      hinted = true;
      console.log(`[${stamp()}] set OPS_TELEGRAM_CHAT_ID to get these on Telegram; send /chatid to the bot for the number`);
    }
    return;
  }
  const outcome = await deliver(chatId, message);
  if (outcome !== "sent") console.error(`[${stamp()}] could not send the alert to Telegram: ${outcome}`);
}

process.on("unhandledRejection", (reason) => {
  // Logged, not fatal: one failed job must not take the others down.
  console.error(`[${stamp()}] unhandled: ${reason instanceof Error ? reason.message : String(reason)}`);
});

main().catch((error: unknown) => {
  console.error(`[${stamp()}] worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
