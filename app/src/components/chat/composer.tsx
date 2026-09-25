"use client";

import { useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";

/**
 * The input.
 *
 * Enter sends and shift with enter breaks a line, which is what every other
 * chat does and therefore what hands expect. The box grows with the text up to
 * a point, because a mandate objective written properly is three or four lines
 * and typing it into a single row is miserable.
 *
 * Nothing can be sent without a connected wallet. Every answer is about the
 * person's own mandate and positions, so asking before there is an owner to
 * read would only produce an answer about nobody.
 */

const SUGGESTIONS = [
  "What am I holding, and how close am I to my limits?",
  "Where is the widest discount to underlying right now?",
  "Put my cash to work, but nothing reckless.",
  "Show me every time the program refused a trade.",
];

export function Composer({
  busy,
  locked,
  onSend,
  onStop,
  showSuggestions,
}: {
  busy: boolean;
  /** True while no wallet is connected. Typing and sending are both off. */
  locked: boolean;
  onSend: (question: string) => void;
  onStop: () => void;
  showSuggestions: boolean;
}) {
  const [value, setValue] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  function grow() {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function submit(text?: string) {
    const question = (text ?? value).trim();
    if (!question || busy || locked) return;
    onSend(question);
    setValue("");
    requestAnimationFrame(grow);
  }

  return (
    <div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-2 sm:px-6">
        {showSuggestions ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => submit(s)}
                disabled={locked}
                className="rounded-full border border-line bg-canvas/70 px-3.5 py-1.5 text-xs backdrop-blur-sm text-ink-muted transition-colors hover:border-line-strong hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <div
          className={`flex items-end gap-2 rounded-[20px] border border-line bg-raised px-3 py-2.5 transition-colors focus-within:border-line-strong ${
            locked ? "opacity-60" : ""
          }`}
        >
          <label htmlFor="conduit-input" className="sr-only">
            Ask Conduit
          </label>
          <textarea
            id="conduit-input"
            ref={box}
            rows={1}
            value={value}
            disabled={locked}
            onChange={(e) => {
              setValue(e.target.value);
              grow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              locked
                ? "Connect a wallet to start asking"
                : "Ask about the market, your positions, or your mandate"
            }
            className="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-1 py-1 disabled:cursor-not-allowed text-sm leading-relaxed text-ink placeholder:text-ink-ghost focus:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-overlay text-ink-muted transition-colors hover:text-ink"
            >
              <Square className="size-3 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit()}
              disabled={locked || value.trim().length === 0}
              aria-label="Send"
              title="Send"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-canvas transition-opacity hover:opacity-90 disabled:opacity-25"
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <p className="mt-2 text-center text-[10px] text-ink-faint">
          Research, not financial advice. Devnet. Every limit is enforced by the
          program, not by this interface.
        </p>
      </div>
    </div>
  );
}
