"use client";

import { useEffect, useRef, useState } from "react";

import type { Source } from "@/lib/copilot/events";
import type { Step, Turn } from "@/lib/copilot/store";
import { resolveAction } from "@/lib/copilot/store";
import { ActionCard } from "./actions";
import { CardView } from "./cards";
import { Markdown } from "./markdown";

/**
 * The conversation.
 *
 * The step list is not a loading animation. It is the answer to the question
 * anyone should ask a system like this: what did you actually do before telling
 * me that. Each line names a tool, how long it took and what it found, and the
 * sources strip underneath names the providers the figures came from. An
 * assistant that reports a number without saying where it got it is asking to
 * be trusted, and this one would rather be checked.
 */

export function Thread({
  turns,
  onRefresh,
  onEvent,
}: {
  turns: Turn[];
  onRefresh: () => void;
  /** Sends a card's outcome to the copilot, so it can say what is next. */
  onEvent: (message: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  /**
   * Follows the answer while it streams, unless the reader has scrolled up to
   * look at something, in which case being yanked back down is infuriating.
   */
  useEffect(() => {
    if (pinned.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  });

  return (
    <div
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      className="flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        {turns.map((turn) =>
          turn.role === "user" && turn.event ? (
            <EventLine key={turn.id} text={turn.text} />
          ) : turn.role === "user" ? (
            <div key={turn.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-800/80 px-4 py-2.5 text-sm leading-relaxed text-zinc-100">
                {turn.text}
              </p>
            </div>
          ) : (
            <AssistantTurn
              key={turn.id}
              turn={turn}
              onRefresh={onRefresh}
              onEvent={onEvent}
            />
          ),
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function AssistantTurn({
  turn,
  onRefresh,
  onEvent,
}: {
  turn: Turn;
  onRefresh: () => void;
  onEvent: (message: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {turn.steps.length > 0 ? (
        <StepList steps={turn.steps} streaming={turn.streaming} />
      ) : null}

      {turn.sources.length > 0 ? <Sources sources={turn.sources} /> : null}

      {turn.cards.map((card, i) => (
        <CardView key={i} card={card} />
      ))}

      {turn.text ? <Markdown text={turn.text} /> : null}

      {(turn.outcomes ?? []).map((card, i) => (
        <CardView key={`outcome-${i}`} card={card} />
      ))}

      {turn.actions.map((action) => (
        <ActionCard
          // Keyed by content, not position. Resolving the first of two cards
          // used to shift the second into the first one's slot, and with it
          // the first one's state.
          key={`${action.kind}:${action.summary}`}
          action={action}
          onResolved={(outcome, message) => {
            resolveAction(turn.id, action, outcome);
            onRefresh();
            if (message) onEvent(message);
          }}
        />
      ))}

      {(turn.expired ?? []).length > 0 ? (
        <p className="rounded-lg border border-zinc-800 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
          {turn.expired!.length === 1 ? "An approval card" : "Approval cards"} for{" "}
          <span className="text-zinc-300">{turn.expired!.join(", ")}</span>{" "}
          expired when the page reloaded, because an approval should not outlive
          the moment it was offered. Ask again and it will be prepared fresh.
        </p>
      ) : null}

      {turn.error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
          <p className="text-sm text-red-300">{turn.error.message}</p>
          {turn.error.detail ? (
            <p className="mt-1 text-[11px] leading-relaxed text-red-200/60">
              {turn.error.detail}
            </p>
          ) : null}
        </div>
      ) : null}

      {turn.meta && !turn.streaming ? (
        <p className="font-mono text-[10px] text-zinc-700">
          {turn.meta.toolCalls} tool
          {turn.meta.toolCalls === 1 ? "" : "s"} ·{" "}
          {(turn.meta.totalMs / 1000).toFixed(1)}s · {turn.meta.model}
        </p>
      ) : null}

      {turn.streaming && turn.steps.length === 0 && !turn.text ? (
        <p className="text-sm text-zinc-600">Thinking.</p>
      ) : null}
    </div>
  );
}

function StepList({
  steps,
  streaming,
}: {
  steps: Step[];
  streaming: boolean;
}) {
  /**
   * Null means nobody has expressed a preference, so the default applies: open
   * while the answer is being worked out, folded away once it has landed, since
   * the steps are supporting evidence rather than the main event by then.
   *
   * Derived rather than flipped in an effect. An effect would fight the reader,
   * collapsing the list under them the instant the answer arrived even if they
   * had just opened it.
   */
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? streaming;
  const setOpen = (next: boolean) => setOverride(next);

  const failed = steps.filter((s) => s.state === "failed").length;

  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500">
          {streaming ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          ) : null}
          {streaming ? "Working" : `${steps.length} steps`}
          {failed > 0 ? (
            <span className="text-amber-500/80">
              · {failed} unavailable
            </span>
          ) : null}
        </span>
        <span className="text-[11px] text-zinc-600">{open ? "hide" : "show"}</span>
      </button>

      {open ? (
        <ol className="flex flex-col gap-1.5 border-t border-zinc-900 px-4 py-3">
          {steps.map((step) => (
            <li key={step.id} className="flex items-baseline gap-2.5 text-xs">
              <Mark state={step.state} />
              <span className="flex flex-1 flex-wrap items-baseline gap-x-2">
                <span
                  className={
                    step.state === "failed" ? "text-amber-400" : "text-zinc-300"
                  }
                >
                  {step.label}
                </span>
                {step.name ? (
                  <span className="font-mono text-[10px] text-zinc-600">
                    {step.name}
                  </span>
                ) : null}
                {step.summary ? (
                  <span className="text-zinc-500">{step.summary}</span>
                ) : null}
                {step.detail ? (
                  <span className="text-zinc-600">{step.detail}</span>
                ) : null}
                {step.error ? (
                  <span className="basis-full text-[11px] leading-relaxed text-amber-400/70">
                    {step.error}
                  </span>
                ) : null}
              </span>
              {step.durationMs !== undefined ? (
                <span className="font-mono text-[10px] text-zinc-700">
                  {step.durationMs}ms
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function Mark({ state }: { state: Step["state"] }) {
  if (state === "running") {
    return (
      <span className="mt-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
    );
  }
  if (state === "failed") {
    return <span className="shrink-0 text-amber-500">!</span>;
  }
  return <span className="shrink-0 text-emerald-500">✓</span>;
}

function Sources({ sources }: { sources: Source[] }) {
  // The same provider answers several tools in one turn. Saying so once is
  // enough, and repeating it buries the one that degraded.
  const seen = new Map<string, Source>();
  for (const source of sources) {
    const existing = seen.get(source.provider);
    if (!existing || (existing.ok && !source.ok)) seen.set(source.provider, source);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-zinc-900 bg-zinc-950/60 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600">
        sources
      </span>
      {[...seen.values()].map((source) => (
        <span
          key={source.provider}
          className="flex items-baseline gap-1.5 text-[11px]"
        >
          <span
            className={`inline-block h-1 w-1 rounded-full ${
              source.ok ? "bg-emerald-500" : "bg-amber-500"
            }`}
          />
          <span className="font-mono text-zinc-400">{source.provider}</span>
          <span className="text-zinc-600">{source.detail}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * A card's outcome, reported to the copilot.
 *
 * It is sent as a message so the copilot can answer it, but the person did not
 * type it, so it is not drawn as their bubble. A status line says what it is.
 */
function EventLine({ text }: { text: string }) {
  const shown = text.replace(/^\[Card result\]\s*/, "");
  const failed = /: (failed|refused|not settled)/.test(shown);
  return (
    <div className="flex items-center gap-2 text-[11px] text-zinc-500">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? "bg-red-400" : "bg-emerald-400"}`}
      />
      <span className="truncate">{shown.split(". ").slice(0, 2).join(". ")}</span>
    </div>
  );
}
