import { useSyncExternalStore } from "react";

import type { WalletCard } from "./copilot/events";

/**
 * Which overlay is open: the stock page for one symbol, the portfolio panel,
 * or neither.
 *
 * Kept outside React like the conversation store, because a stock can be
 * opened from a welcome card, a brief in the chat, a holding in the wallet
 * card or a row in the portfolio panel, and threading a callback through
 * every one of those components would touch most of the chat for one click.
 */

interface Sheets {
  stock: string | null;
  portfolio: boolean;
  /** Bumped each time the portfolio opens, so it reads fresh numbers. */
  portfolioOpenedAt: number;
}

let state: Sheets = { stock: null, portfolio: false, portfolioOpenedAt: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<Sheets>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER: Sheets = { stock: null, portfolio: false, portfolioOpenedAt: 0 };

export function useSheets(): Sheets {
  return useSyncExternalStore(subscribe, () => state, () => SERVER);
}

export function openStock(symbol: string): void {
  set({ stock: symbol.toUpperCase() });
}

export function closeStock(): void {
  set({ stock: null });
}

export function openPortfolio(): void {
  set({ portfolio: true, portfolioOpenedAt: Date.now() });
}

export function closePortfolio(): void {
  set({ portfolio: false });
}

/**
 * The dollar move today, from each holding's value now and its percent change:
 * what it was worth a day ago is value / (1 + change), and the move is the
 * difference. Null when no holding has a day line.
 */
export function todayMove(wallet: Pick<WalletCard, "holdings">): number | null {
  const moves = wallet.holdings
    .filter((h) => h.value !== null && h.changePct !== undefined && h.changePct !== null)
    .map((h) => h.value! - h.value! / (1 + h.changePct! / 100));
  return moves.length === 0 ? null : moves.reduce((a, b) => a + b, 0);
}
