import { Program } from "@coral-xyz/anchor";
import { Connection, type PublicKey } from "@solana/web3.js";

import idl from "./idl/stockpilot.json";
import type { Stockpilot } from "./idl/stockpilot";

/**
 * Reading mandate and portfolio accounts from the chain.
 *
 * Deliberately provider free. Decoding an account needs the layout, which the
 * IDL carries, and nothing else. Requiring an `AnchorProvider` would mean
 * requiring a wallet, and both the server and a disconnected browser have good
 * reasons to read a mandate without one.
 *
 * Everything is normalised on the way out: addresses become base58 strings and
 * basis points become plain numbers. Callers compare, display and post these
 * values around, and `PublicKey` instances compare by identity rather than by
 * value, which is a quiet source of bugs.
 */

/**
 * A program client held only for its account coder.
 *
 * Building `BorshAccountsCoder` straight from the JSON IDL was the obvious
 * thing and it decodes into snake_case, because the JSON IDL is snake_case and
 * the raw coder takes it literally. `Program` converts the IDL to camelCase
 * first, which is why `program.account.mandate.fetch` returns `createdAt`
 * everywhere else in this codebase. Anchor keeps that conversion internal and
 * does not export it.
 *
 * So the coder comes from a `Program`, and there is then exactly one naming
 * convention in the project rather than two that differ by which helper a file
 * happened to reach for. The connection below is never used: decoding is a pure
 * function of the layout and the bytes, and constructing a `Connection` opens
 * no socket. A real connection is passed to the fetch helpers instead.
 */
const coder = new Program<Stockpilot>(idl as Stockpilot, {
  connection: new Connection("http://localhost"),
}).coder.accounts;

export type MandateStatus = "active" | "paused" | "closed";

export interface MandateConstraintsView {
  maxPositionBps: number;
  minCashBps: number;
  maxTurnoverBps: number;
  maxAssets: number;
}

export interface AllowedAssetView {
  mint: string;
  /** Hex. All zeros means the asset has no Pyth feed. See `mandate.ts`. */
  feedId: string;
}

export interface MandateView {
  address: string;
  mandateId: string;
  owner: string;
  agent: string;
  constraints: MandateConstraintsView;
  allowedAssets: AllowedAssetView[];
  status: MandateStatus;
  version: number;
  createdAt: number;
  rebalanceCount: number;
  lastRebalanceAt: number;
}

export interface PositionView {
  mint: string;
  targetBps: number;
}

export interface PortfolioView {
  address: string;
  mandate: string;
  owner: string;
  positions: PositionView[];
  cashBps: number;
  createdAt: number;
  updatedAt: number;
}

/** Anchor decodes a unit enum as a single key object, `{ active: {} }`. */
function readStatus(raw: Record<string, unknown>): MandateStatus {
  if ("paused" in raw) return "paused";
  if ("closed" in raw) return "closed";
  return "active";
}

interface RawMandate {
  mandateId: { toString(): string };
  owner: PublicKey;
  agent: PublicKey;
  constraints: MandateConstraintsView;
  allowedAssets: { mint: PublicKey; feedId: number[] }[];
  status: Record<string, unknown>;
  version: number;
  createdAt: { toNumber(): number };
  rebalanceCount: { toNumber(): number };
  lastRebalanceAt: { toNumber(): number };
}

interface RawPortfolio {
  mandate: PublicKey;
  owner: PublicKey;
  positions: { mint: PublicKey; targetBps: number }[];
  cashBps: number;
  createdAt: { toNumber(): number };
  updatedAt: { toNumber(): number };
}

export function decodeMandate(address: PublicKey, data: Buffer): MandateView {
  const raw = coder.decode<RawMandate>("mandate", data);

  return {
    address: address.toBase58(),
    mandateId: raw.mandateId.toString(),
    owner: raw.owner.toBase58(),
    agent: raw.agent.toBase58(),
    constraints: {
      maxPositionBps: raw.constraints.maxPositionBps,
      minCashBps: raw.constraints.minCashBps,
      maxTurnoverBps: raw.constraints.maxTurnoverBps,
      maxAssets: raw.constraints.maxAssets,
    },
    allowedAssets: raw.allowedAssets.map((a) => ({
      mint: a.mint.toBase58(),
      feedId: Buffer.from(a.feedId).toString("hex"),
    })),
    status: readStatus(raw.status),
    version: raw.version,
    createdAt: raw.createdAt.toNumber(),
    rebalanceCount: raw.rebalanceCount.toNumber(),
    lastRebalanceAt: raw.lastRebalanceAt.toNumber(),
  };
}

export function decodePortfolio(
  address: PublicKey,
  data: Buffer,
): PortfolioView {
  const raw = coder.decode<RawPortfolio>("portfolio", data);

  return {
    address: address.toBase58(),
    mandate: raw.mandate.toBase58(),
    owner: raw.owner.toBase58(),
    positions: raw.positions.map((p) => ({
      mint: p.mint.toBase58(),
      targetBps: p.targetBps,
    })),
    cashBps: raw.cashBps,
    createdAt: raw.createdAt.toNumber(),
    updatedAt: raw.updatedAt.toNumber(),
  };
}

/** Null when the account does not exist, which is not an error at any call site. */
export async function fetchMandate(
  connection: Connection,
  address: PublicKey,
): Promise<MandateView | null> {
  const account = await connection.getAccountInfo(address);
  return account ? decodeMandate(address, account.data) : null;
}

export async function fetchPortfolio(
  connection: Connection,
  address: PublicKey,
): Promise<PortfolioView | null> {
  const account = await connection.getAccountInfo(address);
  return account ? decodePortfolio(address, account.data) : null;
}
