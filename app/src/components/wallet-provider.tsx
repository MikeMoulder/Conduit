"use client";

import { useCallback, useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import type { Adapter, WalletError } from "@solana/wallet-adapter-base";

import { rpcEndpoint } from "@/lib/cluster";

/**
 * Wallet and connection context for the whole interface.
 *
 * The owner is the only party who can create a mandate or change its status, so
 * the wallet is not a convenience here. It is the mechanism by which authority
 * stays with the person rather than with the agent. The agent signs with its own
 * keypair and can only reach `propose_rebalance`.
 */

/**
 * No adapters are listed.
 *
 * Modern wallets announce themselves through the Wallet Standard, and the
 * provider picks up whatever is actually installed. Hard coding a list would
 * ship bundles for wallets nobody here uses and would silently exclude any
 * wallet added after this file was written.
 */
const ADAPTERS: Adapter[] = [];

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => rpcEndpoint(), []);
  const [lastError, setLastError] = useState<string | null>(null);

  /**
   * Wallet errors are surfaced, not swallowed.
   *
   * The default behaviour logs to the console, which means a user who declines a
   * signature or has a locked wallet sees a button that simply does nothing.
   */
  const onError = useCallback((error: WalletError) => {
    setLastError(error.message || error.name);
  }, []);

  const config = useMemo(
    () => ({
      /**
       * `confirmed` is the right level for an interface. `finalized` adds
       * roughly half a minute of waiting for a guarantee that nothing here
       * depends on, and `processed` can report a state that later disappears.
       */
      commitment: "confirmed" as const,
      /**
       * Transaction confirmation is done by polling `getSignatureStatuses`.
       * Subscriptions are websocket only and the RPC proxy is HTTP, so no
       * socket is opened and none is needed.
       */
      disableRetryOnRateLimit: false,
    }),
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint} config={config}>
      <WalletProvider wallets={ADAPTERS} autoConnect onError={onError}>
        {lastError ? (
          <div
            role="alert"
            className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-200"
          >
            Wallet: {lastError}
            <button
              type="button"
              onClick={() => setLastError(null)}
              className="ml-3 underline underline-offset-2 opacity-70 hover:opacity-100"
            >
              dismiss
            </button>
          </div>
        ) : null}
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
