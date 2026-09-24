"use client";

import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import type { WalletName } from "@solana/wallet-adapter-base";
import { ExternalLink, LogOut, Wallet } from "lucide-react";

import { CLUSTER } from "@/lib/cluster";
import { explorerUrl } from "@/lib/chain";

/**
 * Connect control.
 *
 * Written rather than imported from `@solana/wallet-adapter-react-ui`, because
 * that package ships a stylesheet that fights the rest of the interface for
 * roughly eighty lines of behaviour. What is actually needed is small: list the
 * wallets the browser detected, pick one, show who is connected.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

function shorten(address: string): string {
  return `${address.slice(0, 4)}..${address.slice(-4)}`;
}

/**
 * Where the wallet menu opens, relative to the button.
 *
 * The same control lives in two places that need opposite directions. In the
 * workspace header it sits top right, so the menu drops down and grows to the
 * left. In the chat sidebar it sits bottom left, where dropping down puts the
 * whole menu below the fold and off the left edge: the button appeared to do
 * nothing, while the menu was open the entire time out of view.
 */
export type MenuPlacement = "below-end" | "above-start";

const MENU_POSITION: Record<MenuPlacement, string> = {
  "below-end": "right-0 top-full mt-2",
  "above-start": "left-0 bottom-full mb-2",
};

/**
 * The same control drawn two ways.
 *
 * In the workspace header there is room for the address, the balance and a
 * disconnect button side by side. In the sidebar there is one row, and in the
 * rail a single icon, so the details move into a menu that opens upward.
 */
export type WalletVariant = "header" | "sidebar";

