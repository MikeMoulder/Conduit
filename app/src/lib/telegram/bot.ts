import "server-only";

import { getOffset, redeemCode, setOffset, unlinkChat } from "./state";

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

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T | null> {
  const token = botToken();
  if (!token) return null;
  try {
    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json()) as { ok: boolean; result?: T };
    return data.ok ? (data.result ?? null) : null;
  } catch {
    return null;
  }
}

export async function sendMessage(chatId: number, text: string): Promise<boolean> {
  const sent = await call("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
  return sent !== null;
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
export function handleText(
  text: string,
  chatId: number,
  from: string | null,
): string | null {
  const [command, argument] = text.trim().split(/\s+/, 2);

  if (command === "/start") {
    if (!argument) {
      return "Open this bot from Conduit's chat, by asking it to connect Telegram. That link carries a one time code that ties this chat to your wallet.";
    }
    const owner = redeemCode(argument, chatId, from);
    return owner
      ? `Linked to wallet ${shortAddress(owner)}. Your autopilot's decisions will arrive here, and only here. Send /stop to unlink.`
      : "That link has expired or was already used. Ask Conduit to connect Telegram again for a fresh one.";
  }

  if (command === "/stop") {
    const owner = unlinkChat(chatId);
    return owner
      ? `Unlinked from wallet ${shortAddress(owner)}. No more updates will be sent here.`
      : "This chat is not linked to any wallet.";
  }

  return null;
}

/**
 * Reads updates in a loop, once per process.
 *
 * Guarded on the global object for the same reason as the autopilot timer:
 * in development a module can be evaluated more than once, and two pollers
 * for one bot would have Telegram reject one of them with a conflict.
 */
export function startTelegramPoller(): void {
  if (!botToken()) return;
  const holder = globalThis as unknown as { __conduitTelegram?: boolean };
  if (holder.__conduitTelegram) return;
  holder.__conduitTelegram = true;

  void (async () => {
    for (;;) {
      const offset = getOffset();
      // Long poll: Telegram holds the request up to 25 seconds waiting for a
      // message, so this loop is quiet rather than busy.
      const updates = await call<Update[]>(
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["message"] },
        35_000,
      );

      if (!updates) {
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }

      for (const update of updates) {
        const message = update.message;
        if (message?.text) {
          const reply = handleText(message.text, message.chat.id, message.from?.username ?? null);
          if (reply) await sendMessage(message.chat.id, reply);
        }
        setOffset(update.update_id + 1);
      }
    }
  })();
}
