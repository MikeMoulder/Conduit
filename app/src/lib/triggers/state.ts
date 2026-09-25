import "server-only";

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";

import { writeJsonAtomic } from "../atomic-write";
import type { Trigger, TriggerStatus } from "./rules";

/**
 * Where price triggers are kept.
 *
 * A file on the server, like the autopilot's state, and for the same reason:
 * nothing here is authority. A trigger that fires places a main wallet trade
 * the owner could have placed from the chat, checked by the program like any
 * other, so the file only remembers what the owner asked to be watched.
 */

const file = () => process.env.TRIGGER_STATE_FILE ?? path.join(process.cwd(), ".data", "triggers.json");

/** Finished triggers kept for the record, not an archive. */
const MAX_FINISHED = 200;

function read(): Trigger[] {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as { triggers?: Trigger[] };
    return Array.isArray(parsed.triggers) ? parsed.triggers : [];
  } catch {
    return [];
  }
}

function write(triggers: Trigger[]): void {
  const live = triggers.filter((t) => t.status === "active" || t.status === "firing");
  const done = triggers.filter((t) => t.status !== "active" && t.status !== "firing").slice(0, MAX_FINISHED);
  writeJsonAtomic(file(), { triggers: [...live, ...done] });
}

export function addTrigger(trigger: Omit<Trigger, "id" | "status">): Trigger {
  const created: Trigger = { ...trigger, id: randomUUID().slice(0, 8), status: "active" };
  write([created, ...read()]);
  return created;
}

/** Newest first. */
export function listTriggers(owner: string): Trigger[] {
  return read()
    .filter((t) => t.owner === owner)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function activeTriggers(): Trigger[] {
  return read().filter((t) => t.status === "active");
}

/**
 * Moves a trigger from one status to another, only if it is still in the
 * expected one.
 *
 * The compare is what makes firing once safe: the runner claims a trigger by
 * moving it from active to firing before it trades, and a second pass that
 * finds it already moved leaves it alone.
 */
export function transition(
  id: string,
  from: TriggerStatus,
  to: TriggerStatus,
  patch: Partial<Trigger> = {},
): Trigger | null {
  const all = read();
  const index = all.findIndex((t) => t.id === id);
  if (index === -1 || all[index].status !== from) return null;
  all[index] = { ...all[index], ...patch, status: to };
  write(all);
  return all[index];
}

/** Cancels one of the owner's active triggers. Null if there is no such trigger. */
export function cancelTrigger(owner: string, id: string): Trigger | null {
  const found = read().find((t) => t.id === id && t.owner === owner);
  if (!found) return null;
  return transition(id, "active", "cancelled");
}
