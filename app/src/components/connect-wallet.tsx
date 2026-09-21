"use client";

import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import type { WalletName } from "@solana/wallet-adapter-base";

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

export function ConnectWallet() {
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
  const [balance, setBalance] = useState<{ address: string; sol: number } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);

  /** Wallets the browser can actually reach. Everything else is an install ad. */
  const installed = wallets.filter(
    (w) => w.readyState === WalletReadyState.Installed,
  );

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

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
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={connecting}
        aria-expanded={open}
        aria-haspopup="menu"
        className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60"
      >
        {connecting ? `Connecting to ${wallet?.adapter.name ?? "wallet"}` : "Connect wallet"}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-64 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl"
        >
          {installed.length === 0 ? (
            <p className="px-4 py-3 text-sm leading-relaxed text-zinc-400">
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
                className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-900"
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
