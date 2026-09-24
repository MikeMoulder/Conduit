import "server-only";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * The agent keypair.
 *
 * The agent is a separate actor with a key of its own, not a role the owner
 * plays. That separation is the whole architecture: the owner holds authority
 * over the mandate, the agent holds one instruction, and the difference is
 * enforced by which key signs rather than by which code path runs.
 *
 * Server only. The secret never leaves this process. What the browser is given
 * is the public key, which is what a mandate records anyway and is public the
 * moment the mandate exists.
 */

export type AgentIdentity =
  | { configured: true; publicKey: string }
  | { configured: false; reason: string };

let cached: AgentIdentity | null = null;
let cachedKeypair: Keypair | null = null;

/**
 * Accepts either encoding, because the two tools that produce Solana keys do
 * not agree: the CLI writes a JSON array of bytes, most libraries and every
 * copy and paste path use base58.
 */
export function parseSecret(raw: string): Keypair {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    const bytes = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(bytes) || bytes.some((b) => typeof b !== "number")) {
      throw new Error("JSON array form must contain only numbers");
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  }

  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

/**
 * The agent keypair, or null when none is configured.
 *
 * Absence is a supported state rather than a crash. A mandate can name any
 * address as its agent, including the owner, so the interface stays usable
 * while someone is still deciding what the agent should be.
 */
export function getAgentKeypair(): Keypair | null {
  if (cachedKeypair) return cachedKeypair;

  const raw = process.env.AGENT_SECRET_KEY;
  if (!raw || raw.trim().length === 0) return null;

  cachedKeypair = parseSecret(raw);
  return cachedKeypair;
}

export function getAgentIdentity(): AgentIdentity {
  if (cached) return cached;

  const raw = process.env.AGENT_SECRET_KEY;

  if (!raw || raw.trim().length === 0) {
    cached = {
      configured: false,
      reason:
        "AGENT_SECRET_KEY is not set. Run npm run agent:keypair to create one.",
    };
    return cached;
  }

  try {
    cached = { configured: true, publicKey: parseSecret(raw).publicKey.toBase58() };
  } catch (error) {
    // The message is written by us and never quotes the input, because the
    // input is a private key and a parse error is a tempting place to echo it.
    cached = {
      configured: false,
      reason: `AGENT_SECRET_KEY could not be read as a Solana secret key (${
        error instanceof Error ? error.name : "unknown error"
      }). It must be a base58 string or a JSON array of bytes.`,
    };
  }

  return cached;
}
