import { Connection, PublicKey } from "@solana/web3.js";

import { PROGRAM_ID } from "./chain";
import { desk, fetchBalances, type DeskAsset, type PortfolioHoldings } from "./holdings";
import { codecProgram } from "./program-client";

/**
 * A person's main wallet: where the agent trades on their word.
 *
 * The address is derived from the owner's key, so anyone can work out where a
 * person's main wallet is, and there is exactly one. Nobody holds a private key
 * for it. The program decides where money in it may go: to the desk and back
 * at the published price, into the same owner's mandates, or to the owner.
 *
 * Shared by the server, which acts on it with the agent key, and the browser,
 * which builds the owner's one signature to open it and their deposits into it.
 */

export function walletAddress(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), owner.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** The desk's binding of a mint to the feed it trades at. */
export function deskAssetAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("desk_asset"), mint.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export interface MainWalletView {
  address: string;
  owner: string;
  agent: string;
  createdAt: number;
}

export async function fetchMainWallet(
  connection: Connection,
  owner: PublicKey,
): Promise<MainWalletView | null> {
  const address = walletAddress(owner);
  const account = await connection.getAccountInfo(address);
  if (!account || !account.owner.equals(PROGRAM_ID)) return null;

  try {
    const decoded = codecProgram.coder.accounts.decode("mainWallet", account.data) as {
      owner: PublicKey;
      agent: PublicKey;
      createdAt: { toNumber(): number };
    };
    return {
      address: address.toBase58(),
      owner: decoded.owner.toBase58(),
      agent: decoded.agent.toBase58(),
      createdAt: decoded.createdAt.toNumber(),
    };
  } catch {
    return null;
  }
}

/** Every asset the desk trades, which is everything a main wallet can hold. */
export function tradableAssets(): DeskAsset[] {
  return desk.settleable;
}

/** Balances in a main wallet, or in a person's own wallet, across the desk. */
export async function fetchWalletBalances(
  connection: Connection,
  holder: PublicKey,
): Promise<PortfolioHoldings> {
  return {
    settleable: true,
    ...(await fetchBalances(connection, holder, tradableAssets())),
  };
}
