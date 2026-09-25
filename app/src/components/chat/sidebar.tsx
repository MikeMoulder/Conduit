"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import { PanelLeftClose, Plus, Search, X } from "lucide-react";

import type { Conversation } from "@/lib/copilot/store";

/**
 * Conversations.
 *
 * Everything Conduit does happens in the conversation, so this is only the
 * list of them. The portfolio and mandate screens it used to link to were
 * removed once the chat could do all of it, with a card to approve each step.
 *
 * Collapsed, the sidebar becomes an icon rail rather than disappearing, so a
 * new chat and search stay one click away. The logo in the
 * rail is the way back out: clicking it expands the panel again.
 */

function group(conversations: Conversation[]) {
  const day = 86_400_000;
  const now = Date.now();
  return {
    today: conversations.filter((c) => now - c.updatedAt < day),
    earlier: conversations.filter((c) => now - c.updatedAt >= day),
  };
}

/** Every row is the same pill, so the column reads as one list. */
function rowClass(rail: boolean, active = false) {
  return [
    "flex items-center gap-3 rounded-full text-sm transition-colors duration-150",
    rail ? "mx-auto size-10 justify-center" : "w-full px-3 py-2",
    active
      ? "bg-raised text-ink"
      : "text-ink-muted hover:bg-raised hover:text-ink",
  ].join(" ");
}

export function Sidebar({
  conversations,
  currentId,
  open,
  rail,
  onClose,
  onToggle,
  onNew,
  onSelect,
  onDelete,
  footer,
}: {
  conversations: Conversation[];
  currentId: string | null;
  /** The drawer on narrow screens. */
  open: boolean;
  /** Docked and folded into icons. Never true for the drawer. */
  rail: boolean;
  onClose: () => void;
  /** Folds or unfolds the docked sidebar. */
  onToggle: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  footer: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const { today, earlier } = group(filtered);

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close the sidebar"
          onClick={onClose}
          className="fixed inset-0 z-20 bg-black/60 lg:hidden"
        />
      ) : null}

      <aside
        aria-label="Sidebar"
        className={`fixed inset-y-0 left-0 z-30 flex w-[272px] shrink-0 flex-col bg-surface transition-[transform,width] duration-200 ease-[var(--ease-out-quick)] lg:static lg:translate-x-0 lg:bg-transparent ${
          open ? "translate-x-0" : "-translate-x-full"
        } ${rail ? "lg:w-[68px]" : "lg:w-[272px]"}`}
      >
        <div
          className={`flex h-16 shrink-0 items-center gap-2.5 ${
            rail ? "justify-center" : "px-4"
          }`}
        >
          {rail ? (
            <button
              type="button"
              onClick={onToggle}
              aria-label="Expand the sidebar"
              title="Expand the sidebar"
              className="grid size-11 place-items-center rounded-full transition-colors hover:bg-raised"
            >
              <Logo />
            </button>
          ) : (
            <Logo />
          )}
          {!rail ? (
            <span className="flex-1 select-none truncate text-[17px] font-semibold tracking-tight text-ink">
              Conduit
            </span>
          ) : null}
          {!rail ? (
            <button
              type="button"
              onClick={open ? onClose : onToggle}
              aria-label={open ? "Close the sidebar" : "Collapse the sidebar"}
              title={open ? "Close the sidebar" : "Collapse the sidebar (Ctrl+B)"}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-raised hover:text-ink"
            >
              {open ? (
                <X className="size-4" aria-hidden="true" />
              ) : (
                <PanelLeftClose className="size-4" aria-hidden="true" />
              )}
            </button>
          ) : null}
        </div>

        <nav
          className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-1 ${
            rail ? "px-0" : "px-2"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              onNew();
              onClose();
            }}
            title="New chat"
            className={rowClass(rail, true)}
          >
            <Plus className="size-[18px] shrink-0" aria-hidden="true" />
            {!rail ? <span>New chat</span> : null}
          </button>

          {rail ? (
            <button
              type="button"
              onClick={() => {
                onToggle();
                requestAnimationFrame(() => searchRef.current?.focus());
              }}
              aria-label="Search conversations"
              title="Search conversations"
              className={`mt-1 ${rowClass(true)}`}
            >
              <Search className="size-[18px] shrink-0" aria-hidden="true" />
            </button>
          ) : (
            <label className="mt-1 flex w-full cursor-text items-center gap-3 rounded-full px-3 py-2 text-sm text-ink-muted transition-colors focus-within:bg-raised">
              <Search
                className="size-[18px] shrink-0 text-ink-faint"
                aria-hidden="true"
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search conversations"
                aria-label="Search conversations"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-muted focus:outline-none"
              />
            </label>
          )}

          {rail ? null : filtered.length > 0 ? (
            <>
              <Section
                title="Today"
                conversations={today}
                currentId={currentId}
                onSelect={onSelect}
                onDelete={onDelete}
                onClose={onClose}
              />
              <Section
                title="Earlier"
                conversations={earlier}
                currentId={currentId}
                onSelect={onSelect}
                onDelete={onDelete}
                onClose={onClose}
              />
            </>
          ) : (
            <p className="px-3 py-6 text-[12px] leading-relaxed text-ink-faint">
              {query.trim()
                ? "No conversations match that search."
                : "Your conversations will appear here. They stay in this browser and are never sent anywhere."}
            </p>
          )}
        </nav>

        <div className={`shrink-0 pb-3 pt-2 ${rail ? "px-0" : "px-2"}`}>
          {footer}
        </div>
      </aside>
    </>
  );
}

function Logo() {
  return (
    <Image
      src="/logo.png"
      alt="Conduit"
      width={512}
      height={512}
      priority
      className="size-8 shrink-0 select-none"
    />
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-3 pb-1 pt-5 text-[12px] text-ink-faint">{children}</h3>
  );
}

function Section({
  title,
  conversations,
  currentId,
  onSelect,
  onDelete,
  onClose,
}: {
  title: string;
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  if (conversations.length === 0) return null;

  return (
    <>
      <SectionLabel>{title}</SectionLabel>
      <ul className="flex flex-col gap-0.5">
        {conversations.map((conversation) => (
          <li
            key={conversation.id}
            className={`group flex items-center gap-1 rounded-full pr-1.5 transition-colors ${
              conversation.id === currentId
                ? "bg-raised text-ink"
                : "text-ink-muted hover:bg-raised hover:text-ink"
            }`}
          >
            <button
              type="button"
              onClick={() => {
                onSelect(conversation.id);
                onClose();
              }}
              className="min-w-0 flex-1 truncate px-3 py-2 text-left text-[13px]"
            >
              {conversation.title}
            </button>
            <button
              type="button"
              aria-label="Delete this conversation"
              title="Delete this conversation"
              onClick={() => onDelete(conversation.id)}
              className="grid size-6 shrink-0 place-items-center rounded-full text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
