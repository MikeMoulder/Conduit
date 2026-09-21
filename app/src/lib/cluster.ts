/**
 * Cluster settings that the browser is allowed to know.
 *
 * Deliberately separate from `env.ts`, which is server only. Everything here is
 * public by construction: a cluster name and a same origin path. The RPC URL
 * itself is NOT here, because ours carries an API key in its query string and
 * anything a client component imports ends up in the shipped bundle.
 */

/**
 * Same origin path that proxies to the real RPC endpoint.
 *
 * The browser talks to this instead of talking to the provider directly, so the
 * key stays on the server and the dedicated endpoint rate limits still apply.
 *
 * The cluster is appended as a path segment, which is not decoration. A wallet
 * decides which chain it is signing for by searching this string for the word
 * devnet, treating anything unrecognised as mainnet, so a path without it would
 * have wallets signing mainnet transactions against a devnet program. The route
 * also checks the segment against its own configuration and refuses a mismatch.
 */
export const RPC_PROXY_PATH = "/api/rpc";

export type Cluster = "devnet" | "mainnet-beta" | "localnet";

/**
 * Which cluster the interface is pointed at.
 *
 * `NEXT_PUBLIC_` is correct here and only here: the cluster name is not a
 * secret, and the browser needs it to build explorer links that match the
 * chain the server is actually writing to.
 */
export const CLUSTER: Cluster =
  (process.env.NEXT_PUBLIC_SOLANA_CLUSTER as Cluster | undefined) ?? "devnet";

/**
 * Absolute RPC URL for a web3.js `Connection`.
 *
 * web3.js parses the endpoint with `new URL(...)`, so a bare path is rejected
 * and an origin has to be supplied. During server rendering there is no origin
 * to read; the placeholder below is never dialled, because a `Connection` opens
 * no socket when it is constructed and no RPC call is made while rendering.
 */
export function rpcEndpoint(): string {
  const origin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return `${origin}${RPC_PROXY_PATH}/${CLUSTER}`;
}
