import { BN, type Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";

import { mandatePda, portfolioPda } from "./chain";
import type { Stockpilot } from "./idl/stockpilot";
import { toAllowedAssets } from "./mandate";

/**
 * The instructions only the owner can sign.
 *
 * Shared between the authoring form and the copilot, because both now build the
 * same transactions and two copies of an account list is exactly the kind of
 * thing that drifts once and then fails in front of an audience.
 *
 * Nothing here signs or sends. It returns instructions, and the caller decides
 * how they reach a wallet.
 */

export interface MandateDraftInput {
  mandateId: number;
  maxPositionBps: number;
  minCashBps: number;
  maxTurnoverBps: number;
  maxAssets: number;
  symbols: string[];
  agent: string;
}

/**
 * Creating a mandate and opening its portfolio, as one pair.
 *
 * Returned together on purpose. A mandate without a portfolio is a constitution
 * with nothing to govern, and splitting them across two signatures means a
 * refused second prompt strands the first.
 */
export async function createMandateInstructions(
  program: Program<Stockpilot>,
  owner: PublicKey,
  draft: MandateDraftInput,
): Promise<{
  mandate: PublicKey;
  portfolio: PublicKey;
  instructions: TransactionInstruction[];
}> {
  const mandate = mandatePda(owner, draft.mandateId);
  const portfolio = portfolioPda(mandate);

  const create = await program.methods
    .initializeMandate(
      new BN(draft.mandateId),
      {
        maxPositionBps: draft.maxPositionBps,
        minCashBps: draft.minCashBps,
        maxTurnoverBps: draft.maxTurnoverBps,
        maxAssets: draft.maxAssets,
      },
      toAllowedAssets(draft.symbols),
      new PublicKey(draft.agent.trim()),
    )
    .accountsStrict({
      mandate,
      owner,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const open = await program.methods
    .initializePortfolio()
    .accountsStrict({
      mandate,
      portfolio,
      owner,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { mandate, portfolio, instructions: [create, open] };
}

export type StatusName = "active" | "paused" | "closed";

/**
 * Anchor takes a unit enum as an object with one key, so the variant is built
 * rather than passed as a string.
 */
function statusArg(status: StatusName) {
  return status === "paused"
    ? { paused: {} }
    : status === "closed"
      ? { closed: {} }
      : { active: {} };
}

export async function setStatusInstruction(
  program: Program<Stockpilot>,
  owner: PublicKey,
  mandate: PublicKey,
  status: StatusName,
): Promise<TransactionInstruction> {
  return program.methods
    .setMandateStatus(statusArg(status) as never)
    .accountsStrict({ mandate, owner })
    .instruction();
}
