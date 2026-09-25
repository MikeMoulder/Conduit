import "server-only";

import { startTelegramPoller } from "../telegram/bot";
import { checkTriggers } from "../triggers/runner";
import { runCycle } from "./cycle";
import { notify } from "./notify";
import {
  dueEntries,
  markRun,
  recordDecision,
  type AutopilotEntry,
  type Decision,
} from "./state";

/**
 * When cycles run, and making sure they never trip over each other.
 *
 * A timer in the server process checks once a minute for mandates whose next
 * run is due and runs them one at a time. One at a time is deliberate: each
 * cycle is a five stage analysis, and the model provider rate limits per
 * minute, so cycles in parallel would mostly just queue each other's failures.
 *
 * A mandate is never run twice at once. The timer and a "run it now" from the
 * chat could otherwise both land on the same mandate and each send a
 * rebalance, which the program would accept, because each is within the rules
 * on its own.
 */

/** How often the timer looks for due mandates. */
const TICK_MS = 60_000;

/**
 * Shared on the global object, not held in this module.
 *
 * The timer can be started from several routes, and in development each route
 * may evaluate its own copy of this module. A guard held in one copy would not
 * see a cycle started through another, and the whole point of the guard is to
 * see exactly that.
 */
const shared = globalThis as unknown as {
  __conduitAutopilot?: ReturnType<typeof setInterval>;
  __conduitTriggerTimer?: ReturnType<typeof setInterval>;
  __conduitAutopilotRunning?: Set<string>;
  __conduitAutopilotTicking?: boolean;
};
shared.__conduitAutopilotRunning ??= new Set<string>();
const running = shared.__conduitAutopilotRunning;

export async function runNow(entry: AutopilotEntry): Promise<Decision> {
  if (running.has(entry.mandate)) {
    return {
      mandate: entry.mandate,
      owner: entry.owner,
      at: Date.now(),
      outcome: "skipped",
      summary: "A cycle for this mandate is already running.",
      reasoning: null,
      positions: [],
      signatures: [],
    };
  }

  running.add(entry.mandate);
  let decision: Decision;
  try {
    decision = await runCycle(entry);
  } catch (error) {
    decision = {
      mandate: entry.mandate,
      owner: entry.owner,
      at: Date.now(),
      outcome: "failed",
      summary: `The cycle stopped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      reasoning: null,
      positions: [],
      signatures: [],
    };
  } finally {
    running.delete(entry.mandate);
  }

  markRun(entry.mandate, decision.at);
  recordDecision(decision);
  await notify(decision, entry);
  return decision;
}

export async function runDue(): Promise<void> {
  // A tick that outlasts the interval must not start a second pass over the
  // same list; the next tick picks up whatever is still due.
  if (shared.__conduitAutopilotTicking) return;
  shared.__conduitAutopilotTicking = true;
  try {
    for (const entry of dueEntries(Date.now())) {
      await runNow(entry);
    }
  } finally {
    shared.__conduitAutopilotTicking = false;
  }
}

/**
 * Starts the timer, once per server process.
 *
 * Guarded on the global object because in development the module can be
 * evaluated more than once, and two timers would double every cycle.
 */
export function startScheduler(): void {
  // The bot's listener rides along: it has its own once per process guard.
  startTelegramPoller();
  // Price triggers keep their own timer and guard, so a server whose
  // autopilot timer was started by older code still starts this one.
  if (!shared.__conduitTriggerTimer) {
    shared.__conduitTriggerTimer = setInterval(() => {
      void checkTriggers().catch(() => {
        // Each trigger records its own outcome; a failure here must not take
        // the timer down.
      });
    }, TICK_MS);
  }
  if (shared.__conduitAutopilot) return;
  shared.__conduitAutopilot = setInterval(() => {
    void runDue().catch(() => {
      // Each cycle records its own failure; a failure here is the timer's own
      // and must not take the timer down.
    });
  }, TICK_MS);
}
