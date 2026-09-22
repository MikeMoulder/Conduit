"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

import { getAssetByMint } from "@/lib/assets";
import { CLUSTER } from "@/lib/cluster";
import { bpsToPercent, explorerUrl, mandatePda, portfolioPda } from "@/lib/chain";
import {
  fetchMandate,
  fetchPortfolio,
  type MandateView,
  type PortfolioView,
} from "@/lib/accounts";
import { ActivityFeed } from "@/components/activity-feed";
import { ProposalReview } from "@/components/proposal-review";

/**
 * A mandate and the portfolio it governs, read from the chain.
 *
 * Nothing here comes from a database. Every number on this page was decoded
 * from an account, which matters more than it sounds: a cached copy of a
 * portfolio can disagree with the chain, and the moment it does, the interface
 * starts describing a position that does not exist.
 */

interface Loaded {
  /** The mandate address this result describes. */
  key: string;
  mandate: MandateView | null;
  portfolio: PortfolioView | null;
  error: string | null;
}

export function PortfolioView() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [mandateId, setMandateId] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** Bumped to force a reread. Changing it is what the reload button does. */
  const [nonce, setNonce] = useState(0);
  /** Bumped when a submission settles, so the history refetches. */
  const [revision, setRevision] = useState(0);

  const addresses = useMemo(() => {
    if (!publicKey) return null;
    const mandate = mandatePda(publicKey, mandateId);
    return { mandate, portfolio: portfolioPda(mandate) };
  }, [publicKey, mandateId]);

  const key = addresses?.mandate.toBase58() ?? null;

  useEffect(() => {
    if (!addresses) return;

    let current = true;
    const requested = addresses.mandate.toBase58();

    Promise.all([
      fetchMandate(connection, addresses.mandate),
      fetchPortfolio(connection, addresses.portfolio),
    ])
      .then(([mandate, portfolio]) => {
        if (current) setLoaded({ key: requested, mandate, portfolio, error: null });
      })
      .catch((error: unknown) => {
        if (current) {
          setLoaded({
            key: requested,
            mandate: null,
            portfolio: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      current = false;
    };
  }, [connection, addresses, nonce]);

  /**
   * Loading is derived rather than stored.
   *
   * Whether the result in hand belongs to the mandate on screen is already
   * decidable from the address, so recording it separately would mean setting
   * state inside the effect and scheduling a render for something already
   * known. It also means a slow answer for a previous mandate cannot be shown
   * against the current one.
   */
  const fresh = loaded && loaded.key === key ? loaded : null;

  if (!connected || !publicKey) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-800 px-5 py-8 text-center text-sm text-zinc-400">
        Connect a {CLUSTER} wallet to see the mandate you own.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          Mandate number
          <input
            type="number"
            min={0}
            value={mandateId}
            onChange={(e) => setMandateId(Math.max(0, Number(e.target.value) || 0))}
            className="w-20 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        >
          Reload from chain
        </button>
      </div>

      {!fresh ? (
        <p className="text-sm text-zinc-500">Reading the chain.</p>
      ) : fresh.error ? (
        <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
          {fresh.error}
        </p>
      ) : !fresh.mandate ? (
        <p className="rounded-lg border border-dashed border-zinc-800 px-5 py-8 text-center text-sm text-zinc-400">
          No mandate {mandateId} for this wallet yet.{" "}
          <Link
            href="/mandate"
            className="text-emerald-400 underline underline-offset-4"
          >
            Author one first.
          </Link>
        </p>
      ) : (
        <>
          <MandateSummary mandate={fresh.mandate} />
          <Targets portfolio={fresh.portfolio} />
          {fresh.portfolio ? (
            <ProposalReview
              mandate={fresh.mandate}
              portfolio={fresh.portfolio}
              onSubmitted={(portfolio) => {
                if (portfolio) setLoaded({ ...fresh, portfolio });
                setRevision((r) => r + 1);
              }}
            />
          ) : (
            <p className="text-sm text-amber-400">
              This mandate has no portfolio account, so there is nothing to
              rebalance.
            </p>
          )}
          <ActivityFeed
            mandate={fresh.mandate.address}
            revision={revision}
          />
        </>
      )}
    </div>
  );
}

function MandateSummary({ mandate }: { mandate: MandateView }) {
  const statusColour =
    mandate.status === "active"
      ? "text-emerald-400"
      : mandate.status === "paused"
        ? "text-amber-400"
        : "text-red-400";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-200">The mandate</h2>
        <span className={`font-mono text-xs ${statusColour}`}>
          {mandate.status}
          <span className="ml-3 text-zinc-600">
            {mandate.rebalanceCount} rebalance
            {mandate.rebalanceCount === 1 ? "" : "s"} so far
          </span>
        </span>
      </div>

      <dl className="grid gap-px overflow-hidden rounded-lg border border-zinc-800 bg-zinc-800 sm:grid-cols-4">
        <Cell label="max position" value={bpsToPercent(mandate.constraints.maxPositionBps)} />
        <Cell label="min cash" value={bpsToPercent(mandate.constraints.minCashBps)} />
        <Cell label="max turnover" value={bpsToPercent(mandate.constraints.maxTurnoverBps)} />
        <Cell label="max positions" value={String(mandate.constraints.maxAssets)} />
      </dl>

      <div className="flex flex-wrap gap-1.5">
        {mandate.allowedAssets.map((asset) => {
          const known = getAssetByMint(asset.mint);
          return (
            <span
              key={asset.mint}
              title={asset.mint}
              className="rounded-full border border-zinc-800 px-2.5 py-0.5 font-mono text-[11px] text-zinc-400"
            >
              {known?.symbol ?? `${asset.mint.slice(0, 6)}..`}
            </span>
          );
        })}
      </div>

      <p className="text-xs leading-relaxed text-zinc-600">
        Agent{" "}
        <a
          href={explorerUrl(mandate.agent, "address", CLUSTER)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono underline underline-offset-4 hover:text-zinc-400"
        >
          {mandate.agent.slice(0, 8)}..{mandate.agent.slice(-8)}
        </a>
        . It may propose a rebalance. It cannot amend these limits, widen the
        list above, replace itself or withdraw.
      </p>
    </section>
  );
}

/**
 * The weights the program enforces.
 *
 * Named for what it shows. These are targets, not custody: the portfolio owns
 * nothing until a settlement moves tokens, and the earlier heading here said
 * otherwise.
 */
function Targets({ portfolio }: { portfolio: PortfolioView | null }) {
  if (!portfolio) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-zinc-200">Targets</h2>
      {portfolio.positions.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 px-4 py-3 text-sm text-zinc-500">
          Fully in cash. No well formed mandate can forbid that, which is why a
          portfolio opens this way.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          {portfolio.positions.map((position) => {
            const asset = getAssetByMint(position.mint);
            return (
              <div
                key={position.mint}
                className="flex items-baseline justify-between border-b border-zinc-900 px-4 py-2.5 last:border-b-0"
              >
                <span className="text-sm text-zinc-200">
                  {asset?.symbol ?? `${position.mint.slice(0, 8)}..`}
                  {asset ? (
                    <span className="ml-2 text-xs text-zinc-500">
                      {asset.name}
                    </span>
                  ) : null}
                </span>
                <span className="font-mono text-sm text-zinc-300">
                  {bpsToPercent(position.targetBps)}
                </span>
              </div>
            );
          })}
          <div className="flex items-baseline justify-between bg-zinc-900/40 px-4 py-2.5">
            <span className="text-sm text-zinc-400">cash</span>
            <span className="font-mono text-sm text-zinc-400">
              {bpsToPercent(portfolio.cashBps)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-950 px-4 py-3">
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-zinc-100">{value}</dd>
    </div>
  );
}
