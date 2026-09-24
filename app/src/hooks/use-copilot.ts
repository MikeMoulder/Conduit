"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import { readCopilotStream } from "@/lib/copilot/stream";
import {
  beginTurn,
  currentConversation,
  deleteConversation,
  finishTurn,
  getServerSnapshot,
  getSnapshot,
  hydrate,
  newConversation,
  patchTurn,
  selectConversation,
  subscribe,
  type Step,
} from "@/lib/copilot/store";

/**
 * Drives one conversation with the copilot.
 *
 * Thread state lives in the store rather than in this hook. What lives here is
 * the request: opening it, translating the stream into the shape the thread
 * holds, and making sure only one is ever in flight.
 */

let stepCounter = 0;
const stepId = () => `s${(stepCounter += 1)}`;

export function useCopilot() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { publicKey } = useWallet();
  const abort = useRef<AbortController | null>(null);

  // Reading a browser store on mount is what effects are for. The store owns
  // the value; nothing is being mirrored into component state here.
  useEffect(() => {
    hydrate();
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
  }, []);

  /**
   * Card outcomes waiting for the copilot to be free.
   *
   * A card can finish while an answer is still streaming. Dropping its outcome
   * would break the promise that every approval gets a reply, so it waits here
   * and goes as soon as the current answer ends.
   */
  const queued = useRef<string[]>([]);
  const sendRef = useRef<(question: string, options?: { event?: boolean }) => Promise<void>>(
    async () => {},
  );

  const send = useCallback(
    async (question: string, options: { event?: boolean } = {}) => {
      const trimmed = question.trim();
      if (trimmed.length === 0) return;
      if (getSnapshot().busy) {
        if (options.event) queued.current.push(trimmed);
        return;
      }

      const { turnId } = beginTurn(trimmed, { event: options.event });

      // Read back after opening the turn, so the question just asked is part of
      // what the model is given rather than arriving a turn late.
      const conversation = currentConversation();
      const messages = (conversation?.turns ?? [])
        .filter((t) => t.text.trim().length > 0)
        .map((t) => ({ role: t.role, content: t.text }));

      const controller = new AbortController();
      abort.current = controller;

      /** Earlier status lines stop spinning as soon as something follows them. */
      const settleStatuses = (steps: Step[]): Step[] =>
        steps.map((s) =>
          s.state === "running" && !s.name ? { ...s, state: "ok" } : s,
        );

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages,
            owner: publicKey?.toBase58() ?? null,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text();
          patchTurn(turnId, (turn) => ({
            ...turn,
            error: {
              message: "The copilot could not be reached.",
              detail: detail.slice(0, 300),
            },
          }));
          return;
        }

        await readCopilotStream(
          response,
          (event) => {
            switch (event.type) {
              case "status":
                patchTurn(turnId, (turn) => ({
                  ...turn,
                  steps: [
                    ...settleStatuses(turn.steps),
                    {
                      id: stepId(),
                      label: event.label,
                      detail: event.detail,
                      state: "running",
                    },
                  ],
                }));
                break;

              case "tool_start":
                patchTurn(turnId, (turn) => ({
                  ...turn,
                  steps: [
                    ...settleStatuses(turn.steps),
                    {
                      id: event.id,
                      name: event.name,
                      label: event.label,
                      state: "running",
                    },
                  ],
                }));
                break;

              case "tool_end":
                patchTurn(turnId, (turn) => ({
                  ...turn,
                  steps: turn.steps.map((s) =>
                    s.id === event.id
                      ? {
                          ...s,
                          state: event.ok ? "ok" : "failed",
                          durationMs: event.durationMs,
                          summary: event.summary,
                          error: event.error,
                        }
                      : s,
                  ),
                  cards: event.card ? [...turn.cards, event.card] : turn.cards,
                  sources: event.sources
                    ? [...turn.sources, ...event.sources]
                    : turn.sources,
                }));
                break;

              case "text":
                patchTurn(turnId, (turn) => ({
                  ...turn,
                  steps: settleStatuses(turn.steps),
                  text: turn.text + event.delta,
                }));
                break;

              case "action":
                patchTurn(turnId, (turn) => ({
                  ...turn,
                  actions: [...turn.actions, event.action],
                }));
                break;

              case "done":
                patchTurn(turnId, (turn) => ({
                  ...turn,
                  steps: settleStatuses(turn.steps),
                  meta: {
                    model: event.model,
                    totalMs: event.totalMs,
                    toolCalls: event.toolCalls,
                  },
                }));
                break;

              case "error":
                patchTurn(turnId, (turn) => ({
                  ...turn,
                  steps: settleStatuses(turn.steps),
                  error: { message: event.message, detail: event.detail },
                }));
                break;
            }
          },
          controller.signal,
        );
      } catch (error) {
        // Aborting is a choice somebody made, not a failure to report.
        if (!controller.signal.aborted) {
          patchTurn(turnId, (turn) => ({
            ...turn,
            error: {
              message: "The connection dropped mid answer.",
              detail: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      } finally {
        finishTurn(turnId);
        if (abort.current === controller) abort.current = null;

        const next = queued.current.shift();
        if (next) {
          // After this turn has fully closed, so the queued outcome opens a
          // turn of its own rather than landing inside this one.
          setTimeout(() => void sendRef.current(next, { event: true }), 0);
        }
      }
    },
    [publicKey],
  );

  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  return {
    conversations: state.conversations,
    conversation:
      state.conversations.find((c) => c.id === state.currentId) ?? null,
    hydrated: state.hydrated,
    busy: state.busy,
    send,
    stop,
    newChat: newConversation,
    select: selectConversation,
    remove: deleteConversation,
  };
}
