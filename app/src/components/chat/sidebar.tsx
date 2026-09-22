"use client";

import Image from "next/image";
import Link from "next/link";

import type { Conversation } from "@/lib/copilot/store";

/**
 * Conversations and workspaces.
 *
 * The workspace links are not a fallback for a chat that cannot do the job.
 * They are the same accounts seen a different way, and some things are simply
 * better as a screen: picking eight assets out of eighteen with checkboxes
 * beats describing them in a sentence. The conversation is the front door, not
 * the only door.
 */

function group(conversations: Conversation[]) {
  const day = 86_400_000;
  const now = Date.now();
  return {
    today: conversations.filter((c) => now - c.updatedAt < day),
    earlier: conversations.filter((c) => now - c.updatedAt >= day),
  };
}

export function Sidebar({
  conversations,
  currentId,
  open,
  onClose,
  onNew,
  onSelect,
  onDelete,
  footer,
}: {
  conversations: Conversation[];
  currentId: string | null;
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  footer: React.ReactNode;
}) {
  const { today, earlier } = group(conversations);

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
        className={`fixed inset-y-0 left-0 z-30 flex w-64 shrink-0 flex-col border-r border-zinc-900 bg-zinc-950 transition-transform lg:static lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-4 py-4">
          <Image
            src="/logo-mark.png"
            alt=""
            width={28}
            height={28}
          />
          <span className="text-sm font-semibold tracking-tight text-zinc-100">
            CONDUIT
          </span>
        </div>

        <div className="px-3">
          <button
            type="button"
            onClick={() => {
              onNew();
              onClose();
            }}
            className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          >
            <span className="text-base leading-none">+</span>
            New chat
          </button>
        </div>

        <nav className="mt-6 flex-1 overflow-y-auto px-3 pb-4">
          <p className="px-2 pb-1.5 text-[10px] uppercase tracking-wider text-zinc-600">
            Workspaces
          </p>
          <Link
            href="/portfolio"
            className="block rounded-md px-2 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
          >
            Portfolio
          </Link>
          <Link
            href="/mandate"
            className="block rounded-md px-2 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
          >
            Author a mandate
          </Link>

          {conversations.length > 0 ? (
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
            <p className="mt-6 px-2 text-[11px] leading-relaxed text-zinc-600">
              Your conversations will appear here. They stay in this browser and
              are never sent anywhere.
            </p>
          )}
        </nav>

        <div className="border-t border-zinc-900 px-3 py-3">{footer}</div>
      </aside>
    </>
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
      <p className="mt-6 px-2 pb-1.5 text-[10px] uppercase tracking-wider text-zinc-600">
        {title}
      </p>
      {conversations.map((conversation) => (
        <div
          key={conversation.id}
          className={`group flex items-center gap-1 rounded-md pr-1 transition-colors ${
            conversation.id === currentId
              ? "bg-zinc-900 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-900/60"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              onSelect(conversation.id);
              onClose();
            }}
            className="flex-1 truncate px-2 py-1.5 text-left text-sm"
          >
            {conversation.title}
          </button>
          <button
            type="button"
            aria-label="Delete this conversation"
            onClick={() => onDelete(conversation.id)}
            className="hidden px-1.5 text-zinc-600 transition-colors hover:text-zinc-300 group-hover:block"
          >
            ×
          </button>
        </div>
      ))}
    </>
  );
}