export function ConnectWallet({
  placement = "below-end",
  variant = "header",
  rail = false,
}: {
  placement?: MenuPlacement;
  variant?: WalletVariant;
  /** Sidebar only: draw the icon alone, for the collapsed rail. */
  rail?: boolean;
} = {}) {
  const { connection } = useConnection();
  const {
    wallets,
    wallet,
    publicKey,
    connected,
    connecting,
    select,
    disconnect,
  } = useWallet();

  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [balance, setBalance] = useState<{ address: string; sol: number } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);

  /** Wallets the browser can actually reach. Everything else is an install ad. */
  const installed = wallets.filter(
    (w) => w.readyState === WalletReadyState.Installed,
  );

  const anyOpen = open || details;

  useEffect(() => {
    if (!anyOpen) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setDetails(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        setDetails(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anyOpen]);

  useEffect(() => {
    if (!publicKey) return;

    // Guarded because the address can change while the request is in flight,
    // and a late response for the previous wallet would overwrite the new one.
    let current = true;

    connection
      .getBalance(publicKey)
      .then((lamports) => {
        if (current) {
          setBalance({
            address: publicKey.toBase58(),
            sol: lamports / LAMPORTS_PER_SOL,
          });
        }
      })
      .catch(() => {
        // Left as it was. The address check below already refuses to show a
        // figure that belongs to a different wallet.
      });

    return () => {
      current = false;
    };
  }, [connection, publicKey]);

  /**
   * Derived rather than cleared on disconnect.
   *
   * Wiping the balance from inside an effect would schedule a second render for
   * something already knowable from the address in hand.
   */
  const sol =
    publicKey && balance?.address === publicKey.toBase58() ? balance.sol : null;

  function choose(name: WalletName) {
    select(name);
    setOpen(false);
  }

  const sidebar = variant === "sidebar";
  const position = MENU_POSITION[sidebar ? "above-start" : placement];
  const balanceLabel = `${sol === null ? "balance unavailable" : `${sol.toFixed(3)} SOL`} on ${CLUSTER}`;

  if (connected && publicKey && sidebar) {
    const address = publicKey.toBase58();
    return (
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setDetails((v) => !v)}
          aria-expanded={details}
          aria-haspopup="dialog"
          title={`Wallet ${address}`}
          className={`flex items-center gap-3 rounded-full text-left transition-colors hover:bg-raised ${
            rail ? "mx-auto size-10 justify-center" : "w-full px-2 py-1.5"
          }`}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-raised text-emerald-400">
            <Wallet className="size-4" aria-hidden="true" />
          </span>
          {!rail ? (
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[13px] text-ink">
                {shorten(address)}
              </span>
              <span className="block truncate text-[11px] text-ink-faint">
                {balanceLabel}
              </span>
            </span>
          ) : null}
        </button>

        {details ? (
          <div
            role="dialog"
            aria-label="Connected wallet"
            className={`absolute ${position} z-50 w-72 overflow-hidden rounded-2xl border border-line bg-overlay shadow-menu`}
          >
            <div className="px-4 pb-2 pt-3.5">
              <p className="text-[11px] text-ink-faint">
                Connected with {wallet?.adapter.name ?? "a wallet"}
              </p>
              <a
                href={explorerUrl(address, "address", CLUSTER)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 flex items-start gap-1.5 break-all font-mono text-[12px] leading-relaxed text-ink-muted transition-colors hover:text-ink"
              >
                {address}
                <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              </a>
              <p className="mt-2 text-[12px] text-ink-muted">{balanceLabel}</p>
            </div>
            <div className="p-1.5">
              <button
                type="button"
                onClick={() => {
                  setDetails(false);
                  void disconnect();
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink"
              >
                <LogOut className="size-4" aria-hidden="true" />
                Disconnect
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (connected && publicKey) {
    return (
      <div className="flex items-center gap-3">
        <div className="text-right">
          <a
            href={explorerUrl(publicKey.toBase58(), "address", CLUSTER)}
            target="_blank"
            rel="noopener noreferrer"
            className="block font-mono text-sm text-zinc-100 underline-offset-4 hover:underline"
          >
            {shorten(publicKey.toBase58())}
          </a>
          <span className="block text-xs text-zinc-500">
            {sol === null ? "balance unavailable" : `${sol.toFixed(3)} SOL`}
            {" on "}
            {CLUSTER}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void disconnect()}
          className="flex items-center gap-2 rounded-full border border-line px-3.5 py-1.5 text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <LogOut className="size-3.5" aria-hidden="true" />
          Disconnect
        </button>
      </div>
    );
  }

  const connectLabel = connecting
    ? `Connecting to ${wallet?.adapter.name ?? "wallet"}`
    : "Connect wallet";

  return (
    <div ref={containerRef} className="relative">
      {sidebar ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={connecting}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={connectLabel}
          title={connectLabel}
          className={`flex items-center justify-center gap-2 rounded-full bg-ink text-sm font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60 ${
            rail ? "mx-auto size-10" : "w-full px-4 py-2.5"
          }`}
        >
          <Wallet className="size-4 shrink-0" aria-hidden="true" />
          {!rail ? <span className="truncate">{connectLabel}</span> : null}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={connecting}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          <Wallet className="size-4 shrink-0" aria-hidden="true" />
          {connectLabel}
        </button>
      )}

      {open ? (
        <div
          role="menu"
          className={`absolute ${position} z-50 w-64 overflow-hidden rounded-2xl border border-line bg-overlay p-1.5 shadow-menu`}
        >
          {installed.length === 0 ? (
            <p className="px-2.5 py-2 text-sm leading-relaxed text-ink-muted">
              No Solana wallet detected in this browser. Install{" "}
              <a
                href="https://phantom.app/download"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2"
              >
                Phantom
              </a>{" "}
              or{" "}
              <a
                href="https://solflare.com/download"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline underline-offset-2"
              >
                Solflare
              </a>
              , then reload.
            </p>
          ) : (
            installed.map(({ adapter }) => (
              <button
                key={adapter.name}
                type="button"
                role="menuitem"
                onClick={() => choose(adapter.name)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-ink transition-colors hover:bg-raised"
              >
                {adapter.icon ? (
                  // Wallet icons are data URIs supplied by the extension, so
                  // next/image cannot optimise them and should not try.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={adapter.icon} alt="" width={20} height={20} />
                ) : null}
                {adapter.name}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
