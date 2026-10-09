"use client";

import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";

import type { AutopilotEntry } from "@/lib/autopilot/state";
import type { WalletCard } from "@/lib/copilot/events";
import { describeTrigger, type Trigger } from "@/lib/triggers/rules";
import { closePortfolio, openStock, todayMove, useSheets } from "@/lib/ui-sheets";
import { AssetBadge } from "./cards";

/**
 * Your money at a glance: what the main wallet is worth and how it moved
 * today, what it holds, the alerts and orders watching for you, and the
 * autopilots running.
 *
 * Read from the same code the chat's get_wallet uses, so the panel and a chat
 * reply never disagree about one wallet. Nothing here acts: every button
 * sends a sentence to the chat or opens a stock, so anything that moves money
 * still comes back as a card to approve.
 */

interface Portfolio {
  wallet: WalletCard;
  triggers: { watching: Trigger[]; finished: Trigger[] };
  autopilots: AutopilotEntry[];
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function PortfolioPanel({
  owner,
  canAsk,
  onAsk,
}: {
  owner: string | null;
  canAsk: boolean;
  onAsk: (question: string) => void;
}) {
  const { portfolio, portfolioOpenedAt } = useSheets();
  if (!portfolio) return null;
  return <Panel key={portfolioOpenedAt} owner={owner} canAsk={canAsk} onAsk={onAsk} />;
}

function Panel({
  owner,
  canAsk,
  onAsk,
}: {
  owner: string | null;
  canAsk: boolean;
  onAsk: (question: string) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const key = `${owner ?? ""}:${refresh}`;
  const [loaded, setLoaded] = useState<{ key: string; data: Portfolio | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!owner) return;
    let alive = true;
    fetch(`/api/portfolio?owner=${owner}`)
      .then((r) => r.json())
      .then((body: Portfolio & { error?: string }) => {
        if (alive) setLoaded({ key, data: body.error ? null : body, error: body.error ?? null });
      })
      .catch(() => {
        if (alive) setLoaded({ key, data: null, error: "Couldn't load your portfolio. Check your connection." });
      });
    return () => {
      alive = false;
    };
  }, [key, owner]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePortfolio();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loading = loaded?.key !== key;
  const data = loaded?.data ?? null;

  const ask = (question: string) => {
    onAsk(question);
    closePortfolio();
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Your money">
      <button type="button" aria-label="Close" onClick={closePortfolio} className="absolute inset-0 bg-black/40" />
      <aside className="relative h-full w-full overflow-y-auto border-l border-line bg-surface animate-[rise-in_0.2s_ease-out_both] sm:max-w-sm">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-surface px-5 py-4">
          <h2 className="text-base font-semibold tracking-tight">Your money</h2>
          <div className="flex items-center gap-1">
            {owner ? (
              <button
                type="button"
                onClick={() => setRefresh((n) => n + 1)}
                aria-label="Refresh"
                title="Refresh"
                className="grid size-8 place-items-center rounded-full text-ink-muted transition-colors hover:bg-raised hover:text-ink"
              >
                <RotateCcw className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={closePortfolio}
              aria-label="Close"
              className="grid size-8 place-items-center rounded-full text-ink-muted transition-colors hover:bg-raised hover:text-ink"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="flex flex-col gap-6 px-5 py-5">
          {!owner ? (
            <p className="text-sm text-ink-muted">Connect a wallet to see your money here.</p>
          ) : !data && loading ? (
            <div className="flex flex-col gap-3" aria-label="Loading">
              <div className="h-10 w-48 animate-pulse rounded-lg bg-raised" />
              <div className="h-24 animate-pulse rounded-2xl bg-raised" />
              <div className="h-24 animate-pulse rounded-2xl bg-raised" />
            </div>
          ) : !data ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-ink-muted">{loaded?.error}</p>
              <button
                type="button"
                onClick={() => setRefresh((n) => n + 1)}
                className="rounded-full border border-line-strong px-3 py-1.5 text-xs text-ink hover:bg-raised"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              <WalletSection wallet={data.wallet} canAsk={canAsk} ask={ask} />
              <AlertsSection triggers={data.triggers} canAsk={canAsk} ask={ask} />
              <AutopilotSection entries={data.autopilots} canAsk={canAsk} ask={ask} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-[11px] uppercase tracking-wider text-ink-faint">{children}</h3>;
}

function AskButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-full border border-line-strong px-3 py-1.5 text-xs text-ink transition-colors hover:bg-raised disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function WalletSection({ wallet, canAsk, ask }: { wallet: WalletCard; canAsk: boolean; ask: (q: string) => void }) {
  if (!wallet.opened) {
    return (
      <section className="flex flex-col items-start gap-3">
        <p className="text-sm text-ink-muted">
          No main wallet yet. Open one and you can trade by text, with no wallet popups.
        </p>
        <AskButton label="Open my main wallet" onClick={() => ask("Open my main wallet")} disabled={!canAsk} />
        {wallet.ownCash === 0 ? (
          <AskButton label="Give me demo cash" onClick={() => ask("Give me demo cash")} disabled={!canAsk} />
        ) : null}
      </section>
    );
  }

  const move = todayMove(wallet);
  return (
    <section>
      <p className="text-[11px] uppercase tracking-wider text-ink-faint">Main wallet</p>
      <p className="mt-1 font-mono text-3xl font-semibold tracking-tight">{usd(wallet.total)}</p>
      {move !== null ? (
        <p className={`mt-0.5 font-mono text-sm ${move >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {move >= 0 ? "+" : "-"}
          {usd(Math.abs(move))} today
        </p>
      ) : null}

      <ul className="mt-4 flex flex-col overflow-hidden rounded-2xl border border-line">
        {wallet.holdings.map((h) => (
          <li key={h.symbol} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => openStock(h.symbol)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-raised"
            >
              <AssetBadge symbol={h.symbol} />
              <span className="shrink-0 text-right">
                <span className="block font-mono text-sm">{h.value === null ? "no price" : usd(h.value)}</span>
                <span className="block font-mono text-[11px] text-ink-faint">
                  {h.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  {h.changePct !== undefined && h.changePct !== null ? (
                    <span className={h.changePct >= 0 ? " text-emerald-400" : " text-red-400"}>
                      {" "}
                      {h.changePct >= 0 ? "+" : ""}
                      {h.changePct.toFixed(2)}%
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          </li>
        ))}
        <li className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="text-ink-muted">Cash</span>
          <span className="font-mono">{usd(wallet.cash)}</span>
        </li>
      </ul>

      {wallet.ownCash > 0 ? (
        <div className="mt-3 flex items-center justify-between gap-3 text-[13px]">
          <span className="text-ink-faint">
            {usd(wallet.ownCash)} still in your own wallet
          </span>
          <AskButton label="Move $1,000 in" onClick={() => ask("Deposit $1,000")} disabled={!canAsk} />
        </div>
      ) : null}
      {wallet.holdings.length === 0 ? (
        <div className="mt-3">
          <AskButton label="Buy $50 of Apple" onClick={() => ask("Buy $50 of Apple")} disabled={!canAsk} />
        </div>
      ) : null}
    </section>
  );
}

function AlertsSection({
  triggers,
  canAsk,
  ask,
}: {
  triggers: { watching: Trigger[]; finished: Trigger[] };
  canAsk: boolean;
  ask: (q: string) => void;
}) {
  return (
    <section>
      <SectionTitle>Alerts and orders</SectionTitle>
      {triggers.watching.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink-muted">Nothing watching right now.</p>
          <AskButton label="Ping me if NVDA drops 3%" onClick={() => ask("Ping me if NVDA drops 3%")} disabled={!canAsk} />
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {triggers.watching.map((t) => (
            <li key={t.id} className="rounded-2xl border border-line px-4 py-3 text-[13px] leading-relaxed">
              <span className="flex items-center gap-2 text-[11px] text-emerald-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                watching
              </span>
              <span className="mt-1 block text-ink">{describeTrigger(t)}</span>
            </li>
          ))}
        </ul>
      )}
      {triggers.finished.length > 0 ? (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer text-ink-faint">Recently finished ({triggers.finished.length})</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {triggers.finished.map((t) => (
              <li key={t.id} className="text-ink-muted">
                <span className="text-ink">{t.symbol}</span> {t.status}: {t.result ?? describeTrigger(t)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function AutopilotSection({
  entries,
  canAsk,
  ask,
}: {
  entries: AutopilotEntry[];
  canAsk: boolean;
  ask: (q: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section>
      <SectionTitle>Autopilot</SectionTitle>
      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li key={e.mandate} className="rounded-2xl border border-line px-4 py-3 text-[13px]">
            <span className="flex items-center justify-between gap-3">
              <span className="text-ink">Mandate {e.mandateId}</span>
              <span className={e.brakedAt ? "text-red-400" : e.enabled ? "text-emerald-400" : "text-ink-faint"}>
                {e.brakedAt ? "stopped by the brake" : e.enabled ? `on, every ${e.everyMinutes} min` : "paused"}
              </span>
            </span>
            {e.lastRunAt ? (
              <span className="mt-1 block text-[11px] text-ink-faint">
                last ran {new Date(e.lastRunAt).toLocaleString()}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <AskButton label="How am I doing?" onClick={() => ask("How am I doing against the market?")} disabled={!canAsk} />
      </div>
    </section>
  );
}
