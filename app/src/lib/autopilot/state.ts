import "server-only";

import { hgetJson, hsetJson, hvaluesJson, kv, withLock } from "../kv";
import type { Score, ScoreState } from "./scorecard";

/**
 * What the autopilot remembers: which mandates it runs, and what it decided.
 *
 * In the shared store rather than on chain, on purpose. Nothing here is
 * authority. Whether the agent may act on a mandate was settled when the owner
 * signed it, and the program re-checks every transaction the autopilot sends.
 * This only records that the owner asked for the agent to act on a schedule,
 * and keeps a readable log of what it did, so the copilot can answer "what has
 * it been doing" without replaying the chain.
 *
 * Shared because the site and the worker both write it: the site switches a
 * mandate on or off, the worker records each run and decision. One record per
 * mandate, and a change to one takes a short lock, so a setting changed on the
 * site and a run recorded by the worker at the same moment cannot undo each
 * other.
 *
 *   ap:entries    mandate to its autopilot settings
 *   ap:decisions  the log, newest first, capped
 *   ap:scores     mandate to its score against SPY
 */

export interface AutopilotEntry {
  mandate: string;
  owner: string;
  mandateId: number;
  /** In the owner's words, handed to the analysis each cycle. */
  objective: string;
  everyMinutes: number;
  /**
   * Most the pre IPO names may hold together, in basis points.
   *
   * Optional so entries written before the pre IPO strategy still load; those
   * run with the default cap.
   */
  preIpoCapBps?: number;
  /**
   * The safety brake: how far below its best point the mandate may fall, in
   * basis points, before the autopilot moves to cash and stops. Zero means
   * no brake. Optional so older entries load; those get the default.
   */
  brakeBps?: number;
  /** When the brake tripped. Set, the autopilot stays off until resumed. */
  brakedAt?: number | null;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
}

export type DecisionOutcome = "rebalanced" | "held" | "skipped" | "failed" | "braked";

export interface Decision {
  mandate: string;
  owner: string;
  at: number;
  outcome: DecisionOutcome;
  /** One line a person can read. */
  summary: string;
  /** The manager's reasoning, when the analysis ran. */
  reasoning: string | null;
  positions: { symbol: string; targetBps: number }[];
  signatures: string[];
  /** What the pre IPO rules saw and did this cycle, one line each. */
  preIpo?: string[];
  /** The mandate against SPY, as of the end of this cycle. */
  score?: Score;
}

/** Enough history to answer "what has it done", not an archive. */
const MAX_DECISIONS = 200;

/**
 * Changes one mandate's entry as a single step. Retries briefly when the other
 * process holds the lock, and gives up with an error rather than write over
 * a change it never saw.
 */
async function mutateEntry(
  mandate: string,
  change: (entry: AutopilotEntry | null) => AutopilotEntry | null,
): Promise<AutopilotEntry | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const done = await withLock(`ap:entry:${mandate}`, async () => {
      const next = change(await hgetJson<AutopilotEntry>("ap:entries", mandate));
      if (next) await hsetJson("ap:entries", mandate, next);
      return { next };
    }, 10);
    if (done) return done.next;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the autopilot entry for ${mandate} is busy; try again`);
}

export async function listEntries(owner?: string): Promise<AutopilotEntry[]> {
  const entries = await hvaluesJson<AutopilotEntry>("ap:entries");
  return owner ? entries.filter((e) => e.owner === owner) : entries;
}

export async function getEntry(mandate: string): Promise<AutopilotEntry | null> {
  return hgetJson<AutopilotEntry>("ap:entries", mandate);
}

export async function upsertEntry(entry: AutopilotEntry): Promise<AutopilotEntry> {
  await mutateEntry(entry.mandate, () => entry);
  return entry;
}

export async function markRun(mandate: string, at: number): Promise<void> {
  await mutateEntry(mandate, (e) => (e ? { ...e, lastRunAt: at } : null));
}

/**
 * Stops a mandate's autopilot because its safety brake tripped.
 *
 * Under the entry's lock like every other change, so a cycle holding an older
 * copy of the entry cannot switch it back on.
 */
export async function brakeEntry(mandate: string, at: number): Promise<void> {
  await mutateEntry(mandate, (e) => (e ? { ...e, enabled: false, brakedAt: at } : null));
}

export async function recordDecision(decision: Decision): Promise<void> {
  await kv().lpush("ap:decisions", JSON.stringify(decision));
  await kv().ltrim("ap:decisions", 0, MAX_DECISIONS - 1);
}

export async function listDecisions(filter: { owner?: string; mandate?: string }, limit = 10): Promise<Decision[]> {
  const all = (await kv().lrange("ap:decisions", 0, MAX_DECISIONS - 1)).map((raw) => JSON.parse(raw) as Decision);
  return all
    .filter((d) => (!filter.owner || d.owner === filter.owner) && (!filter.mandate || d.mandate === filter.mandate))
    .slice(0, limit);
}

/** Entries whose next run is due. */
export async function dueEntries(now: number): Promise<AutopilotEntry[]> {
  return (await listEntries()).filter(
    (e) => e.enabled && (e.lastRunAt === null || now - e.lastRunAt >= e.everyMinutes * 60_000),
  );
}

export async function getScore(mandate: string): Promise<ScoreState | null> {
  return hgetJson<ScoreState>("ap:scores", mandate);
}

/** Only the worker's cycle and the owner resuming write a score, never both at once for one mandate. */
export async function saveScore(mandate: string, score: ScoreState): Promise<void> {
  await hsetJson("ap:scores", mandate, score);
}
