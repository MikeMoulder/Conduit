"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

import { CLUSTER } from "@/lib/cluster";
import { explorerUrl, mandatePda, portfolioPda } from "@/lib/chain";

/**
 * What the connected wallet owns on this program.
 *
 * Mandate addresses are derived from the owner, so they can be shown before
 * anything has been created. That is the point worth making early: the address
 * a mandate will live at is fixed by who the owner is, not chosen by the agent
 * and not assigned by a server.
 */

/** The first mandate an owner creates. Several are supported; one is the demo. */
const DEFAULT_MANDATE_ID = 0;

export function OwnerPanel() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [known, setKnown] = useState<{ address: string; exists: boolean } | null>(
    null,
  );

  /**
   * Memoised because `mandatePda` returns a fresh `PublicKey` on every call.
   * Without this the object identity changes each render and the effect below
   * would refetch forever.
   */
  const mandate = useMemo(
    () => (publicKey ? mandatePda(publicKey, DEFAULT_MANDATE_ID) : null),
    [publicKey],
  );
  const portfolio = useMemo(
    () => (mandate ? portfolioPda(mandate) : null),
    [mandate],
  );

  useEffect(() => {
    if (!mandate) return;

    let current = true;
    connection
      .getAccountInfo(mandate)
      .then((account) => {
        if (current) {
          setKnown({ address: mandate.toBase58(), exists: account !== null });
        }
      })
      .catch(() => {
        // Left alone. The address check below refuses to report on an account
        // other than the one currently derived.
      });

    return () => {
      current = false;
    };
  }, [connection, mandate]);

  /**
   * Derived, not cleared in an effect. Whether the answer in hand describes the
   * address on screen is already decidable from what is rendered.
   */
  const exists =
    mandate && known?.address === mandate.toBase58() ? known.exists : null;

  if (!connected || !publicKey || !mandate || !portfolio) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 px-5 py-8 text-center">
        <p className="text-sm text-zinc-400">
          Connect a {CLUSTER} wallet to author a mandate.
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-zinc-600">
          The owner signs mandate creation and status changes. The agent holds a
          separate keypair and can reach exactly one instruction.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800">
      <Row label="Owner" value={publicKey.toBase58()} />
      <Row
        label={`Mandate ${DEFAULT_MANDATE_ID}`}
        value={mandate.toBase58()}
        note={
          exists === null
            ? undefined
            : exists
              ? "exists on chain"
              : "not created yet"
        }
      />
      <Row label="Portfolio" value={portfolio.toBase58()} last />
    </div>
  );
}

function Row({
  label,
  value,
  note,
  last,
}: {
  label: string;
  value: string;
  note?: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-baseline justify-between gap-2 px-5 py-3 ${
        last ? "" : "border-b border-zinc-900"
      }`}
    >
      <span className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className="flex items-baseline gap-3">
        {note ? (
          <span
            className={`text-xs ${
              note === "exists on chain" ? "text-emerald-400" : "text-zinc-600"
            }`}
          >
            {note}
          </span>
        ) : null}
        <a
          href={explorerUrl(value, "address", CLUSTER)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-sm text-zinc-300 underline-offset-4 hover:text-emerald-400 hover:underline"
        >
          {value.slice(0, 8)}..{value.slice(-8)}
        </a>
      </span>
    </div>
  );
}
