import { readBalances, readPriceAges, readStoreFromSite } from "@/lib/ops/check";
import { findProblems, type HealthReading } from "@/lib/ops/health";
import { getConnection } from "@/lib/rpc";

/**
 * Whether Conduit is working, for an uptime monitor.
 *
 * 200 when nothing is wrong, 503 with the problems in plain words when
 * something is. The worker already alerts on Telegram, but a worker that has
 * died cannot report its own death, so this page is what an outside monitor
 * pings: it sees the worker's heartbeat go quiet even when the worker cannot.
 *
 * One store read, one request for every price, three balances. Nothing
 * secret in the answer: ages, balances and what is wrong.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const connection = getConnection();
  const [store, prices, balances] = await Promise.all([
    readStoreFromSite(),
    readPriceAges(connection).catch(() => []),
    readBalances(connection).catch(() => []),
  ]);

  const reading: HealthReading = { ...store, prices, balances };
  const problems = findProblems(reading);
  const ok = problems.length === 0;

  return Response.json(
    { ok, problems: problems.map((p) => p.text), reading, at: Date.now() },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
