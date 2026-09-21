import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { getAssetBySymbol } from "./assets";
import idl from "./idl/stockpilot.json";

/**
 * Addresses, encodings and error names for the STOCKPILOT program.
 *
 * Deliberately not server only. The browser needs to derive the same addresses
 * the server does in order to build a transaction the owner can sign, and a
 * derivation that lived on one side would have to be trusted by the other.
 * Nothing secret is involved: these are public addresses and a published IDL.
 */

export const PROGRAM_ID = new PublicKey(idl.address);

/** Must match `constants.rs` in the program. */
export const BPS_DENOMINATOR = 10_000;
export const MAX_ASSETS = 8;

const MANDATE_SEED = Buffer.from("mandate");
const PORTFOLIO_SEED = Buffer.from("portfolio");

/**
 * Derives a mandate address.
 *
 * `mandateId` lets one owner run several mandates at once, for example a
 * conservative one and an aggressive one. It is a seed, and it is also stored on
 * the account so a client holding the account can re-derive its own address.
 */
export function mandatePda(owner: PublicKey, mandateId: BN | number): PublicKey {
  const id = BN.isBN(mandateId) ? mandateId : new BN(mandateId);
  return PublicKey.findProgramAddressSync(
    [MANDATE_SEED, owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];
}

export function portfolioPda(mandate: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PORTFOLIO_SEED, mandate.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/**
 * Program error codes, read from the IDL rather than restated here.
 *
 * Restating them would create a second source of truth that drifts silently the
 * first time the program gains an error. The IDL ships with the build, so this
 * map is correct by construction.
 */
const errorsByCode = new Map(
  (idl.errors as { code: number; name: string; msg: string }[]).map((e) => [
    e.code,
    e,
  ]),
);

export interface ProgramErrorInfo {
  code: number;
  name: string;
  message: string;
}

export function describeProgramError(code: number): ProgramErrorInfo | null {
  const found = errorsByCode.get(code);
  return found ? { code, name: found.name, message: found.msg } : null;
}

/**
 * Pulls the program error out of whatever the wallet or RPC threw.
 *
 * Anchor surfaces a structured error when it can, but a transaction refused at
 * simulation often arrives as logs instead. Both are checked, because the
 * interface needs to name the specific clause that was breached rather than say
 * the transaction failed.
 */
export function extractProgramError(error: unknown): ProgramErrorInfo | null {
  const anchorCode = (
    error as { error?: { errorCode?: { number?: number } } } | undefined
  )?.error?.errorCode?.number;

  if (typeof anchorCode === "number") {
    return describeProgramError(anchorCode);
  }

  const logs = (error as { logs?: string[] } | undefined)?.logs;
  if (Array.isArray(logs)) {
    for (const line of logs) {
      const match = /custom program error: 0x([0-9a-fA-F]+)/.exec(line);
      if (match) {
        const info = describeProgramError(parseInt(match[1], 16));
        if (info) return info;
      }
    }
  }

  return null;
}

export interface OnChainPosition {
  mint: PublicKey;
  targetBps: number;
}

export interface AllocationMappingError {
  symbol: string;
  reason: string;
}

export interface AllocationMapping {
  positions: OnChainPosition[];
  errors: AllocationMappingError[];
}

/**
 * Converts an agent proposal into instruction arguments.
 *
 * The agent works in symbols because that is what it can reason about. The
 * program works in mint addresses because that is what actually moves. This is
 * the only place the two meet, and a symbol with no registry entry is reported
 * rather than skipped: quietly dropping a position would change the allocation
 * into something the agent never proposed and the user never saw.
 */
export function mapProposalToChain(
  positions: { symbol: string; targetBps: number }[],
): AllocationMapping {
  const mapped: OnChainPosition[] = [];
  const errors: AllocationMappingError[] = [];

  for (const position of positions) {
    const asset = getAssetBySymbol(position.symbol);

    if (!asset) {
      errors.push({
        symbol: position.symbol,
        reason: "no registry entry, so there is no mint to hold",
      });
      continue;
    }

    if (!Number.isInteger(position.targetBps)) {
      errors.push({
        symbol: position.symbol,
        reason: `weight ${position.targetBps} is not a whole number of basis points`,
      });
      continue;
    }

    mapped.push({
      mint: new PublicKey(asset.mint),
      targetBps: position.targetBps,
    });
  }

  return { positions: mapped, errors };
}

/** Human readable percentage from basis points, for display only. */
export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/** Explorer link for a signature or address on the configured cluster. */
export function explorerUrl(
  value: string,
  kind: "tx" | "address" = "tx",
  cluster = "devnet",
): string {
  return `https://explorer.solana.com/${kind}/${value}?cluster=${cluster}`;
}
