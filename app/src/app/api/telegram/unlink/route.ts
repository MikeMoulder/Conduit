import { z } from "zod";

import { sendMessage } from "@/lib/telegram/bot";
import { chatFor, spendProof, unlinkOwner } from "@/lib/telegram/state";
import { PROOF_MAX_AGE_MS, verifyProof } from "@/lib/wallet-proof";

/**
 * Stops sending a wallet's autopilot updates to Telegram.
 *
 * Also proven with a signature, so nobody can quietly cut off someone else's
 * updates. Sending /stop to the bot does the same from the Telegram side, where
 * holding the chat is proof enough.
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

  const { owner, message, signature } = parsed.data;
  const proof = verifyProof("unlink-telegram", owner, message, signature);
  if (!proof.ok) return Response.json({ error: proof.reason }, { status: 403 });

  if (!spendProof(signature, Date.now() + PROOF_MAX_AGE_MS)) {
    return Response.json({ error: "That signature was already used. Sign again." }, { status: 409 });
  }

  const chatId = chatFor(owner);
  const unlinked = unlinkOwner(owner);
  if (chatId !== null) {
    await sendMessage(chatId, "Unlinked from Conduit. No more autopilot updates will be sent here.");
  }
  return Response.json({ unlinked });
}
