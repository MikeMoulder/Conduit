import "server-only";

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { getAgentKeypair } from "./agent-identity";
import { extractProgramError } from "./chain";
import { confirmSignature } from "./confirm";
import { getFaucetKeypair } from "./faucet";
import { desk, settleableAsset, type DeskAsset } from "./holdings";

/**
 * What every agent signed wallet action shares.
 *
 * Two keys sign each of these transactions and they do different jobs. The
 * agent authorises: the program checks it is the agent the owner named. The
 * faucet pays: fees, and rent for any token account the action needs opened.
 * Keeping them apart means the agent key holds no SOL worth stealing and never
 * needs topping up, and the owner never signs for account housekeeping.
 */

export interface Signers {
  agent: Keypair;
  payer: Keypair;
}

export function signers(): Signers | { error: string } {
  const agent = getAgentKeypair();
  const payer = getFaucetKeypair();
  if (!agent) return { error: "AGENT_SECRET_KEY is not set on the server." };
  if (!payer) return { error: "FAUCET_SECRET_KEY is not set on the server." };
  return { agent, payer };
}

/** Whole dollars to base units of the settlement currency, rounded down. */
export function cashUnits(dollars: number): bigint {
  return BigInt(Math.floor(dollars * 10 ** desk.cashDecimals));
}

/** Whole tokens to base units of an asset, rounded down. */
export function assetUnits(tokens: number, decimals: number): bigint {
  return BigInt(Math.floor(tokens * 10 ** decimals));
}

export function assetBySymbol(symbol: string): DeskAsset | undefined {
  const upper = symbol.toUpperCase();
  return desk.settleable.find((a) => a.symbol.toUpperCase() === upper);
}

export { settleableAsset };

export type Sent =
  | { ok: true; signature: string; slot: number }
  | {
      ok: false;
      stage: "send" | "confirm";
      signature: string | null;
      programError: { code: number; name: string; message: string } | null;
      detail: string;
    };

/**
 * Sends one transaction signed by the agent and paid by the faucet, and waits
 * for it. Preflight stays on: a failed wallet action is just a failure, and
 * simulation turns it into a named program error before anything is paid for.
 */
export async function sendAsAgent(
  connection: Connection,
  instructions: TransactionInstruction[],
  { agent, payer }: Signers,
): Promise<Sent> {
  let signature: string;
  let lastValidBlockHeight: number;

  try {
    const latest = await connection.getLatestBlockhash("confirmed");
    lastValidBlockHeight = latest.lastValidBlockHeight;

    const transaction = new Transaction({
      feePayer: payer.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight,
    }).add(...instructions);

    transaction.sign(payer, agent);
    signature = await connection.sendRawTransaction(transaction.serialize());
  } catch (error) {
    const programError = extractProgramError(error);
    return {
      ok: false,
      stage: "send",
      signature: null,
      programError,
      detail:
        programError?.message ??
        (error instanceof Error ? error.message.split("\n")[0] : String(error)),
    };
  }

  const outcome = await confirmSignature(connection, signature, {
    lastValidBlockHeight,
    timeoutMs: 90_000,
  });

  if (outcome.status !== "confirmed") {
    return {
      ok: false,
      stage: "confirm",
      signature,
      programError:
        outcome.status === "failed" ? extractProgramError(outcome.error) : null,
      detail:
        outcome.status === "failed"
          ? "The transaction landed and failed."
          : "No confirmation within the wait. It may still land.",
    };
  }

  return { ok: true, signature, slot: outcome.slot };
}

/** A request body field that must be a base58 address. */
export function parseAddress(value: unknown): PublicKey | null {
  if (typeof value !== "string") return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}
