"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import { CLUSTER } from "@/lib/cluster";
import { bpsToPercent, explorerUrl } from "@/lib/chain";
import { fetchActivity, type ActivityRecord } from "@/lib/events";

/**
 * What has actually happened to this mandate.
 *
 * Read back from the cluster every time rather than kept anywhere. A stored
 * history is only worth its agreement with the chain, and the moment it drifts
 * it becomes a confident account of things that did not happen.
 *
 * Refusals are shown alongside acceptances and are the more interesting half.
 * A list of accepted rebalances shows an agent behaving itself. A list that
 * also contains the times the program said no shows a mandate doing its job,
 * and each of those is a real transaction anyone can open in an explorer.
 */

export function ActivityFeed({
  mandate,
  /** Changes when a rebalance lands, so the feed refetches. */
  revision,
}: {
  mandate: string;
  revision: number;
}) {
  const { connection } = useConnection();
  const [loaded, setLoaded] = useState<{
    key: string;
    records: ActivityRecord[] | null;
    error: string | null;
  } | null>(null);

  const key = `${mandate}:${revision}`;

  useEffect(() => {
    let current = true;
    const requested = key;

    fetchActivity(connection, new PublicKey(mandate))
      .then((records) => {
        if (current) setLoaded({ key: requested, records, error: null });
      })
      .catch((error: unknown) => {
        if (current) {
          setLoaded({
            key: requested,
            records: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      current = false;
    };
  }, [connection, mandate, key]);

  const fresh = loaded && loaded.key === key ? loaded : null;

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium text-zinc-200">History</h2>
        <p className="text-xs leading-relaxed text-zinc-500">
          Reconstructed from the account history and transaction logs. Nothing
          here is stored anywhere, so nothing here can disagree with the chain.
        </p>
      </div>

      {!fresh ? (
        <p className="text-sm text-zinc-500">Reading the account history.</p>
      ) : fresh.error ? (
        <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
          {fresh.error}
        </p>
      ) : fresh.records && fresh.records.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 px-4 py-3 text-sm text-zinc-500">
          Nothing yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-1 overflow-hidden rounded-lg border border-zinc-800 py-1">
          {fresh.records?.map((record) => (
            <li
              key={record.signature}
              className="flex flex-col gap-1.5 px-4 py-3"
            >
              <Entry record={record} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Entry({ record }: { record: ActivityRecord }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <Dot kind={record.kind} />
          <span className="text-sm text-zinc-200">
            {record.kind === "accepted"
              ? "Rebalance accepted"
              : record.kind === "refused"
                ? "Refused by the program"
                : record.kind === "instruction"
                  ? record.instruction
                  : "Activity on this account"}
          </span>
          {record.kind === "accepted" ? (
            <span className="font-mono text-[11px] text-zinc-600">
              number {record.event.sequence}
            </span>
          ) : null}
        </span>
        <span className="text-[11px] text-zinc-600">{when(record.blockTime)}</span>
      </div>

      {record.kind === "accepted" ? (
        <p className="font-mono text-xs text-zinc-400">
          {record.event.positionCount} position
          {record.event.positionCount === 1 ? "" : "s"}
          <span className="mx-2 text-zinc-700">|</span>
          {bpsToPercent(record.event.turnoverBps)} turnover
          <span className="mx-2 text-zinc-700">|</span>
          {bpsToPercent(record.event.cashBps)} cash
        </p>
      ) : null}

      {record.kind === "refused" ? (
        <p className="text-xs leading-relaxed text-red-300/90">
          {record.error ? (
            <>
              <span className="font-mono">{record.error.name}</span>
              <span className="text-red-200/60"> {record.error.message}</span>
            </>
          ) : (
            <span className="text-red-200/60">
              the transaction failed without a program error we recognise
            </span>
          )}
        </p>
      ) : null}

      <a
        href={explorerUrl(record.signature, "tx", CLUSTER)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[11px] text-zinc-600 underline-offset-4 hover:text-zinc-400 hover:underline"
      >
        {record.signature.slice(0, 10)}..{record.signature.slice(-10)} at slot{" "}
        {record.slot}
      </a>
    </>
  );
}

function Dot({ kind }: { kind: ActivityRecord["kind"] }) {
  const colour =
    kind === "accepted"
      ? "bg-emerald-500"
      : kind === "refused"
        ? "bg-red-500"
        : "bg-zinc-600";
  return <span className={`h-1.5 w-1.5 rounded-full ${colour}`} />;
}

function when(blockTime: number | null): string {
  if (blockTime === null) return "time not recorded";

  const seconds = Math.floor(Date.now() / 1000) - blockTime;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} hours ago`;
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}
