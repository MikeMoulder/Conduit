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
import { describeCondition, describeTrigger, isMet, type Trigger } from "./rules";
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
  const claimed = transition(trigger.id, "active", "firing", { firedAt: Date.now(), firedPrice: price });
  if (!claimed) return null;

  const moved = `${trigger.symbol} ${describeCondition(trigger.condition, trigger.basePrice).replace(/ \(to .*\)$/, "")}: now ${usd(price)}, set at ${usd(trigger.basePrice)}.`;

  if (trigger.action.kind === "notify") {
    const done = transition(trigger.id, "firing", "fired", { result: moved, signature: null });
    await tell(trigger.owner, ["Conduit price alert", moved]);
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

  const done = transition(trigger.id, "firing", ok ? "fired" : "failed", { result: `${moved} ${result}`, signature });
  await tell(trigger.owner, [
    ok ? "Conduit price trigger fired" : "Conduit price trigger: the trade failed",
    moved,
    result,
    signature ? explorerUrl(signature, "tx", CLUSTER) : null,
  ]);
  return done;
}

const shared = globalThis as typeof globalThis & { __conduitTriggerPass?: boolean };

/** One pass over every active trigger. Returns the ones it finished. */
export async function checkTriggers(now = Date.now()): Promise<Trigger[]> {
  // A pass that outlasts the interval must not start a second over the same
  // triggers; the claim already prevents a double fire, this saves the reads.
  if (shared.__conduitTriggerPass) return [];
  shared.__conduitTriggerPass = true;

  const finished: Trigger[] = [];
  try {
    const active = activeTriggers();

    for (const t of active.filter((t) => t.expiresAt <= now)) {
      const done = transition(t.id, "active", "expired", { result: "Expired without the condition being met." });
      if (done) {
        finished.push(done);
        await tell(t.owner, ["Conduit price trigger expired", describeTrigger(t), "The condition was never met, so nothing happened."]);
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
      for (const t of live.filter((t) => t.symbol === symbol && isMet(t, read.price.price))) {
        const done = await fire(t, read.price.price);
        if (done) finished.push(done);
      }
    }
  } finally {
    shared.__conduitTriggerPass = false;
  }
  return finished;
}
