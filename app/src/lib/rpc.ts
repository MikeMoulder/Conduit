import "server-only";

import { Connection } from "@solana/web3.js";

import { getEnv } from "./env";

/**
 * The server side connection.
 *
 * Talks to the provider directly rather than through `/api/rpc`, because the
 * proxy exists to keep the endpoint URL away from the browser and the server is
 * where that URL already lives. Routing the server through its own proxy would
 * add a hop and a second place to fail for no benefit.
 *
 * Cached, since a `Connection` holds no per request state and constructing one
 * per call discards the agent it keeps for HTTP keep alive.
 */
let cached: Connection | null = null;

export function getConnection(): Connection {
  if (cached) return cached;
  cached = new Connection(getEnv().SOLANA_RPC_URL, {
    commitment: "confirmed",
  });
  return cached;
}
