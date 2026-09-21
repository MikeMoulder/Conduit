import { PublicKey } from "@solana/web3.js";

import { getAssetBySymbol, type RegisteredAsset } from "./assets";
import { BPS_DENOMINATOR, MAX_ASSETS } from "./chain";

/**
 * The mandate as the owner writes it, and the checks the program will apply.
 *
 * Every rule below mirrors `MandateConstraints::validate` and the opening
 * requires in `initialize_mandate`. The mirror exists so the owner is told what
 * is wrong while they are still typing, rather than paying for a transaction
 * that was always going to be refused.
 *
 * The mirror is not the authority. The program re-derives all of it and is free
 * to disagree, in which case the program wins and the transaction fails. That is
 * the correct direction for this to break: a client that is too permissive
 * produces a refusal, while a client trusted as the last word would produce a
 * mandate nobody checked.
 */

/** No Pyth feed exists for this instrument. See `feedIdBytes`. */
export const NO_FEED_ID = new Uint8Array(32);

export interface MandateConstraintsInput {
  maxPositionBps: number;
  minCashBps: number;
  maxTurnoverBps: number;
  maxAssets: number;
}

export interface MandateDraft extends MandateConstraintsInput {
  /** Plain English. Read by the agent, never stored on chain. */
  objective: string;
  mandateId: number;
  /** Registry symbols the agent is permitted to hold. */
  symbols: string[];
  /** Base58 address of the keypair allowed to propose rebalances. */
  agent: string;
}

export interface Violation {
  /** Which input to point at, or "universe" for the asset selection. */
  field: keyof MandateConstraintsInput | "universe" | "agent";
  message: string;
  /** The error the program would return. Names the clause, not a generic failure. */
  onChainError: string;
}

/**
 * Mirrors `MandateConstraints::validate`.
 *
 * Returns every violation rather than the first, because a half corrected form
 * that fails again on the next field is a worse experience than one that states
 * the whole problem at once. The program returns only the first, since on chain
 * the caller does not need a list of chores.
 */
export function validateConstraints(c: MandateConstraintsInput): Violation[] {
  const violations: Violation[] = [];

  const bpsFields: (keyof MandateConstraintsInput)[] = [
    "maxPositionBps",
    "minCashBps",
    "maxTurnoverBps",
  ];

  for (const field of bpsFields) {
    const value = c[field];
    if (!Number.isInteger(value) || value < 0 || value > BPS_DENOMINATOR) {
      violations.push({
        field,
        message: `Must be a whole number between 0 and ${BPS_DENOMINATOR} basis points.`,
        onChainError: "InvalidBasisPoints",
      });
    }
  }

  if (!Number.isInteger(c.maxAssets) || c.maxAssets < 1 || c.maxAssets > MAX_ASSETS) {
    violations.push({
      field: "maxAssets",
      message: `Must be between 1 and ${MAX_ASSETS} positions.`,
      onChainError: "TooManyAssets",
    });
  }

  if (c.maxPositionBps === 0) {
    violations.push({
      field: "maxPositionBps",
      message:
        "A maximum position of zero permits no position at all, so the agent could never act.",
      onChainError: "ContradictoryConstraints",
    });
  }

  // The coherence check. Only run once the individual fields are sane, because
  // arithmetic on a value already known to be nonsense produces a second
  // complaint about the same mistake.
  if (violations.length === 0) {
    const deployable = c.maxAssets * c.maxPositionBps;
    const reachable = deployable + c.minCashBps;

    if (reachable < BPS_DENOMINATOR) {
      const stranded = BPS_DENOMINATOR - reachable;
      violations.push({
        field: "maxPositionBps",
        message:
          `${c.maxAssets} position${c.maxAssets === 1 ? "" : "s"} of at most ` +
          `${c.maxPositionBps} bps is ${deployable} bps, ` +
          `and ${c.minCashBps} bps of required cash brings the total to ${reachable}. ` +
          `That strands ${stranded} bps which can never be allocated or held as cash. ` +
          `Raise the position limit, allow more positions, or raise the cash floor.`,
        onChainError: "ContradictoryConstraints",
      });
    }
  }

  return violations;
}

