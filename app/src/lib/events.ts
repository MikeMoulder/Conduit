import type { Connection, PublicKey } from "@solana/web3.js";

import { describeProgramError, type ProgramErrorInfo } from "./chain";
import { codecProgram } from "./program-client";

/**
 * The history of a mandate, reconstructed from the chain.
 *
 * There is no database behind this and there should not be. A record of what an
 * agent did is worth exactly as much as its agreement with what actually
 * happened, and the moment a stored copy drifts it becomes a confident account
 * of events that did not occur. Every entry below was read back from the
 * cluster.
 *
 * Read by asking, not by subscribing. `onLogs` would be the obvious way to
 * follow a program and it is websocket only, while the RPC proxy that keeps the
 * endpoint key on the server is HTTP. So history comes from the signature list
 * for the mandate account and the logs of each transaction in it.
 *
 * Refusals appear here too, which is the more interesting half. A feed of
 * accepted rebalances shows an agent behaving; a feed that also shows the
 * refusals shows a mandate working. They only appear when the transaction
 * actually reached the chain: one stopped at preflight never existed as far as
 * the ledger is concerned, so it leaves nothing to find.
 */

export interface RebalanceEvent {
  mandate: string;
  portfolio: string;
  agent: string;
  turnoverBps: number;
  cashBps: number;
  positionCount: number;
  /** The mandate's own count, so gaps in this feed are visible. */
  sequence: number;
  timestamp: number;
}

interface Base {
  signature: string;
  slot: number;
  /** Cluster time in seconds, null on the rare transaction that lacks one. */
  blockTime: number | null;
}

export type ActivityRecord =
  | (Base & { kind: "accepted"; event: RebalanceEvent })
  | (Base & {
      kind: "refused";
      /** Null when the failure was not one of our program errors. */
      error: ProgramErrorInfo | null;
      /** What was attempted, when the instruction could be named. */
      instruction: string | null;
    })
  | (Base & { kind: "instruction"; instruction: string })
  | (Base & { kind: "unknown" });

const PROGRAM_DATA = "Program data: ";

/**
 * Anchor writes an event as a base64 blob on a `Program data:` log line.
 *
 * A transaction can carry several. Only ours decode, and the coder returns null
 * for anything else, which is the filter.
 */
function decodeEvents(logs: string[]): RebalanceEvent[] {
  const events: RebalanceEvent[] = [];

  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA)) continue;

    let decoded;
    try {
      decoded = codecProgram.coder.events.decode(line.slice(PROGRAM_DATA.length));
    } catch {
      continue;
    }
    if (!decoded) continue;
    if (decoded.name.toLowerCase() !== "rebalanceexecuted") continue;

    const data = decoded.data as {
      mandate: PublicKey;
      portfolio: PublicKey;
      agent: PublicKey;
      turnoverBps: number;
      cashBps: number;
      positionCount: number;
      sequence: { toNumber(): number };
      timestamp: { toNumber(): number };
    };

    events.push({
      mandate: data.mandate.toBase58(),
      portfolio: data.portfolio.toBase58(),
      agent: data.agent.toBase58(),
      turnoverBps: data.turnoverBps,
      cashBps: data.cashBps,
      positionCount: data.positionCount,
      sequence: data.sequence.toNumber(),
      timestamp: data.timestamp.toNumber(),
    });
  }

  return events;
}

/** Turns `initializeMandate` into something a person would read. */
const INSTRUCTION_LABELS: Record<string, string> = {
  initializeMandate: "Mandate created",
  initializePortfolio: "Portfolio opened",
  proposeRebalance: "Rebalance proposed",
  setMandateStatus: "Mandate status changed",
};

function nameInstruction(logs: string[]): string | null {
  // The instruction name is not in the logs, but Anchor prints the entrypoint
  // it dispatched to, which is the same thing in a readable form.
  for (const line of logs) {
    const match = /Program log: Instruction: (\w+)/.exec(line);
    if (match) {
      const raw = match[1];
      const key = raw.charAt(0).toLowerCase() + raw.slice(1);
      return INSTRUCTION_LABELS[key] ?? raw;
    }
  }
  return null;
}

function errorFromLogs(logs: string[]): ProgramErrorInfo | null {
  for (const line of logs) {
    const match = /custom program error: 0x([0-9a-fA-F]+)/.exec(line);
    if (match) {
      const info = describeProgramError(parseInt(match[1], 16));
      if (info) return info;
    }
  }
  return null;
}

export interface ActivityOptions {
  /**
   * How far back to look. Each signature costs a `getTransaction`, so this is
   * a request count as much as a page size.
   */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Everything that has happened to this mandate, newest first.
 *
 * The signature list is authoritative about what touched the account. The logs
 * say what each of those was. Transactions that are not ours, or that carry
 * nothing we can name, are kept rather than dropped: a gap in a history is
 * worse than an entry saying something happened that we cannot describe.
 */
export async function fetchActivity(
  connection: Connection,
  mandate: PublicKey,
  options: ActivityOptions = {},
): Promise<ActivityRecord[]> {
  const limit = options.limit ?? 12;

  // Commitment is stated rather than inherited. `getSignaturesForAddress`
  // refuses anything below `confirmed`, and a connection built elsewhere with
  // the default `processed` would make this throw for reasons that have nothing
  // to do with the mandate being read.
  const signatures = await connection.getSignaturesForAddress(
    mandate,
    { limit },
    "confirmed",
  );

  const records = await Promise.all(
    signatures.map(async (entry): Promise<ActivityRecord> => {
      const base: Base = {
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime ?? null,
      };

      let logs: string[] = [];
      try {
        const transaction = await connection.getTransaction(entry.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        logs = transaction?.meta?.logMessages ?? [];
      } catch {
        // A transaction the node has pruned still belongs in the history. What
        // it was is simply not recoverable from here.
        return { ...base, kind: "unknown" };
      }

      if (entry.err) {
        return {
          ...base,
          kind: "refused",
          error: errorFromLogs(logs),
          instruction: nameInstruction(logs),
        };
      }

      const [event] = decodeEvents(logs);
      if (event) return { ...base, kind: "accepted", event };

      const instruction = nameInstruction(logs);
      if (instruction) return { ...base, kind: "instruction", instruction };

      return { ...base, kind: "unknown" };
    }),
  );

  return records;
}
