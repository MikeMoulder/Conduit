import type { Connection, TransactionSignature } from "@solana/web3.js";

/**
 * Transaction confirmation by polling.
 *
 * web3.js normally confirms over a websocket subscription. Our RPC goes through
 * a same origin HTTP proxy so the endpoint key stays on the server, and a proxy
 * cannot carry that socket. Calling `confirmTransaction` here would hang until
 * it timed out and then report a perfectly good transaction as failed.
 *
 * So confirmation asks. It is a few more requests than a subscription and it is
 * honest about what it knows, which matters more here: the interface has to be
 * able to say a transaction landed, was refused, or is simply not known yet,
 * and treat those as three different things rather than one failure.
 */

export type ConfirmOutcome =
  /** The transaction landed and the program returned success. */
  | { status: "confirmed"; slot: number }
  /** It landed and the program refused it. `error` carries the program error. */
  | { status: "failed"; error: unknown }
  /**
   * Its blockhash expired without it ever landing. This one is safe: a
   * transaction past its last valid block height can never be replayed.
   */
  | { status: "expired" }
  /**
   * Nothing conclusive within the deadline. Deliberately not reported as a
   * failure, because a transaction that is merely slow may still land, and
   * telling someone their mandate was not created when it was is the worst
   * answer available.
   */
  | { status: "unknown" };

export interface ConfirmOptions {
  /**
   * From the same `getLatestBlockhash` used to build the transaction. Without
   * it, expiry cannot be detected and a dropped transaction can only time out.
   */
  lastValidBlockHeight?: number;
  pollMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function confirmSignature(
  connection: Connection,
  signature: TransactionSignature,
  options: ConfirmOptions = {},
): Promise<ConfirmOutcome> {
  const pollMs = options.pollMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];

    if (status) {
      if (status.err) {
        return { status: "failed", error: status.err };
      }
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return { status: "confirmed", slot: status.slot };
      }
      // Seen but only `processed`. Keep waiting rather than report success, as
      // a processed transaction can still be dropped on a fork.
    } else if (options.lastValidBlockHeight !== undefined) {
      // Only meaningful while the status is still null. Once a transaction is
      // seen, the block height it was sent under stops mattering.
      const height = await connection.getBlockHeight();
      if (height > options.lastValidBlockHeight) {
        return { status: "expired" };
      }
    }

    await sleep(pollMs, options.signal);
  }

  return { status: "unknown" };
}
