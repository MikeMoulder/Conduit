/**
 * Copies records from the old per feature JSON files into the shared store.
 *
 * Before the store existed, Telegram links, the autopilot's entries, log and
 * scores, and price triggers each lived in a file under app/.data. Moving to
 * the store would otherwise lose them: a person linked to Telegram would have
 * to link again, and the autopilot would forget its scores.
 *
 * Safe to run more than once. Links, entries, scores and triggers are keyed,
 * so a second run writes the same values again; the decision log is only
 * copied into an empty log, so it is never doubled.
 *
 * Usage, from app/, against whichever store the environment selects:
 *
 *   node --env-file=.env --import tsx --conditions=react-server scripts/migrate-to-store.ts
 */

import { readFileSync } from "fs";
import path from "path";

import { hsetJson, kv } from "../src/lib/kv";

const DATA = path.join(process.cwd(), ".data");

function load<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(path.join(DATA, name), "utf8")) as T;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const store = kv();
  console.log(`store: ${store.backend}`);

  const telegram = load<{
    links?: { owner: string; chatId: number; username: string | null; linkedAt: number }[];
    offset?: number;
  }>("telegram.json");
  for (const link of telegram?.links ?? []) {
    await hsetJson("tg:links", link.owner, link);
    await store.hset("tg:chats", String(link.chatId), link.owner);
  }
  if (telegram?.offset && Number((await store.get("tg:offset")) ?? 0) < telegram.offset) {
    await store.set("tg:offset", String(telegram.offset));
  }
  console.log(`telegram links: ${telegram?.links?.length ?? 0}`);

  const autopilot = load<{
    entries?: { mandate: string }[];
    decisions?: unknown[];
    scores?: Record<string, unknown>;
  }>("autopilot.json");
  for (const entry of autopilot?.entries ?? []) await hsetJson("ap:entries", entry.mandate, entry);
  for (const [mandate, score] of Object.entries(autopilot?.scores ?? {})) await hsetJson("ap:scores", mandate, score);
  const logEmpty = (await store.lrange("ap:decisions", 0, 0)).length === 0;
  const decisions = autopilot?.decisions ?? [];
  if (logEmpty) {
    // Stored newest first; pushing oldest first keeps that order.
    for (const d of [...decisions].reverse()) await store.lpush("ap:decisions", JSON.stringify(d));
  }
  console.log(
    `autopilot entries: ${autopilot?.entries?.length ?? 0}, scores: ${Object.keys(autopilot?.scores ?? {}).length}, decisions: ${logEmpty ? decisions.length : "skipped, the log already has entries"}`,
  );

  const triggers = load<{ triggers?: { id: string }[] }>("triggers.json");
  for (const t of triggers?.triggers ?? []) await hsetJson("tr:all", t.id, t);
  console.log(`triggers: ${triggers?.triggers?.length ?? 0}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
