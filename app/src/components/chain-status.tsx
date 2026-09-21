"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { CLUSTER } from "@/lib/cluster";
import { PROGRAM_ID, explorerUrl } from "@/lib/chain";

/**
 * Live proof that the browser can reach the deployed program.
 *
 * This is not decoration. It exercises the whole read path in one go: the RPC
 * proxy, the connection built on top of it, and the program address derived
 * from the bundled IDL. If the interface later cannot send a transaction, this
 * panel already says whether the problem is the connection or the transaction.
 */

type Status =
  | { state: "checking" }
  | { state: "ok"; slot: number; executable: boolean; owner: string }
  | { state: "missing" }
  | { state: "error"; detail: string };

export function ChainStatus() {
  const { connection } = useConnection();
  const [status, setStatus] = useState<Status>({ state: "checking" });

  useEffect(() => {
    let current = true;

    async function check() {
      try {
        const [slot, account] = await Promise.all([
          connection.getSlot(),
          connection.getAccountInfo(PROGRAM_ID),
        ]);

        if (!current) return;

        if (!account) {
          setStatus({ state: "missing" });
          return;
        }

        setStatus({
          state: "ok",
          slot,
          executable: account.executable,
          owner: account.owner.toBase58(),
        });
      } catch (error) {
        if (!current) return;
        setStatus({
          state: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    void check();
    return () => {
      current = false;
    };
  }, [connection]);

  return (
    <dl className="grid gap-px overflow-hidden rounded-lg border border-zinc-800 bg-zinc-800 sm:grid-cols-3">
      <Cell label="Cluster">{CLUSTER}</Cell>

      <Cell label="Program">
        <a
          href={explorerUrl(PROGRAM_ID.toBase58(), "address", CLUSTER)}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4 hover:text-emerald-400"
        >
          {PROGRAM_ID.toBase58().slice(0, 4)}..{PROGRAM_ID.toBase58().slice(-4)}
        </a>
      </Cell>

      <Cell label="Chain">
        {status.state === "checking" ? (
          <span className="text-zinc-500">checking</span>
        ) : status.state === "ok" ? (
          <span className={status.executable ? "text-emerald-400" : "text-amber-400"}>
            {status.executable ? "live" : "not executable"}
            <span className="ml-2 text-zinc-500">slot {status.slot}</span>
          </span>
        ) : status.state === "missing" ? (
          <span className="text-red-400">program not found on {CLUSTER}</span>
        ) : (
          <span className="text-red-400" title={status.detail}>
            unreachable
          </span>
        )}
      </Cell>
    </dl>
  );
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-zinc-950 px-4 py-3">
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-1 font-mono text-sm">{children}</dd>
    </div>
  );
}
