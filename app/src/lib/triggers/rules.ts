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
 * A trigger can also wait on the clock instead of a price: "in 2 minutes, buy
 * $50 of AAPL". The clock starts when the owner approves, and it fires on the
 * first check after the time, at the price at that moment.
 *
 * And it can repeat: "buy $20 of AAPL every 10 minutes", or "every 10 minutes,
 * if NVDA is above $180, buy $100 of it". A repeating trigger checks once per
 * interval, acts each time its condition holds, and stops after a set number
 * of runs, so the most it can ever spend is known and shown before approval.
 *
 * Pure: the runner does the reading, trading and messaging.
 */

export type Condition =
  | { kind: "rise"; percent: number }
  | { kind: "fall"; percent: number }
  | { kind: "above"; price: number }
  | { kind: "below"; price: number }
  /** Fires this many minutes after the trigger is set. */
  | { kind: "after"; minutes: number }
  /** No price condition: a repeating trigger that acts at every interval. */
  | { kind: "always" };

/** How a trigger repeats. The run cap bounds the most it can ever trade. */
export interface Repeat {
  everyMinutes: number;
  maxRuns: number;
}

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
  /** Set on a repeating trigger. */
  repeat?: Repeat;
  /** Times a repeating trigger has acted. */
  runs?: number;
  /** When a repeating trigger next checks. */
  nextAt?: number;
}

export const DEFAULT_TTL_DAYS = 7;
export const MAX_TTL_DAYS = 30;

/** The shortest wait a timed trigger accepts, since it is checked about once a minute. */
export const MIN_DELAY_MINUTES = 1;

/** A repeating trigger runs this many times when nobody says how many. */
export const DEFAULT_RUNS = 10;
export const MAX_RUNS = 200;

/**
 * How long a timed trigger may still fire after its time, if no price could be
 * read at the moment. Past this it expires instead: a buy placed an hour late
 * is not the buy that was asked for.
 */
export const TIMED_GRACE_MS = 10 * 60_000;

/** When a timed or repeating trigger next acts, or null for a one off price condition. */
export function fireTime(trigger: Pick<Trigger, "condition" | "createdAt"> & Pick<Partial<Trigger>, "nextAt" | "repeat">): number | null {
  if (trigger.repeat) return trigger.nextAt ?? trigger.createdAt;
  return trigger.condition.kind === "after" ? trigger.createdAt + trigger.condition.minutes * 60_000 : null;
}

/**
 * When a trigger stops watching, given when it was set.
 *
 * A plain repeating trigger stops after its last interval. One with a price
 * condition may pass many intervals without acting, so it keeps the days
 * limit, and the run cap still bounds what it trades.
 */
export function expiryFor(condition: Condition, createdAt: number, days = DEFAULT_TTL_DAYS, repeat?: Repeat): number {
  if (repeat && condition.kind === "always") {
    return createdAt + (repeat.maxRuns - 1) * repeat.everyMinutes * 60_000 + TIMED_GRACE_MS;
  }
  if (condition.kind === "after") return createdAt + condition.minutes * 60_000 + TIMED_GRACE_MS;
  return createdAt + days * 86_400_000;
}

/**
 * When a repeating trigger checks next, after a check at `now` that was due at
 * `due`. Kept on the grid it started on, unless the worker was away for a
 * whole interval, in which case it restarts from now rather than catching up
 * with a burst of trades.
 */
export function nextCheck(due: number, everyMinutes: number, now: number): number {
  const step = everyMinutes * 60_000;
  const next = due + step;
  return next > now ? next : now + step;
}

/** The price at which the condition holds. A timed trigger has none, so it is the price when set. */
export function targetPrice(condition: Condition, basePrice: number): number {
  switch (condition.kind) {
    case "always":
    case "after":
      return basePrice;
    case "rise":
      return basePrice * (1 + condition.percent / 100);
    case "fall":
      return basePrice * (1 - condition.percent / 100);
    case "above":
    case "below":
      return condition.price;
  }
}

/**
 * Whether a price meets the condition. A rise or above fires at or past the
 * target. A timed trigger ignores the price and fires once its time has come.
 */
export function isMet(
  trigger: Pick<Trigger, "condition" | "basePrice"> & { createdAt?: number },
  price: number,
  now = Date.now(),
): boolean {
  if (trigger.condition.kind === "always") return true;
  if (trigger.condition.kind === "after") {
    return trigger.createdAt !== undefined && now >= trigger.createdAt + trigger.condition.minutes * 60_000;
  }
  const target = targetPrice(trigger.condition, trigger.basePrice);
  return trigger.condition.kind === "rise" || trigger.condition.kind === "above" ? price >= target : price <= target;
}

/**
 * Whether a trigger should act now. A repeating one waits for its next check
 * time and then acts only if its condition holds; anything else is isMet.
 */
export function isDue(
  trigger: Pick<Trigger, "condition" | "basePrice" | "createdAt"> & Pick<Partial<Trigger>, "nextAt" | "repeat">,
  price: number,
  now = Date.now(),
): boolean {
  if (trigger.repeat) return now >= (trigger.nextAt ?? trigger.createdAt) && isMet(trigger, price, now);
  return isMet(trigger, price, now);
}

