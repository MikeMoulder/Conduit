import "server-only";

import { chatFor, getOffset, ownerForChat, redeemCode, setOffset, unlinkChat, unlinkOwner } from "./state";

/**
 * The Telegram bot: one for the whole deployment, a separate chat per person.
 *
 * Only the bot token is configuration. Which chat to write to comes from the
 * link a person makes themselves (see state.ts), never from a setting.
 *
 * Updates are read by long polling rather than a webhook. A webhook needs a
 * public HTTPS address, which a demo on localhost does not have; polling works
 * from anywhere the server can reach Telegram. One process polls, because
 * Telegram refuses a second concurrent poller for the same bot.
 */

const API = "https://api.telegram.org";

export function botToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token && token.trim().length > 0 ? token.trim() : null;
}

interface Answer<T> {
  ok: boolean;
  result?: T;
  /** Telegram's error code: 429 rate limited, 403 blocked by the user. */
  errorCode?: number;
  /** Seconds Telegram asks us to wait, when it rate limits. */
  retryAfter?: number;
}

async function request<T>(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<Answer<T>> {
  const token = botToken();
  if (!token) return { ok: false };
  try {
    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json()) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    return {
      ok: data.ok,
      result: data.result,
      errorCode: data.error_code,
      retryAfter: data.parameters?.retry_after,
    };
  } catch {
    // Unreachable, timed out, or not JSON. No error code: worth one retry.
    return { ok: false };
  }
}

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T | null> {
  const answer = await request<T>(method, body, timeoutMs);
  return answer.ok ? (answer.result ?? null) : null;
}

/** The longest a send will wait to retry, however long Telegram asks for. */
const MAX_RETRY_WAIT_S = 30;

export type SendOutcome = "sent" | "blocked" | "failed";

/**
 * Sends one message, retrying once when that could help.
 *
 * A rate limit is retried after the wait Telegram names, and a dropped
 * connection after two seconds. A person who blocked the bot is reported as
 * blocked, since every further send to them would be refused the same way.
 * Before this, any failure lost the message with no second attempt, which for
 * a price alert means the person never hears that it fired.
 */
export async function deliver(chatId: number, text: string): Promise<SendOutcome> {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await request("sendMessage", body, 15_000);
    if (answer.ok) return "sent";
    if (answer.errorCode === 403) return "blocked";
    const retryable = answer.errorCode === undefined || answer.errorCode === 429 || answer.errorCode >= 500;
    if (!retryable || attempt === 1) break;
    const waitS = answer.errorCode === 429 ? Math.min(answer.retryAfter ?? 1, MAX_RETRY_WAIT_S) : 2;
    await new Promise((r) => setTimeout(r, waitS * 1000));
  }
  return "failed";
}

export async function sendMessage(chatId: number, text: string): Promise<boolean> {
  return (await deliver(chatId, text)) === "sent";
}

/**
 * Sends to the chat a wallet linked, and unlinks it if the person has
 * blocked the bot. Used for everything Conduit tells an owner on its own.
 */
export async function sendToOwner(owner: string, text: string): Promise<SendOutcome | "not-linked"> {
  if (!botToken()) return "not-linked";
  const chatId = await chatFor(owner);
  if (chatId === null) return "not-linked";
  const outcome = await deliver(chatId, text);
  if (outcome === "blocked") await unlinkOwner(owner);
  return outcome;
}

let username: string | null = null;

/** The bot's @username, needed to build the t.me link. Asked once, then kept. */
export async function botUsername(): Promise<string | null> {
  if (username) return username;
  const me = await call<{ username?: string }>("getMe", {});
  username = me?.username ?? null;
  return username;
}

function shortAddress(owner: string): string {
  return `${owner.slice(0, 4)}..${owner.slice(-4)}`;
}

interface Update {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
    from?: { username?: string };
  };
}

