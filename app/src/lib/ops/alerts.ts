import type { Problem } from "./health";

/**
 * When to tell the operator about a problem, so a phone hears about it once,
 * is reminded if it lasts, and hears when it is over.
 *
 * Every five minutes the worker finds the same problems again. Sending each
 * one every time would bury the message that matters, and sending it once
 * would let a problem that outlasts a busy evening be forgotten. So: a
 * message when a problem appears, a reminder every few hours while it lasts,
 * and a recovery message when it clears. Kept in memory; a restarted worker
 * reports what is still wrong once more, which is the right thing for a
 * restart to do.
 */

export const REMIND_MS = 6 * 60 * 60 * 1000;

interface Open {
  since: number;
  lastSent: number;
  text: string;
}

export class AlertBook {
  private open = new Map<string, Open>();

  /** The messages this check should send, given the problems found now. */
  update(problems: Problem[], now: number): string[] {
    const messages: string[] = [];
    const seen = new Set<string>();

    for (const problem of problems) {
      seen.add(problem.key);
      const known = this.open.get(problem.key);
      if (!known) {
        this.open.set(problem.key, { since: now, lastSent: now, text: problem.text });
        messages.push(`Conduit problem: ${problem.text}`);
      } else if (now - known.lastSent >= REMIND_MS) {
        known.lastSent = now;
        known.text = problem.text;
        const hours = Math.round((now - known.since) / 3_600_000);
        messages.push(`Still broken after ${hours} hour${hours === 1 ? "" : "s"}: ${problem.text}`);
      }
    }

    for (const [key, known] of this.open) {
      if (seen.has(key)) continue;
      this.open.delete(key);
      const mins = Math.max(1, Math.round((now - known.since) / 60_000));
      messages.push(`Recovered after ${mins} minute${mins === 1 ? "" : "s"}: ${known.text}`);
    }

    return messages;
  }

  /** How many problems are open right now. */
  get size(): number {
    return this.open.size;
  }
}
