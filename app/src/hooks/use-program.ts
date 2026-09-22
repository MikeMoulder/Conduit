"use client";

import { useMemo } from "react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";

import idl from "@/lib/idl/stockpilot.json";
import type { Stockpilot } from "@/lib/idl/stockpilot";

/**
 * The CONDUIT program, bound to the connected wallet.
 *
 * Null until a wallet is connected, because every instruction this interface
 * builds is signed by the owner. There is nothing useful to hand back before
 * then, and returning a half usable object invites a call that fails later
 * rather than here.
 *
 * Only `.instruction()` and account decoding are used from this. The provider
 * would happily send and confirm a transaction as well, but its confirmation
 * path opens a websocket, and the RPC proxy that keeps the endpoint key on the
 * server is HTTP only. Sending goes through the wallet and confirmation goes
 * through `confirmSignature`.
 */
export function useStockpilotProgram(): Program<Stockpilot> | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!wallet) return null;

    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });

    return new Program(idl as Stockpilot, provider);
  }, [connection, wallet]);
}
