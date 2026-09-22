"use client";

import { useRef, useState } from "react";

/**
 * The input.
 *
 * Enter sends and shift with enter breaks a line, which is what every other
 * chat does and therefore what hands expect. The box grows with the text up to
 * a point, because a mandate objective written properly is three or four lines
 * and typing it into a single row is miserable.
 */

const SUGGESTIONS = [
  "What am I holding, and how close am I to my limits?",
  "Where is the widest discount to underlying right now?",
  "Put my cash to work, but nothing reckless.",
  "Show me every time the program refused a trade.",
];

export function Composer({
  busy,
  onSend,
  onStop,
  showSuggestions,
}: {
  busy: boolean;
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
    if (!question || busy) return;
    onSend(question);
    setValue("");
    requestAnimationFrame(grow);
  }

  return (
    <div className="border-t border-zinc-900 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6">
        {showSuggestions ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => submit(s)}
                className="rounded-full border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 focus-within:border-zinc-600">
          <textarea
            ref={box}
            rows={1}
            value={value}
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
            placeholder="Ask about the market, your positions, or your mandate"
            className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-700 text-zinc-100 transition-colors hover:bg-zinc-600"
            >
              <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit()}
              disabled={value.trim().length === 0}
              title="Send"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-black transition-colors hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                <path
                  d="M8 13V3M8 3L4 7M8 3l4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>

        <p className="mt-2 text-center text-[10px] text-zinc-700">
          Research, not financial advice. Devnet. Every limit is enforced by the
          program, not by this interface.
        </p>
      </div>
    </div>
  );
}
