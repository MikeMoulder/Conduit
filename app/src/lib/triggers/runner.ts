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
import { describeCondition, describeTrigger, describeWait, fireTime, isMet, type Trigger } from "./rules";
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

  const timed = trigger.condition.kind === "after";
  const moved = timed
    ? `${describeWait((trigger.condition as { minutes: number }).minutes)} are up: ${trigger.symbol} is ${usd(price)} now, ${usd(trigger.basePrice)} when set.`
    : `${trigger.symbol} ${describeCondition(trigger.condition, trigger.basePrice).replace(/ \(to .*\)$/, "")}: now ${usd(price)}, set at ${usd(trigger.basePrice)}.`;
  const name = timed ? "timed trigger" : "price trigger";

  if (trigger.action.kind === "notify") {
    const done = await transition(trigger.id, "firing", "fired", { result: moved, signature: null });
    await tell(trigger.owner, [timed ? "Conduit timed alert" : "Conduit price alert", moved]);
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

  const done = await transition(trigger.id, "firing", ok ? "fired" : "failed", { result: `${moved} ${result}`, signature });
  await tell(trigger.owner, [
    ok ? `Conduit ${name} fired` : `Conduit ${name}: the trade failed`,
    moved,
    result,
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
      const done = await transition(t.id, "active", "expired", { result: "Expired without the condition being met." });
      if (done) {
        finished.push(done);
        await tell(
          t.owner,
          t.condition.kind === "after"
            ? ["Conduit timed trigger expired", describeTrigger(t), "No fresh price could be read in time, so nothing happened."]
            : ["Conduit price trigger expired", describeTrigger(t), "The condition was never met, so nothing happened."],
        );
      }
    }

    const live = active.filter((t) => t.expiresAt > now);
    const connection = getConnection();
    for (const symbol of [...new Set(live.map((t) => t.symbol))]) {
      const asset = assetBySymbol(symbol);
      if (!asset) continue;
      const read = await readAssetPrice(connection, asset).catch(() => null);
      // A price that cannot be read, or is stale, fires nothing. The next pass
      // tries again.
      if (!read || !read.ok) continue;
      for (const t of live.filter((t) => t.symbol === symbol && isMet(t, read.price.price, Date.now()))) {
        const done = await fire(t, read.price.price);
        if (done) finished.push(done);
      }
    }
    wakeForTimed(live.filter((t) => !finished.some((f) => f.id === t.id)), Date.now());
  } finally {
    shared.__conduitTriggerPass = false;
  }
  return finished;
}
