import "server-only";

import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

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
 * A chat id is not a secret, but the mapping is private: it says which Telegram
 * account holds which wallet. It stays in a gitignored file on the server.
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
  code: string;
  owner: string;
  expiresAt: number;
}

interface Stored {
  links: Link[];
  codes: PendingCode[];
  /** Signatures already spent, kept until they would have expired anyway. */
  usedProofs: { signature: string; expiresAt: number }[];
  /** Telegram's update offset, so a restart does not replay old messages. */
  offset: number;
}

const stateFile = () =>
  process.env.TELEGRAM_STATE_FILE ?? path.join(process.cwd(), ".data", "telegram.json");

function read(): Stored {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<Stored>;
    return {
      links: parsed.links ?? [],
      codes: parsed.codes ?? [],
      usedProofs: parsed.usedProofs ?? [],
      offset: parsed.offset ?? 0,
    };
  } catch {
    return { links: [], codes: [], usedProofs: [], offset: 0 };
  }
}

function write(stored: Stored): void {
  const file = stateFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.now();
  // Expired codes and proofs are dropped on every write, so neither grows.
  const pruned: Stored = {
    ...stored,
    codes: stored.codes.filter((c) => c.expiresAt > now),
    usedProofs: stored.usedProofs.filter((p) => p.expiresAt > now),
  };
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(pruned, null, 2));
  renameSync(temp, file);
}

/**
 * Spends a signature. False when it was already spent, which is what stops a
 * signed message seen once from being used again to link a different chat.
 */
export function spendProof(signature: string, expiresAt: number): boolean {
  const stored = read();
  if (stored.usedProofs.some((p) => p.signature === signature)) return false;
  write({ ...stored, usedProofs: [...stored.usedProofs, { signature, expiresAt }] });
  return true;
}

/** A fresh one time code for a proven wallet. Earlier codes for it are void. */
export function issueCode(owner: string, now: number = Date.now()): string {
  const stored = read();
  // URL safe and within Telegram's 64 character start parameter.
  const code = randomBytes(18).toString("base64url");
  write({
    ...stored,
    codes: [...stored.codes.filter((c) => c.owner !== owner), { code, owner, expiresAt: now + CODE_TTL_MS }],
  });
  return code;
}

/**
 * Redeems a code from a chat. Returns the wallet it was issued to, or null when
 * the code is unknown, spent or expired. A chat can hold one wallet, and a
 * wallet one chat: linking replaces whatever either had before.
 */
export function redeemCode(
  code: string,
  chatId: number,
  username: string | null,
  now: number = Date.now(),
): string | null {
  const stored = read();
  const pending = stored.codes.find((c) => c.code === code && c.expiresAt > now);
  if (!pending) return null;

  write({
    ...stored,
    codes: stored.codes.filter((c) => c.code !== code),
    links: [
      ...stored.links.filter((l) => l.owner !== pending.owner && l.chatId !== chatId),
      { owner: pending.owner, chatId, username, linkedAt: now },
    ],
  });
  return pending.owner;
}

export function chatFor(owner: string): number | null {
  return read().links.find((l) => l.owner === owner)?.chatId ?? null;
}

export function unlinkOwner(owner: string): boolean {
  const stored = read();
  const had = stored.links.some((l) => l.owner === owner);
  if (had) write({ ...stored, links: stored.links.filter((l) => l.owner !== owner) });
  return had;
}

export function unlinkChat(chatId: number): string | null {
  const stored = read();
  const link = stored.links.find((l) => l.chatId === chatId);
  if (link) write({ ...stored, links: stored.links.filter((l) => l.chatId !== chatId) });
  return link?.owner ?? null;
}

export function getOffset(): number {
  return read().offset;
}

export function setOffset(offset: number): void {
  write({ ...read(), offset });
}
