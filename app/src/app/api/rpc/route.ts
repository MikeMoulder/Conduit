import { getEnv } from "@/lib/env";

/**
 * Same origin proxy to the Solana RPC endpoint.
 *
 * The browser has to read chain state and send signed transactions, but our RPC
 * URL carries an API key in its query string. Handing that URL to the browser
 * would publish the key to anyone who opens developer tools, so the browser
 * talks to this route and the route talks to the provider.
 *
 * A proxy is a relay, so it is deliberately narrow. Only the methods this
 * interface actually calls are forwarded, the body is capped, and batches are
 * bounded. Anything else is refused here rather than billed to us. This is
 * devnet, so the blast radius of abuse is rate limit rather than money, but the
 * same route would be pointed at mainnet unchanged and it should already be
 * shaped for that.
 */

export const dynamic = "force-dynamic";

/**
 * Methods the interface is known to call: reads, plus the one write.
 *
 * Subscription methods are absent on purpose. They are websocket only and this
 * route is HTTP, so confirmation is done by polling `getSignatureStatuses`
 * rather than by opening a socket the proxy cannot carry.
 */
const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "getVersion",
  "sendTransaction",
  "simulateTransaction",
]);

const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH = 20;

interface RpcCall {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function refuse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();

  if (raw.length > MAX_BODY_BYTES) {
    return refuse("request body too large", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse("body must be JSON", 400);
  }

  const calls: RpcCall[] = Array.isArray(body) ? body : [body as RpcCall];

  if (calls.length === 0) {
    return refuse("empty request", 400);
  }

  if (calls.length > MAX_BATCH) {
    return refuse(`batch of ${calls.length} exceeds the limit of ${MAX_BATCH}`, 413);
  }

  for (const call of calls) {
    if (typeof call?.method !== "string") {
      return refuse("every call must name a method", 400);
    }
    if (!ALLOWED_METHODS.has(call.method)) {
      // Named rather than generic, because the caller here is our own frontend
      // and a method we forgot to allow should be obvious in the console.
      return refuse(`method not permitted through this proxy: ${call.method}`, 403);
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(getEnv().SOLANA_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
      cache: "no-store",
    });
  } catch (error) {
    // The message is reported without the URL. Our endpoint embeds an API key,
    // and fetch failures quote the URL they were given.
    return Response.json(
      {
        error: "rpc endpoint unreachable",
        detail: error instanceof Error ? error.name : "unknown",
      },
      { status: 502 },
    );
  }

  const text = await upstream.text();

  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
