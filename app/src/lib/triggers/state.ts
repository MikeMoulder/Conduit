import "server-only";

import { randomUUID } from "crypto";

import { hgetJson, hsetJson, hvaluesJson, kv, withLock } from "../kv";
import type { Trigger, TriggerStatus } from "./rules";

/**
 * Where price triggers are kept.
 *
 * In the shared store, like the autopilot's state, and for the same reason:
 * nothing here is authority. A trigger that fires places a main wallet trade
 * the owner could have placed from the chat, checked by the program like any
 * other, so the store only remembers what the owner asked to be watched.
 *
 * Shared because the site sets and cancels triggers while the worker fires
 * them. One record per trigger in `tr:all`, and every change of status is
 * made under that trigger's lock, so a cancel from the site and a fire from
 * the worker at the same moment cannot both succeed.
 */

/** Finished triggers kept for the record, not an archive. */
const MAX_FINISHED = 200;

const finished = (t: Trigger) => t.status !== "active" && t.status !== "firing";

export async function addTrigger(trigger: Omit<Trigger, "id" | "status">): Promise<Trigger> {
  const created: Trigger = { ...trigger, id: randomUUID().slice(0, 8), status: "active" };
  await hsetJson("tr:all", created.id, created);

  // Old finished triggers are dropped as new ones arrive, so the record stays
  // small without a separate clean up job.
  const all = await hvaluesJson<Trigger>("tr:all");
  const done = all.filter(finished).sort((a, b) => b.createdAt - a.createdAt);
  for (const old of done.slice(MAX_FINISHED)) await kv().hdel("tr:all", old.id);
  return created;
}

/** Newest first. */
export async function listTriggers(owner: string): Promise<Trigger[]> {
  return (await hvaluesJson<Trigger>("tr:all"))
    .filter((t) => t.owner === owner)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function activeTriggers(): Promise<Trigger[]> {
  return (await hvaluesJson<Trigger>("tr:all")).filter((t) => t.status === "active");
}

/**
 * Moves a trigger from one status to another, only if it is still in the
 * expected one.
 *
 * The compare is what makes firing once safe: the runner claims a trigger by
 * moving it from active to firing before it trades, and a second pass, or a
 * cancel from the site, that finds it already moved leaves it alone. Made
 * under the trigger's lock, retried briefly while someone else holds it.
 */
export async function transition(
  id: string,
  from: TriggerStatus,
  to: TriggerStatus,
  patch: Partial<Trigger> = {},
): Promise<Trigger | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const outcome = await withLock(
      `tr:${id}`,
      async () => {
        const current = await hgetJson<Trigger>("tr:all", id);
        if (!current || current.status !== from) return { moved: null };
        const next: Trigger = { ...current, ...patch, status: to };
        await hsetJson("tr:all", id, next);
        return { moved: next };
      },
      10,
    );
    if (outcome) return outcome.moved;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Cancels one of the owner's active triggers. Null if there is no such trigger. */
export async function cancelTrigger(owner: string, id: string): Promise<Trigger | null> {
  const found = await hgetJson<Trigger>("tr:all", id);
  if (!found || found.owner !== owner) return null;
  return transition(id, "active", "cancelled");
}
