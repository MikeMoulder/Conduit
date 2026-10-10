"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Plus, Square, Wallet } from "lucide-react";

import { openPortfolio } from "@/lib/ui-sheets";

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
 *
 * Shaped like the input of the chat apps people already use: one 56 px pill,
 * a plus on the left for quick starts, the text, and a round send button on
 * the right. When the text runs past one line the pill grows into a rounded
 * box, with the buttons staying on the bottom line. The text is 16 px, which
 * also stops a phone from zooming in when the box is tapped.
 */

/** Things a first timer would actually type, in the words they would type them. */
const SUGGESTIONS = [
  "How's NVIDIA doing today?",
  "Buy $50 of Apple",
  "Ping me if Tesla drops 3%",
  "What can you do?",
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
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The quick start menu closes on a click outside it or on Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

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
    <div className="relative">
      {/* The thread scrolls under here, so it fades out instead of being cut. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-canvas to-transparent"
      />
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
          className={`relative flex items-end gap-1 rounded-[28px] border border-line bg-raised p-2.5 transition-colors focus-within:border-line-strong ${
            locked ? "opacity-60" : ""
          }`}
        >
          <div ref={menuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMenu((open) => !open)}
              aria-label="Quick starts"
              aria-expanded={menu}
              title="Quick starts"
              className="grid size-9 place-items-center rounded-full text-ink-muted transition-colors hover:bg-overlay hover:text-ink"
            >
              <Plus className="size-5" aria-hidden="true" />
            </button>
            {menu ? (
              <div
                role="menu"
                className="absolute bottom-full left-0 z-20 mb-3 w-64 rounded-2xl border border-line bg-surface p-1.5 shadow-menu animate-[rise-in_0.15s_ease-out_both]"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    openPortfolio();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-raised"
                >
                  <Wallet className="size-4 text-ink-muted" aria-hidden="true" />
                  Your money
                </button>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="menuitem"
                    disabled={locked || busy}
                    onClick={() => {
                      setMenu(false);
                      submit(s);
                    }}
                    className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
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
                ? "Connect a wallet to start"
                : "Text me what you want"
            }
            className="max-h-[200px] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-base leading-6 text-ink placeholder:text-ink-ghost focus:outline-none disabled:cursor-not-allowed"
          />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-overlay text-ink-muted transition-colors hover:text-ink"
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
              className="grid size-9 shrink-0 place-items-center rounded-full bg-ink text-canvas transition-opacity hover:opacity-90 disabled:opacity-25"
            >
              <ArrowUp className="size-5" aria-hidden="true" />
            </button>
          )}
        </div>

        <p className="mt-2 text-center text-[10px] text-ink-faint">
          Not financial advice. Test money on devnet. Your limits are enforced
          by Solana, not by this app.
        </p>
      </div>
    </div>
  );
}
