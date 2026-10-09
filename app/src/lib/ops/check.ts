import "server-only";

import { LAMPORTS_PER_SOL, PublicKey, type Connection } from "@solana/web3.js";

import { getAgentKeypair } from "../agent-identity";
import { PROGRAM_ID } from "../chain";
import { getFaucetKeypair } from "../faucet";
import { desk } from "../holdings";
import { kv } from "../kv";
import { codecProgram } from "../program-client";
import type { BalanceName, HealthReading } from "./health";

/**
 * Gathering a health reading: the parts that need the chain or the store.
 *
 * Every published price in one getMultipleAccountsInfo, three balances, and
 * at most one store command, so a check every five minutes from the worker
 * and an uptime monitor's ping cost almost nothing.
 */

/** How old every published price settlement reads is, in one request. */
export async function readPriceAges(connection: Connection): Promise<HealthReading["prices"]> {
  const published = desk.settleable.filter((a) => a.source === "published");
  const accounts = await connection.getMultipleAccountsInfo(published.map((a) => new PublicKey(a.priceAccount)));
  const now = Math.floor(Date.now() / 1000);
  return published.map((asset, i) => {
    const info = accounts[i];
    if (!info) return { symbol: asset.symbol, ageSeconds: null };
    const decoded = codecProgram.coder.accounts.decode("publishedPrice", info.data) as {
      publishTime: { toNumber(): number };
    };
    return { symbol: asset.symbol, ageSeconds: now - decoded.publishTime.toNumber() };
  });
}

/** The publisher authority, read from the program's publisher account rather than configured twice. */
async function publisherAuthority(connection: Connection): Promise<PublicKey | null> {
  const [address] = PublicKey.findProgramAddressSync([Buffer.from("publisher")], PROGRAM_ID);
  const info = await connection.getAccountInfo(address);
  if (!info) return null;
  const decoded = codecProgram.coder.accounts.decode("publisher", info.data) as { authority: PublicKey };
  return decoded.authority;
}

/** SOL on the keys that pay fees. A key this process does not hold is reported as null, not as empty. */
export async function readBalances(connection: Connection): Promise<HealthReading["balances"]> {
  const keys: { name: BalanceName; key: PublicKey | null }[] = [
    { name: "faucet", key: getFaucetKeypair()?.publicKey ?? null },
    { name: "agent", key: getAgentKeypair()?.publicKey ?? null },
    { name: "publisher", key: await publisherAuthority(connection).catch(() => null) },
  ];
  return Promise.all(
    keys.map(async ({ name, key }) => ({
      name,
      sol: key ? await connection.getBalance(key).then((l) => l / LAMPORTS_PER_SOL).catch(() => null) : null,
    })),
  );
}

/**
 * The store as the site sees it: reachable, and how long since the worker
 * wrote its heartbeat. One command.
 */
export async function readStoreFromSite(): Promise<Pick<HealthReading, "store" | "workerHeartbeatAgoSeconds">> {
  try {
    const raw = await kv().get("worker:heartbeat");
    return {
      store: { ok: true },
      workerHeartbeatAgoSeconds: raw ? Math.round((Date.now() - Number(raw)) / 1000) : null,
    };
  } catch (error) {
    // No heartbeat age: with the store down it cannot be read, which is not
    // the same as the worker being silent.
    return { store: { ok: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error) } };
  }
}