/** Mirrors the universe checks at the top of `initialize_mandate`. */
export function validateUniverse(symbols: string[]): Violation[] {
  const violations: Violation[] = [];

  if (symbols.length === 0) {
    violations.push({
      field: "universe",
      message:
        "Select at least one asset. A mandate with no universe permits nothing.",
      onChainError: "EmptyAssetUniverse",
    });
    return violations;
  }

  if (symbols.length > MAX_ASSETS) {
    violations.push({
      field: "universe",
      message: `Select at most ${MAX_ASSETS} assets.`,
      onChainError: "TooManyAssets",
    });
  }

  const mints = new Map<string, string>();
  for (const symbol of symbols) {
    const asset = getAssetBySymbol(symbol);
    if (!asset) {
      violations.push({
        field: "universe",
        message: `${symbol} has no registry entry, so there is no mint to permit.`,
        onChainError: "AssetNotAllowed",
      });
      continue;
    }
    const seen = mints.get(asset.mint);
    if (seen) {
      violations.push({
        field: "universe",
        message: `${symbol} and ${seen} resolve to the same mint.`,
        onChainError: "DuplicateAsset",
      });
    }
    mints.set(asset.mint, symbol);
  }

  return violations;
}

export function validateAgent(agent: string): Violation[] {
  if (agent.trim().length === 0) {
    return [
      {
        field: "agent",
        message: "Name the address allowed to propose rebalances.",
        onChainError: "UnauthorizedAgent",
      },
    ];
  }

  try {
    new PublicKey(agent.trim());
  } catch {
    return [
      {
        field: "agent",
        message: "Not a valid Solana address.",
        onChainError: "UnauthorizedAgent",
      },
    ];
  }

  return [];
}

export function validateDraft(draft: MandateDraft): Violation[] {
  return [
    ...validateConstraints(draft),
    ...validateUniverse(draft.symbols),
    ...validateAgent(draft.agent),
  ];
}

/**
 * The 32 byte feed id the mandate records for an asset.
 *
 * Its purpose is to fix, at creation, which price series values which holding,
 * so valuation cannot later be repointed at a different instrument. An asset
 * Pyth does not publish has no such id, and inventing one would put a number on
 * chain that resolves to nothing. Those record all zeros, which reads
 * unambiguously as no Pyth feed rather than as a feed nobody can find. The price
 * of record for those assets comes from their issuer, named in the registry.
 */
export function feedIdBytes(asset: RegisteredAsset): Uint8Array {
  const hex = asset.feeds?.primary;
  if (!hex) return NO_FEED_ID;

  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length !== 64 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error(
      `${asset.symbol} has a malformed Pyth feed id in the registry, so the mandate cannot bind it to a price.`,
    );
  }

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export interface AllowedAssetArg {
  mint: PublicKey;
  feedId: number[];
}

/** Instruction arguments for the permitted universe, in the order given. */
export function toAllowedAssets(symbols: string[]): AllowedAssetArg[] {
  return symbols.map((symbol) => {
    const asset = getAssetBySymbol(symbol);
    if (!asset) {
      throw new Error(`${symbol} has no registry entry.`);
    }
    return {
      mint: new PublicKey(asset.mint),
      feedId: Array.from(feedIdBytes(asset)),
    };
  });
}

/** How an asset is priced, for display next to the selection. */
export function describeFeedBinding(asset: RegisteredAsset): string {
  const hex = asset.feeds?.primary;
  if (!hex) return `priced by ${asset.priceSource}, no Pyth feed`;
  return `Pyth ${hex.slice(0, 6)}..${hex.slice(-4)}`;
}
