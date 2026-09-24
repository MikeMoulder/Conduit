"use client";

import { useState } from "react";
import Image from "next/image";
import { useWallet } from "@solana/wallet-adapter-react";

import { ConnectWallet } from "@/components/connect-wallet";
import { CLUSTER } from "@/lib/cluster";
import { useCopilot } from "@/hooks/use-copilot";
import { Composer } from "./composer";
import { Sidebar } from "./sidebar";
import { Thread } from "./thread";

/**
 * CONDUIT, as a conversation.
 *
 * The whole engine sits behind this: the price feeds, the five stage pipeline,
 * the account readers, the proposal mirror and the program itself. What changed
 * is the way in. A portfolio copilot that answers in forms is a filing system,
 * and the thing people actually want to do is ask.
 */

export function Copilot() {
  const {
    conversations,
    conversation,
    busy,
    send,
    stop,
    newChat,
    select,
    remove,
  } = useCopilot();
  const { connected } = useWallet();
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
      <Sidebar
        conversations={conversations}
        currentId={conversation?.id ?? null}
        open={open}
        onClose={() => setOpen(false)}
        onNew={newChat}
        onSelect={select}
        onDelete={remove}
        footer={<ConnectWallet placement="above-start" />}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-900 px-4 py-3 lg:hidden">
          <button
            type="button"
            aria-label="Open the sidebar"
            onClick={() => setOpen(true)}
            className="text-zinc-400 hover:text-zinc-100"
          >
            <svg viewBox="0 0 16 16" className="h-5 w-5" aria-hidden="true">
              <path
                d="M2 4h12M2 8h12M2 12h12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span className="text-sm font-semibold tracking-tight">
            CONDUIT
          </span>
        </header>

        {conversation ? (
          <Thread
            key={`${conversation.id}:${refresh}`}
            turns={conversation.turns}
            onRefresh={() => setRefresh((r) => r + 1)}
            onEvent={(message) => void send(message, { event: true })}
          />
        ) : (
          <Welcome connected={connected} />
        )}

        <Composer
          busy={busy}
          onSend={(q) => void send(q)}
          onStop={stop}
          showSuggestions={!conversation}
        />
      </div>
    </div>
  );
}

function Welcome({ connected }: { connected: boolean }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-16 sm:px-6">
        <div className="flex items-center gap-3">
          <Image
            src="/logo-mark.png"
            alt=""
            width={52}
            height={52}
            priority
          />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">CONDUIT</h1>
            <p className="text-xs text-zinc-500">
              tokenized equities on {CLUSTER}, governed on chain
            </p>
          </div>
        </div>

        <p className="max-w-2xl text-[15px] leading-relaxed text-zinc-300">
          Ask me about the market, your portfolio, or the mandate it runs
          under. I will fetch what I need and show you every tool I used to
          get there. I will not give you a number I could not look up.
        </p>

        <ul className="flex flex-col gap-2 text-sm text-zinc-400">
          <Bullet>
            Read live prices, and the gap between a token and the thing it
            tracks.
          </Bullet>
          <Bullet>
            See what the portfolio holds and how close it sits to its limits.
          </Bullet>
          <Bullet>
            Run a five stage analysis and get an allocation with a thesis per
            position.
          </Bullet>
          <Bullet>
            Propose a rebalance. The program checks it and refuses it by name if
            it breaches a clause.
          </Bullet>
        </ul>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-3">
          <p className="text-[13px] leading-relaxed text-zinc-400">
            The mandate is not a prompt. It is an account on Solana, and every
            proposal is re-derived against it before anything moves. I can
            propose. I cannot widen a limit, replace the agent or withdraw. Those
            are not promises I am making, they are instructions I have no way to
            reach.
          </p>
        </div>

        {!connected ? (
          <p className="text-[13px] text-zinc-500">
            Connect a {CLUSTER} wallet and I can read your mandate and your
            positions. Without one I can still talk about the market and how any
            of this works.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-emerald-500" />
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