/** Refuses a repeat that is too fast, too long, or paired with a one off wait. */
export function validateRepeat(condition: Condition, repeat: Repeat | undefined): string | null {
  if (!repeat) {
    return condition.kind === "always" ? "A trigger with no condition must repeat. Say how often." : null;
  }
  if (condition.kind === "after") return "A repeating trigger starts straight away; it cannot also wait first.";
  if (!(repeat.everyMinutes >= MIN_DELAY_MINUTES)) return "It can repeat at most once a minute.";
  if (repeat.everyMinutes > MAX_TTL_DAYS * 1440) return `It can repeat at most every ${MAX_TTL_DAYS} days.`;
  if (!Number.isInteger(repeat.maxRuns) || repeat.maxRuns < 1) return "The number of runs must be a whole number above zero.";
  if (repeat.maxRuns > MAX_RUNS) return `It can run at most ${MAX_RUNS} times.`;
  if (condition.kind === "always" && (repeat.maxRuns - 1) * repeat.everyMinutes > MAX_TTL_DAYS * 1440) {
    return `That schedule runs past ${MAX_TTL_DAYS} days. Ask for fewer runs or a shorter interval.`;
  }
  return null;
}

/**
 * Refuses a condition that is already true, or one that can never be.
 *
 * "Alert me when NVDA goes above $200" with NVDA at $226 would fire on the
 * next check, which is almost never what someone meant, so it is refused
 * with the reason rather than fired straight away.
 */
export function validate(condition: Condition, basePrice: number, repeating = false): string | null {
  if (!(basePrice > 0)) return "There is no current price to measure from.";
  if (condition.kind === "always") return null;
  if (condition.kind === "after") {
    if (!(condition.minutes >= MIN_DELAY_MINUTES)) return `The wait must be at least ${MIN_DELAY_MINUTES} minute.`;
    if (condition.minutes > MAX_TTL_DAYS * 1440) return `The wait can be at most ${MAX_TTL_DAYS} days.`;
    return null;
  }
  if (condition.kind === "rise" || condition.kind === "fall") {
    if (!(condition.percent > 0)) return "The percentage must be above zero.";
    if (condition.kind === "fall" && condition.percent >= 100) return "A fall must be less than 100%.";
    return null;
  }
  if (!(condition.price > 0)) return "The price must be above zero.";
  // A repeating trigger acts while the level holds, so one that already holds
  // is the point, not a mistake.
  if (repeating) return null;
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

/** "2 minutes", "1 hour 30 minutes", "3 days" */
export function describeWait(minutes: number): string {
  const whole = Math.round(minutes);
  const days = Math.floor(whole / 1440);
  const hours = Math.floor((whole % 1440) / 60);
  const mins = whole % 60;
  const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? "" : "s"}` : null);
  return [part(days, "day"), part(hours, "hour"), part(mins, "minute")].filter(Boolean).join(" ") || "0 minutes";
}

/** "rises 2.5% (to $231.70)" */
export function describeCondition(condition: Condition, basePrice: number): string {
  const target = usd(targetPrice(condition, basePrice));
  switch (condition.kind) {
    case "always":
      return "at every check";
    case "after":
      return `${describeWait(condition.minutes)} after it is set`;
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
/** "every 10 minutes", "every hour" */
export function describeEvery(minutes: number): string {
  if (minutes === 1) return "every minute";
  if (minutes === 60) return "every hour";
  if (minutes === 1440) return "every day";
  return `every ${describeWait(minutes)}`;
}

export function describeTrigger(
  trigger: Pick<Trigger, "symbol" | "condition" | "basePrice" | "action"> & { repeat?: Repeat },
): string {
  if (trigger.repeat) {
    const { everyMinutes, maxRuns } = trigger.repeat;
    const what =
      trigger.action.kind === "notify"
        ? `message you the price of ${trigger.symbol}`
        : `${trigger.action.kind} ${usd(trigger.action.dollars)} of ${trigger.symbol}`;
    const when =
      trigger.condition.kind === "always"
        ? ""
        : ` if ${trigger.symbol} ${describeCondition(trigger.condition, trigger.basePrice)}`;
    const times = `${maxRuns} time${maxRuns === 1 ? "" : "s"} at most`;
    const cap = trigger.action.kind === "notify" ? times : `${times}, ${usd(trigger.action.dollars * maxRuns)} in all`;
    const every = describeEvery(everyMinutes);
    return `${every[0].toUpperCase()}${every.slice(1)},${when}${when ? "," : ""} ${what}, ${cap}.`;
  }
  if (trigger.condition.kind === "after") {
    const what = describeAction(trigger.action, trigger.symbol);
    return `${describeWait(trigger.condition.minutes)} after it is set, ${trigger.action.kind === "notify" ? `message you the price of ${trigger.symbol}` : what}.`;
  }
  return `When ${trigger.symbol} ${describeCondition(trigger.condition, trigger.basePrice)}, ${describeAction(trigger.action, trigger.symbol)}.`;
}
