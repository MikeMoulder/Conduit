"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";

import { bpsToPercent, extractProgramError } from "@/lib/chain";
import { confirmSignature } from "@/lib/confirm";
import { createMandateInstructions, setStatusInstruction } from "@/lib/mandate-tx";
import { useConduitProgram } from "@/hooks/use-conduit-program";
import type { Card, PendingAction } from "@/lib/copilot/events";
import { AssetBadge, CardView } from "./cards";

/**
 * The approval step.
 *
 * Every write the copilot can reach arrives here first. It never happens
 * because a sentence asked for it; it happens because somebody read a card and
 * pressed a button.
 *
 * Which key signs is the interesting part, and the card says so plainly rather
 * than hiding it behind one uniform button. A rebalance is signed by the agent,
 * which is the one thing the agent is allowed to do. Creating a mandate, or
 * pausing one, is signed by the owner, because the agent has no way to reach
 * those instructions at all. That difference is the architecture, and this is
 * the first screen where a person can see it.
 */

type Phase =
  | { state: "idle" }
  | { state: "working"; note: string }
  | { state: "done"; card: Card }
  | { state: "failed"; message: string }
  | { state: "dismissed" };

export function ActionCard({
  action,
  onSettled,
}: {
  action: PendingAction;
  onSettled: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ state: "idle" });
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const program = useConduitProgram();

  if (phase.state === "dismissed") return null;
  if (phase.state === "done") return <CardView card={phase.card} />;

  const signer = action.kind === "submit-rebalance" ? "the agent" : "your wallet";
  const dangerous =
    action.kind === "submit-rebalance" && !action.evaluation.compliant;
  const permanent = action.kind === "set-status" && action.status === "closed";

  async function approve() {
    try {
      if (action.kind === "submit-rebalance") {
        setPhase({ state: "working", note: "The agent is signing" });

        const response = await fetch("/api/agent/rebalance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mandate: action.mandate,
            positions: action.positions.map((p) => ({
              mint: p.mint,
              targetBps: p.targetBps,
            })),
          }),
        });

        const data = await response.json();
        setPhase({
          state: "done",
          card: {
            kind: "submission",
            submission: {
              accepted: Boolean(data.accepted),
              signature: data.signature ?? null,
              slot: data.slot ?? null,
              programError: data.programError ?? null,
              detail: data.detail ?? data.error ?? null,
            },
          },
        });
        onSettled();
        return;
      }

      // Everything below is signed by the owner, so it needs a wallet rather
      // than a route.
      if (!program || !publicKey) {
        setPhase({
          state: "failed",
          message: "Connect a wallet first. Only the owner can sign this.",
        });
        return;
      }

      setPhase({ state: "working", note: "Waiting for your signature" });

      const instructions =
        action.kind === "create-mandate"
          ? (await createMandateInstructions(program, publicKey, action.draft))
              .instructions
          : [
              await setStatusInstruction(
                program,
                publicKey,
                new PublicKey(action.mandate),
                action.status,
              ),
            ];

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const transaction = new Transaction({
        feePayer: publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...instructions);

      const signature = await sendTransaction(transaction, connection);
      setPhase({ state: "working", note: "Confirming on chain" });

      const outcome = await confirmSignature(connection, signature, {
        lastValidBlockHeight,
      });

      setPhase({
        state: "done",
        card: {
          kind: "submission",
          submission: {
            accepted: outcome.status === "confirmed",
            signature,
            slot: outcome.status === "confirmed" ? outcome.slot : null,
            programError:
              outcome.status === "failed"
                ? extractProgramError(outcome.error)
                : null,
            detail:
              outcome.status === "expired"
                ? "The transaction expired without landing. Nothing was created and it cannot be replayed."
                : outcome.status === "unknown"
                  ? "No result within the wait. It may still land, so check the explorer before retrying."
                  : null,
          },
        },
      });
      onSettled();
    } catch (error) {
      const programError = extractProgramError(error);
      setPhase({
        state: "failed",
        message:
          programError?.message ??
          (error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border ${
        dangerous || permanent
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-emerald-500/30 bg-emerald-500/5"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-white/5 px-4 py-2.5">
        <span className="text-[11px] uppercase tracking-wider text-zinc-400">
          {action.kind === "create-mandate"
            ? "Create this mandate"
            : action.kind === "submit-rebalance"
              ? "Submit this rebalance"
              : `Set the mandate to ${action.status}`}
        </span>
        <span className="font-mono text-[11px] text-zinc-500">
          signed by {signer}
        </span>
      </div>

      <p className="px-4 py-3 text-sm leading-relaxed text-zinc-300">
        {action.summary}
      </p>

      {action.kind === "submit-rebalance" ? (
        <div className="border-t border-white/5 px-4 py-2.5">
          {action.positions.map((p) => (
            <div
              key={p.mint}
              className="flex items-center justify-between gap-3 py-1"
            >
              <AssetBadge symbol={p.symbol} />
              <span className="flex items-baseline gap-2 font-mono text-sm">
                {p.currentBps !== p.targetBps ? (
                  <span className="text-[11px] text-zinc-600">
                    {bpsToPercent(p.currentBps)} to
                  </span>
                ) : null}
                <span className="text-zinc-100">
                  {bpsToPercent(p.targetBps)}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {phase.state === "failed" ? (
        <p className="border-t border-white/5 px-4 py-2.5 text-sm text-red-300">
          {phase.message}
        </p>
      ) : null}

      <div className="flex items-center gap-2 border-t border-white/5 px-4 py-2.5">
        <button
          type="button"
          onClick={() => void approve()}
          disabled={phase.state === "working"}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-wait disabled:opacity-60 ${
            dangerous || permanent
              ? "bg-amber-500 text-black hover:bg-amber-400"
              : "bg-emerald-500 text-black hover:bg-emerald-400"
          }`}
        >
          {phase.state === "working"
            ? phase.note
            : dangerous
              ? "Send it and let the chain refuse"
              : permanent
                ? "Close permanently"
                : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => {
            setPhase({ state: "dismissed" });
            onSettled();
          }}
          disabled={phase.state === "working"}
          className="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
