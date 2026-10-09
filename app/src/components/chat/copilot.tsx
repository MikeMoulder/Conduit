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
import { MarketCards } from "./market-cards";
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
    retry,
    stop,
    newChat,
    select,
    remove,
  } = useCopilot();
  const { connected } = useWallet();
  const [open, setOpen] = useState(false);
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
            // Keyed by conversation only. It used to remount on every approved
            // card as well, which threw the scroll back to the top before the
            // follow below brought it down again.
            key={conversation.id}
            turns={conversation.turns}
            busy={busy}
            onEvent={(message) => void send(message, { event: true })}
            onAsk={(question) => void send(question)}
            onRetry={retry}
          />
        ) : (
          <Welcome connected={connected} onAsk={(q) => void send(q)} />
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

function Welcome({ connected, onAsk }: { connected: boolean; onAsk: (question: string) => void }) {
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
              invest in stocks by texting, on Solana {CLUSTER}
            </p>
          </div>
        </div>

        <p className="max-w-2xl text-[15px] leading-relaxed text-ink">
          Text me what you want, like &ldquo;buy $50 of Apple&rdquo; or
          &ldquo;how&rsquo;s Tesla doing?&rdquo;, and I&rsquo;ll take it from
          there. Every number I show you comes from a live source, never from
          memory.
        </p>

        <ul className="flex flex-col gap-2 text-sm text-ink-muted">
          <Bullet>
            Buy and sell stocks like NVIDIA and Tesla, plus crypto and pre IPO
            names like SpaceX.
          </Bullet>
          <Bullet>
            Get a quick brief on any stock: the price, the day, and the news
            behind it.
          </Bullet>
          <Bullet>
            Set price alerts and timed or repeating orders, with a ping on
            Telegram.
          </Bullet>
          <Bullet>
            Hand me a portfolio to run on my own, inside rules you set.
          </Bullet>
        </ul>

        <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            Here&rsquo;s the part that matters: your rules live on Solana, not
            in my head. If I ever try to break one, like putting too much into
            one stock, Solana blocks it, and anyone can check. I also
            can&rsquo;t send your money anywhere except back to you.
          </p>
        </div>

        <MarketCards enabled={connected} onAsk={onAsk} />

        {!connected ? (
          <p className="text-[13px] text-ink-faint">
            Connect a wallet to start. It&rsquo;s all test money on {CLUSTER},
            so nothing real is at risk.
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
