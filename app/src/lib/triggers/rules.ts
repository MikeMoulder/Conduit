/**
 * Price triggers: "when NVDA rises 2.5%, message me and buy $500 of it".
 *
 * A trigger watches one asset's price and, the first time a condition holds,
 * does one thing: tells the owner, and optionally places a buy or sell in
 * their main wallet. Then it is done. It never fires twice, and it expires if
 * the condition never comes.
 *
 * Measured against the price trades fill at, the one the program reads on
 * chain, not the one the chat quotes. The two agree to cents, but a trigger
 * that fired on one price and traded on another would be firing on a number
 * the trade never saw.
 *
 * Pure: the runner does the reading, trading and messaging.
 */

export type Condition =
  | { kind: "rise"; percent: number }
  | { kind: "fall"; percent: number }
  | { kind: "above"; price: number }
  | { kind: "below"; price: number };

export type TriggerAction = { kind: "notify" } | { kind: "buy" | "sell"; dollars: number };

export type TriggerStatus = "active" | "firing" | "fired" | "failed" | "cancelled" | "expired";

export interface Trigger {
  id: string;
  owner: string;
  symbol: string;
  condition: Condition;
  /** The price when it was set, which a rise or fall is measured from. */
  basePrice: number;
  action: TriggerAction;
  createdAt: number;
  expiresAt: number;
  status: TriggerStatus;
  firedAt?: number;
  firedPrice?: number;
  /** What happened when it fired, in a sentence. */
  result?: string;
  signature?: string | null;
}

export const DEFAULT_TTL_DAYS = 7;
export const MAX_TTL_DAYS = 30;

/** The price at which the condition holds. */
export function targetPrice(condition: Condition, basePrice: number): number {
  switch (condition.kind) {
    case "rise":
      return basePrice * (1 + condition.percent / 100);
    case "fall":
      return basePrice * (1 - condition.percent / 100);
    case "above":
    case "below":
      return condition.price;
  }
}

/** Whether a price meets the condition. A rise or above fires at or past the target. */
export function isMet(trigger: Pick<Trigger, "condition" | "basePrice">, price: number): boolean {
  const target = targetPrice(trigger.condition, trigger.basePrice);
  return trigger.condition.kind === "rise" || trigger.condition.kind === "above" ? price >= target : price <= target;
}

/**
 * Refuses a condition that is already true, or one that can never be.
 *
 * "Alert me when NVDA goes above $200" with NVDA at $226 would fire on the
 * next check, which is almost never what someone meant, so it is refused
 * with the reason rather than fired straight away.
 */
export function validate(condition: Condition, basePrice: number): string | null {
  if (!(basePrice > 0)) return "There is no current price to measure from.";
  if (condition.kind === "rise" || condition.kind === "fall") {
    if (!(condition.percent > 0)) return "The percentage must be above zero.";
    if (condition.kind === "fall" && condition.percent >= 100) return "A fall must be less than 100%.";
    return null;
  }
  if (!(condition.price > 0)) return "The price must be above zero.";
  if (condition.kind === "above" && condition.price <= basePrice) {
    return `It is already above that: the price is ${usd(basePrice)}.`;
  }
  if (condition.kind === "below" && condition.price >= basePrice) {
    return `It is already below that: the price is ${usd(basePrice)}.`;
  }
  return null;
}

function usd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "rises 2.5% (to $231.70)" */
export function describeCondition(condition: Condition, basePrice: number): string {
  const target = usd(targetPrice(condition, basePrice));
  switch (condition.kind) {
    case "rise":
      return `rises ${condition.percent}% (to ${target})`;
    case "fall":
      return `falls ${condition.percent}% (to ${target})`;
    case "above":
      return `reaches ${target} or more`;
    case "below":
      return `drops to ${target} or less`;
  }
}

/** "message you and buy $500 of NVDA" */
export function describeAction(action: TriggerAction, symbol: string): string {
  if (action.kind === "notify") return "message you";
  return `message you and ${action.kind} ${usd(action.dollars)} of ${symbol}`;
}

/** The whole trigger in one sentence. */
export function describeTrigger(trigger: Pick<Trigger, "symbol" | "condition" | "basePrice" | "action">): string {
  return `When ${trigger.symbol} ${describeCondition(trigger.condition, trigger.basePrice)}, ${describeAction(trigger.action, trigger.symbol)}.`;
}
