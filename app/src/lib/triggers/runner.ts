import "server-only";

import { PublicKey } from "@solana/web3.js";

import { assetBySymbol } from "../agent-actions";
import { explorerUrl } from "../chain";
import { CLUSTER } from "../cluster";
import type { PortfolioHoldings } from "../holdings";
import { getConnection } from "../rpc";
import { readAssetPrice } from "../settlement-prices";
import { sendToOwner } from "../telegram/bot";
import { executeWalletTrade } from "../wallet-trade";
import {
  describeCondition,
  describeTrigger,
  describeWait,
  fireTime,
  isDue,
  nextCheck,
  type Trigger,
  type TriggerStatus,
} from "./rules";
import { activeTriggers, transition } from "./state";

/**
 * Checks every active trigger against the price trades fill at, and fires the
 * ones whose condition holds.
 *
 * Firing is: claim the trigger (active to firing, so no second pass can fire
 * it too), place the trade if there is one, record what happened, and tell
 * the owner on Telegram. A trade that fails leaves the trigger failed rather
 * than active, because retrying a buy every minute on a condition that has
 * already passed is how a small alert becomes a large surprise.
 *
 * One price read per asset per pass, however many triggers watch it.
 *
 * A timed trigger due before the next minute's pass gets its own wake up at
 * its time, so "in 2 minutes" means two minutes, not up to three.
 *
 * A repeating trigger goes back to active after each run with its next check
 * time, until its run cap is reached. A failed trade stops it for good, for
 * the same reason as above: an order that failed for want of cash would only
 * fail again every interval.
 */

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function tokensMoved(before: PortfolioHoldings | undefined, after: PortfolioHoldings | undefined, symbol: string) {
  const a = before?.assets.find((x) => x.symbol === symbol)?.uiAmount ?? 0;
  const b = after?.assets.find((x) => x.symbol === symbol)?.uiAmount ?? 0;
  return Math.abs(b - a);
}

async function tell(owner: string, lines: (string | null)[]): Promise<void> {
  await sendToOwner(owner, lines.filter(Boolean).join("\n\n")).catch(() => "failed");
}

async function fire(trigger: Trigger, price: number): Promise<Trigger | null> {
  const claimed = await transition(trigger.id, "active", "firing", { firedAt: Date.now(), firedPrice: price });
  if (!claimed) return null;

  const repeat = trigger.repeat;
  const run = (trigger.runs ?? 0) + 1;
  const timed = trigger.condition.kind === "after";
  const moved = repeat
    ? `Run ${run} of ${repeat.maxRuns}: ${trigger.symbol} is ${usd(price)} now, ${usd(trigger.basePrice)} when set.`
    : trigger.condition.kind === "after"
      ? `${describeWait(trigger.condition.minutes)} are up: ${trigger.symbol} is ${usd(price)} now, ${usd(trigger.basePrice)} when set.`
      : `${trigger.symbol} ${describeCondition(trigger.condition, trigger.basePrice).replace(/ \(to .*\)$/, "")}: now ${usd(price)}, set at ${usd(trigger.basePrice)}.`;
  const name = repeat ? "repeating trigger" : timed ? "timed trigger" : "price trigger";

  // A repeating trigger that succeeded goes back to watching until its last run.
  const after = (ok: boolean): { status: TriggerStatus; patch: Partial<Trigger> } => {
    if (!ok) return { status: "failed", patch: {} };
    if (!repeat || run >= repeat.maxRuns) return { status: "fired", patch: repeat ? { runs: run } : {} };
    const due = trigger.nextAt ?? trigger.createdAt;
    return { status: "active", patch: { runs: run, nextAt: nextCheck(due, repeat.everyMinutes, Date.now()) } };
  };
  const ending = (status: TriggerStatus) =>
    !repeat
      ? null
      : status === "active"
        ? `Next check in ${describeWait(repeat.everyMinutes)}.`
        : status === "fired"
          ? "That was the last run."
          : null;

  if (trigger.action.kind === "notify") {
    const next = after(true);
    const done = await transition(trigger.id, "firing", next.status, { ...next.patch, result: moved, signature: null });
    await tell(trigger.owner, [
      repeat ? "Conduit repeating alert" : timed ? "Conduit timed alert" : "Conduit price alert",
      moved,
      ending(next.status),
    ]);
    return done;
  }

  const { kind, dollars } = trigger.action;
  let result: string;
  let signature: string | null = null;
  let ok = false;

  try {
    const trade = await executeWalletTrade({
      owner: new PublicKey(trigger.owner),
      side: kind,
      symbol: trigger.symbol,
      dollars,
    });
    const body = trade.body;
    if (body.traded) {
      ok = true;
      signature = String(body.signature);
      const tokens = tokensMoved(body.before as PortfolioHoldings, body.after as PortfolioHoldings, trigger.symbol);
      result = `${kind === "buy" ? "Bought" : "Sold"} ${usd(dollars)} of ${trigger.symbol}: ${tokens.toFixed(4)} tokens at ${usd(Number(body.price ?? price))}.`;
    } else {
      const reason = (body.programError as { name?: string } | undefined)?.name ?? body.error ?? body.detail ?? "no detail";
      result = `Tried to ${kind} ${usd(dollars)} of ${trigger.symbol}, but it did not go through (${String(reason)}). Nothing was traded.`;
    }
  } catch (error) {
    result = `Tried to ${kind} ${usd(dollars)} of ${trigger.symbol}, but it stopped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}. Nothing was traded.`;
  }

  const next = after(ok);
  const done = await transition(trigger.id, "firing", next.status, { ...next.patch, result: `${moved} ${result}`, signature });
  await tell(trigger.owner, [
    ok ? `Conduit ${name} fired` : `Conduit ${name}: the trade failed`,
    moved,
    result,
    !ok && repeat ? "The schedule is stopped, so it will not try again." : ending(next.status),
    signature ? explorerUrl(signature, "tx", CLUSTER) : null,
  ]);
  return done;
}

