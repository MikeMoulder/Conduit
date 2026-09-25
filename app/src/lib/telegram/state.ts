import "server-only";

import { randomBytes } from "crypto";

import { hgetJson, hsetJson, kv } from "../kv";

/**
 * Which Telegram chat belongs to which wallet.
 *
 * One bot serves everyone, and each person reaches it from their own chat. The
 * link between a wallet and a chat is made in two halves that have to meet:
 * the wallet proves itself in Conduit and receives a one time code, and the
 * code arrives at the bot from a specific chat when that person presses Start.
 * Only a code that was issued to a proven wallet, used once, before it
 * expires, can bind a chat to that wallet.
 *
 * Kept in the shared store, because the two halves happen in different
 * processes: the code is issued by the site and redeemed by the worker that
 * listens to Telegram. Each piece is its own record:
 *
 *   tg:code:<code>        the wallet a code was issued to, expiring with it
 *   tg:owner-code:<owner> that wallet's current code, so a new one voids it
 *   tg:links              wallet to chat
 *   tg:chats              chat to wallet, so either side can be looked up
 *   tg:proof:<signature>  a signature already spent, expiring with it
 *   tg:offset             how far the listener has read
 *
 * A chat id is not a secret, but the mapping is private: it says which
 * Telegram account holds which wallet.
 */

/** How long a link code can be redeemed. */
export const CODE_TTL_MS = 10 * 60_000;

interface Link {
  owner: string;
  chatId: number;
  username: string | null;
  linkedAt: number;
}

interface PendingCode {
  owner: string;
  expiresAt: number;
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Spends a signature. False when it was already spent, which is what stops a
 * signed message seen once from being used again to link a different chat.
 */
export async function spendProof(signature: string, expiresAt: number): Promise<boolean> {
  return kv().set(`tg:proof:${signature}`, "1", { nx: true, exSeconds: seconds(expiresAt - Date.now()) });
}

/** A fresh one time code for a proven wallet. Earlier codes for it are void. */
export async function issueCode(owner: string, now: number = Date.now()): Promise<string> {
  // URL safe and within Telegram's 64 character start parameter.
  const code = randomBytes(18).toString("base64url");
  const previous = await kv().get(`tg:owner-code:${owner}`);
  if (previous) await kv().del(`tg:code:${previous}`);

  const pending: PendingCode = { owner, expiresAt: now + CODE_TTL_MS };
  await kv().set(`tg:code:${code}`, JSON.stringify(pending), { exSeconds: seconds(CODE_TTL_MS) });
  await kv().set(`tg:owner-code:${owner}`, code, { exSeconds: seconds(CODE_TTL_MS) });
  return code;
}

/**
 * Redeems a code from a chat. Returns the wallet it was issued to, or null when
 * the code is unknown, spent or expired. A chat can hold one wallet, and a
 * wallet one chat: linking replaces whatever either had before.
 *
 * The code is taken with a read-and-delete, so of two chats racing to redeem
 * one code, only one gets it.
 */
export async function redeemCode(
  code: string,
  chatId: number,
  username: string | null,
  now: number = Date.now(),
): Promise<string | null> {
  const raw = await kv().getdel(`tg:code:${code}`);
  if (!raw) return null;
  const pending = JSON.parse(raw) as PendingCode;
  if (pending.expiresAt <= now) return null;
  await kv().del(`tg:owner-code:${pending.owner}`);

  const oldLink = await hgetJson<Link>("tg:links", pending.owner);
  if (oldLink) await kv().hdel("tg:chats", String(oldLink.chatId));
  const oldOwner = await kv().hget("tg:chats", String(chatId));
  if (oldOwner) await kv().hdel("tg:links", oldOwner);

  const link: Link = { owner: pending.owner, chatId, username, linkedAt: now };
  await hsetJson("tg:links", pending.owner, link);
  await kv().hset("tg:chats", String(chatId), pending.owner);
  return pending.owner;
}

export async function chatFor(owner: string): Promise<number | null> {
  return (await hgetJson<Link>("tg:links", owner))?.chatId ?? null;
}

/** The wallet a chat is linked to, or null. */
export async function ownerForChat(chatId: number): Promise<string | null> {
  return kv().hget("tg:chats", String(chatId));
}

export async function unlinkOwner(owner: string): Promise<boolean> {
  const link = await hgetJson<Link>("tg:links", owner);
  if (!link) return false;
  await kv().hdel("tg:links", owner);
  await kv().hdel("tg:chats", String(link.chatId));
  return true;
}

export async function unlinkChat(chatId: number): Promise<string | null> {
  const owner = await ownerForChat(chatId);
  if (!owner) return null;
  await kv().hdel("tg:chats", String(chatId));
  await kv().hdel("tg:links", owner);
  return owner;
}

export async function getOffset(): Promise<number> {
  return Number((await kv().get("tg:offset")) ?? 0);
}

export async function setOffset(offset: number): Promise<void> {
  await kv().set("tg:offset", String(offset));
}
