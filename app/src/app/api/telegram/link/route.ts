import { z } from "zod";

import { botToken, botUsername } from "@/lib/telegram/bot";
import { CODE_TTL_MS, issueCode, spendProof } from "@/lib/telegram/state";
import { PROOF_MAX_AGE_MS, verifyProof } from "@/lib/wallet-proof";

/**
 * Starts linking a person's Telegram chat to their wallet.
 *
 * Takes a message the wallet signed, checks it, and returns a t.me link that
 * carries a one time code. The link is only half of it: the chat is bound when
 * that code arrives at the bot from the person's own Telegram. The signature is
 * what stops anyone claiming a wallet that is not theirs, and spending it here
 * stops the same signed message from being used twice.
 */

export const dynamic = "force-dynamic";

const schema = z.object({
  owner: z.string().min(32).max(44),
  message: z.string().min(1).max(1000),
  signature: z.string().min(32).max(200),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });

  if (!botToken()) {
    return Response.json(
      {
        error: "Telegram is not set up on this server",
        detail: "The operator needs to add TELEGRAM_BOT_TOKEN, from a bot made with @BotFather.",
      },
      { status: 409 },
    );
  }

  const { owner, message, signature } = parsed.data;
  const proof = verifyProof("link-telegram", owner, message, signature);
  if (!proof.ok) return Response.json({ error: proof.reason }, { status: 403 });

  if (!(await spendProof(signature, Date.now() + PROOF_MAX_AGE_MS))) {
    return Response.json({ error: "That signature was already used. Sign again." }, { status: 409 });
  }

  const username = await botUsername();
  if (!username) {
    return Response.json(
      { error: "Telegram did not answer. The bot token may be wrong, or Telegram is unreachable." },
      { status: 503 },
    );
  }

  const code = await issueCode(owner);
  return Response.json({
    link: `https://t.me/${username}?start=${code}`,
    bot: username,
    expiresInMinutes: CODE_TTL_MS / 60_000,
  });
}