const shared = globalThis as typeof globalThis & {
  __conduitTriggerPass?: boolean;
  __conduitTriggerWake?: ReturnType<typeof setTimeout>;
};

/** The minute timer's period. A timed trigger due sooner than this gets its own wake up. */
const PASS_MS = 60_000;

/**
 * Sets one wake up for the earliest timed trigger due before the next regular
 * pass. Replaced on every pass, so there is never more than one waiting.
 */
function wakeForTimed(active: Trigger[], now: number): void {
  if (shared.__conduitTriggerWake) clearTimeout(shared.__conduitTriggerWake);
  shared.__conduitTriggerWake = undefined;
  const due = active
    .map((t) => fireTime(t))
    .filter((at): at is number => at !== null && at > now && at - now < PASS_MS);
  if (due.length === 0) return;
  // A little after the time, so the clock check in isMet is already true.
  const delay = Math.min(...due) - now + 250;
  shared.__conduitTriggerWake = setTimeout(() => {
    shared.__conduitTriggerWake = undefined;
    void checkTriggers().catch(() => {});
  }, delay);
  shared.__conduitTriggerWake.unref?.();
}

/** One pass over every active trigger. Returns the ones it finished. */
export async function checkTriggers(now = Date.now()): Promise<Trigger[]> {
  // A pass that outlasts the interval must not start a second over the same
  // triggers; the claim already prevents a double fire, this saves the reads.
  if (shared.__conduitTriggerPass) return [];
  shared.__conduitTriggerPass = true;

  const finished: Trigger[] = [];
  try {
    const active = await activeTriggers();

    for (const t of active.filter((t) => t.expiresAt <= now)) {
      const ran = t.runs ?? 0;
      const why = t.repeat
        ? `Its time is up after ${ran} of ${t.repeat.maxRuns} run${t.repeat.maxRuns === 1 ? "" : "s"}.`
        : t.condition.kind === "after"
          ? "No fresh price could be read in time, so nothing happened."
          : "The condition was never met, so nothing happened.";
      const done = await transition(t.id, "active", "expired", { result: why });
      if (done) {
        finished.push(done);
        await tell(t.owner, [
          t.repeat ? "Conduit repeating trigger ended" : t.condition.kind === "after" ? "Conduit timed trigger expired" : "Conduit price trigger expired",
          describeTrigger(t),
          why,
        ]);
      }
    }

    const live = active.filter((t) => t.expiresAt > now);
    // The latest copy of each trigger still watching, for the wake up below.
    const watching = new Map(live.map((t) => [t.id, t]));
    const connection = getConnection();
    for (const symbol of [...new Set(live.map((t) => t.symbol))]) {
      const asset = assetBySymbol(symbol);
      if (!asset) continue;
      const read = await readAssetPrice(connection, asset).catch(() => null);
      // A price that cannot be read, or is stale, fires nothing. The next pass
      // tries again.
      if (!read || !read.ok) continue;
      for (const t of live.filter((t) => t.symbol === symbol)) {
        const at = Date.now();
        if (isDue(t, read.price.price, at)) {
          const done = await fire(t, read.price.price);
          if (!done) continue;
          if (done.status === "active") watching.set(done.id, done);
          else {
            watching.delete(done.id);
            finished.push(done);
          }
        } else if (t.repeat && at >= (t.nextAt ?? t.createdAt)) {
          // A repeating check whose condition did not hold: nothing to do
          // until the next interval.
          const moved = await transition(t.id, "active", "active", {
            nextAt: nextCheck(t.nextAt ?? t.createdAt, t.repeat.everyMinutes, at),
          });
          if (moved) watching.set(moved.id, moved);
        }
      }
    }
    wakeForTimed([...watching.values()], Date.now());
  } finally {
    shared.__conduitTriggerPass = false;
  }
  return finished;
}