/** What the bot says back. Exported so it can be tested without Telegram. */
export async function handleText(
  text: string,
  chatId: number,
  from: string | null,
): Promise<string> {
  const [command, argument] = text.trim().split(/\s+/, 2);

  if (command === "/start") {
    if (!argument) {
      return "Open this bot from Conduit's chat, by asking it to connect Telegram. That link carries a one time code that ties this chat to your wallet.";
    }
    const owner = await redeemCode(argument, chatId, from);
    return owner
      ? `Linked to wallet ${shortAddress(owner)}. Your autopilot's decisions will arrive here, and only here. Send /stop to unlink.`
      : "That link has expired or was already used. Ask Conduit to connect Telegram again for a fresh one.";
  }

  if (command === "/stop") {
    const owner = await unlinkChat(chatId);
    return owner
      ? `Unlinked from wallet ${shortAddress(owner)}. No more updates will be sent here.`
      : "This chat is not linked to any wallet.";
  }

  // Anything else, including /help, gets told what this chat is for. Silence
  // read as a broken bot: someone typing "hi" to it heard nothing back.
  const owner = await ownerForChat(chatId);
  return owner
    ? `This chat is linked to wallet ${shortAddress(owner)}. I send your Conduit price alerts and autopilot decisions here. To trade, set alerts or ask anything, use Conduit's chat. Send /stop to unlink.`
    : "I send Conduit price alerts and autopilot decisions. To link this chat, ask Conduit's chat to connect Telegram, then press the link it gives you.";
}

/**
 * One long poll: read what arrived, answer it, and move the offset past it.
 *
 * Returns false when Telegram could not be reached, so the loop can wait
 * before asking again. Throws whatever handling a message throws; the loop
 * catches it. Exported so a single pass can be tested.
 */
export async function pollOnce(timeoutSeconds = 25): Promise<boolean> {
  const offset = await getOffset();
  // Telegram holds the request up to the timeout waiting for a message, so
  // the loop is quiet rather than busy.
  const updates = await call<Update[]>(
    "getUpdates",
    { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
    (timeoutSeconds + 10) * 1000,
  );
  if (!updates) return false;

  for (const update of updates) {
    // The offset moves first. A message whose handling throws is skipped
    // rather than read again on every pass for ever.
    await setOffset(update.update_id + 1);
    const message = update.message;
    if (message?.text) {
      const reply = await handleText(message.text, message.chat.id, message.from?.username ?? null);
      if (reply) await sendMessage(message.chat.id, reply);
    }
  }
  return true;
}

const listener = globalThis as unknown as {
  __conduitTelegram?: boolean;
  /** When the listener last heard from Telegram, for the status check. */
  __conduitTelegramLastPoll?: number;
};

/** When the listener last completed a poll, or null if it has not yet. */
export function lastPollAt(): number | null {
  return listener.__conduitTelegramLastPoll ?? null;
}

/**
 * Reads updates in a loop, once per process.
 *
 * Guarded on the global object for the same reason as the autopilot timer:
 * in development a module can be evaluated more than once, and two pollers
 * for one bot would have Telegram reject one of them with a conflict.
 *
 * Nothing stops it. It used to: an error saving the offset escaped the loop,
 * ended it, and left the guard set, so the bot went deaf until the server
 * restarted and nothing said so. Every pass is now caught, and if the loop
 * does exit the guard is cleared, so the next call here starts it again.
 */
export function startTelegramPoller(): void {
  if (!botToken()) return;
  if (listener.__conduitTelegram) return;
  listener.__conduitTelegram = true;

  void (async () => {
    try {
      for (;;) {
        let reached = false;
        try {
          reached = await pollOnce();
          if (reached) listener.__conduitTelegramLastPoll = Date.now();
        } catch {
          reached = false;
        }
        if (!reached) await new Promise((r) => setTimeout(r, 5_000));
      }
    } finally {
      listener.__conduitTelegram = false;
    }
  })();
}
