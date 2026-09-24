import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Proof that the person at the keyboard holds a wallet.
 *
 * Everything else in this app takes the connected wallet's address on trust,
 * because everything else is either public data or an action the program
 * itself restricts. Linking a Telegram chat is different: it decides where one
 * person's autopilot decisions are sent. Without proof, anyone could claim any
 * address and have a stranger's decisions delivered to their own phone.
 *
 * So the wallet signs a short message. It is not a transaction: nothing moves,
 * it costs nothing, and the wallet shows it as plain text. The message names
 * the wallet, what it authorises and when it was signed, so a signature taken
 * from one purpose cannot be replayed for another, and an old one expires.
 *
 * Shared by the browser, which builds the message, and the server, which
 * checks it, so the two cannot disagree about its wording.
 */

/** How long a signed message stays usable. */
export const PROOF_MAX_AGE_MS = 5 * 60_000;

export type ProofPurpose = "link-telegram" | "unlink-telegram";

const PURPOSE_TEXT: Record<ProofPurpose, string> = {
  "link-telegram": "Link this wallet to a Telegram chat for autopilot updates.",
  "unlink-telegram": "Stop sending autopilot updates for this wallet to Telegram.",
};

export function buildProofMessage(
  purpose: ProofPurpose,
  owner: string,
  issuedAt: Date = new Date(),
): string {
  return [
    "Conduit",
    PURPOSE_TEXT[purpose],
    `Wallet: ${owner}`,
    `Issued: ${issuedAt.toISOString()}`,
    "This is a signature, not a transaction. Nothing moves.",
  ].join("\n");
}

export type ProofCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks a signed message: right purpose, right wallet, recent, and signed by
 * that wallet's key. Each failure says which, because "invalid signature" alone
 * is useless to someone whose clock is wrong.
 */
export function verifyProof(
  purpose: ProofPurpose,
  owner: string,
  message: string,
  signature: string,
  now: number = Date.now(),
): ProofCheck {
  const lines = message.split("\n");
  if (lines[0] !== "Conduit" || lines[1] !== PURPOSE_TEXT[purpose]) {
    return { ok: false, reason: "The message is not the one this action asks for." };
  }
  if (lines[2] !== `Wallet: ${owner}`) {
    return { ok: false, reason: "The message names a different wallet." };
  }

  const issued = Date.parse((lines[3] ?? "").replace(/^Issued: /, ""));
  if (!Number.isFinite(issued)) return { ok: false, reason: "The message has no valid time." };
  if (now - issued > PROOF_MAX_AGE_MS) {
    return { ok: false, reason: "The signature has expired. Sign again." };
  }
  if (issued - now > 60_000) {
    return { ok: false, reason: "The message is dated in the future. Check the device clock." };
  }

  let key: Uint8Array;
  let sig: Uint8Array;
  try {
    key = new PublicKey(owner).toBytes();
    sig = bs58.decode(signature);
  } catch {
    return { ok: false, reason: "The wallet address or signature is malformed." };
  }

  const valid = (() => {
    try {
      return ed25519.verify(sig, new TextEncoder().encode(message), key);
    } catch {
      return false;
    }
  })();

  return valid ? { ok: true } : { ok: false, reason: "The signature was not made by this wallet." };
}
