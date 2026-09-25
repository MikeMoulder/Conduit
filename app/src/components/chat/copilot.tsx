"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useWallet } from "@solana/wallet-adapter-react";
import { Menu } from "lucide-react";

import { ConnectWallet } from "@/components/connect-wallet";
import ParticleDrift from "@/components/ui/particle-drift";
import { CLUSTER } from "@/lib/cluster";
import { useCopilot } from "@/hooks/use-copilot";
import { useIsDesktop, useSidebarCollapsed } from "@/hooks/use-sidebar";
import { Composer } from "./composer";
import { Sidebar } from "./sidebar";
import { Thread } from "./thread";

/**
 * Conduit, as a conversation.
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
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const isDesktop = useIsDesktop();

  const rail = collapsed && isDesktop;
  const drawer = open && !isDesktop;

  // Ctrl or Cmd with B folds the sidebar, the shortcut editors and most other
  // chat clients already taught people.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        if (isDesktop) setCollapsed(!collapsed);
        else setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [collapsed, isDesktop, setCollapsed]);

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
      <Sidebar
        conversations={conversations}
        currentId={conversation?.id ?? null}
        open={drawer}
        rail={rail}
        onClose={() => setOpen(false)}
        onToggle={() => setCollapsed(!collapsed)}
        onNew={newChat}
        onSelect={select}
        onDelete={remove}
        footer={<ConnectWallet variant="sidebar" rail={rail} />}
      />

      <div className="relative isolate flex min-w-0 flex-1 flex-col">
        {!conversation ? <WelcomeBackdrop /> : null}

        <header className="flex items-center gap-3 px-4 py-3 lg:hidden">
          <button
            type="button"
            aria-label="Open the sidebar"
            onClick={() => setOpen(true)}
            className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <span className="text-sm font-semibold tracking-tight">
            Conduit
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
          locked={!connected}
          onSend={(q) => {
            if (connected) void send(q);
          }}
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
            <h1 className="text-lg font-semibold tracking-tight">Conduit</h1>
            <p className="text-xs text-ink-faint">
              tokenized equities on {CLUSTER}, governed on chain
            </p>
          </div>
        </div>

        <p className="max-w-2xl text-[15px] leading-relaxed text-ink">
          Ask me about the market, your portfolio, or the mandate it runs
          under. I will fetch what I need and show you every tool I used to
          get there. I will not give you a number I could not look up.
        </p>

        <ul className="flex flex-col gap-2 text-sm text-ink-muted">
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

        <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            The mandate is not a prompt. It is an account on Solana, and every
            proposal is re-derived against it before anything moves. I can
            propose. I cannot widen a limit, replace the agent or withdraw. Those
            are not promises I am making, they are instructions I have no way to
            reach.
          </p>
        </div>

        {!connected ? (
          <p className="text-[13px] text-ink-faint">
            Connect a {CLUSTER} wallet to start. I read your mandate and your
            positions from it, so there is nothing to ask about until one is
            connected.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The field behind an empty conversation.
 *
 * Only shown before the first message, where there is nothing to read yet
 * and the screen can afford some motion. Faded under the middle column so
 * the welcome text stays the easiest thing to read, and left at full
 * strength toward the edges where nothing competes with it.
 */
function WelcomeBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 animate-[fade-in_1.2s_ease-out_both]"
      style={{
        maskImage:
          "radial-gradient(ellipse 55% 65% at 50% 45%, rgb(0 0 0 / 0.3), #000 100%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 55% 65% at 50% 45%, rgb(0 0 0 / 0.3), #000 100%)",
      }}
    >
      <ParticleDrift opacity={0.9} />
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
