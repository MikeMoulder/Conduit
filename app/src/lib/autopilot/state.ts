import "server-only";

import { readFileSync } from "fs";
import path from "path";

import { writeJsonAtomic } from "../atomic-write";

/**
 * What the autopilot remembers: which mandates it runs, and what it decided.
 *
 * A file on the server rather than an account on chain, on purpose. Nothing
 * here is authority. Whether the agent may act on a mandate was settled when
 * the owner signed it, and the program re-checks every transaction the
 * autopilot sends. This only records that the owner asked for the agent to act
 * on a schedule, and keeps a readable log of what it did, so the copilot can
 * answer "what has it been doing" without replaying the chain.
 *
 * Written whole and renamed into place, so a crash mid write leaves the last
 * good file rather than half of one.
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
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
}

export type DecisionOutcome = "rebalanced" | "held" | "skipped" | "failed";

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
}

interface Stored {
  entries: AutopilotEntry[];
  decisions: Decision[];
}

/** Enough history to answer "what has it done", not an archive. */
const MAX_DECISIONS = 200;

/** Resolved on each use so tests can point it at a temporary file. */
const stateFile = () =>
  process.env.AUTOPILOT_STATE_FILE ?? path.join(process.cwd(), ".data", "autopilot.json");

function read(): Stored {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as Stored;
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    };
  } catch {
    return { entries: [], decisions: [] };
  }
}

function write(stored: Stored): void {
  writeJsonAtomic(stateFile(), stored);
}

export function listEntries(owner?: string): AutopilotEntry[] {
  const { entries } = read();
  return owner ? entries.filter((e) => e.owner === owner) : entries;
}

export function getEntry(mandate: string): AutopilotEntry | null {
  return read().entries.find((e) => e.mandate === mandate) ?? null;
}

export function upsertEntry(entry: AutopilotEntry): AutopilotEntry {
  const stored = read();
  const others = stored.entries.filter((e) => e.mandate !== entry.mandate);
  write({ ...stored, entries: [...others, entry] });
  return entry;
}

export function markRun(mandate: string, at: number): void {
  const stored = read();
  write({
    ...stored,
    entries: stored.entries.map((e) => (e.mandate === mandate ? { ...e, lastRunAt: at } : e)),
  });
}

export function recordDecision(decision: Decision): void {
  const stored = read();
  write({
    ...stored,
    decisions: [decision, ...stored.decisions].slice(0, MAX_DECISIONS),
  });
}

export function listDecisions(filter: { owner?: string; mandate?: string }, limit = 10): Decision[] {
  return read()
    .decisions.filter(
      (d) =>
        (!filter.owner || d.owner === filter.owner) &&
        (!filter.mandate || d.mandate === filter.mandate),
    )
    .slice(0, limit);
}

/** Entries whose next run is due. */
export function dueEntries(now: number): AutopilotEntry[] {
  return read().entries.filter(
    (e) => e.enabled && (e.lastRunAt === null || now - e.lastRunAt >= e.everyMinutes * 60_000),
  );
}
