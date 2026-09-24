import Image from "next/image";
import Link from "next/link";

import { ConnectWallet } from "@/components/connect-wallet";

/**
 * The structured screens.
 *
 * Reachable from the sidebar rather than replaced by the conversation, because
 * some things genuinely are better as a screen. Picking eight assets out of
 * eighteen with checkboxes beats describing them in a sentence, and a form that
 * validates every keystroke against the program is a good way to learn what the
 * limits mean.
 */
export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-10 border-b border-zinc-900 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/logo-mark.png"
              alt=""
              width={26}
              height={26}
            />
            <span className="text-sm font-semibold tracking-tight">
              CONDUIT
            </span>
          </Link>
          <nav className="ml-auto mr-4 flex gap-5 text-sm text-zinc-400">
            <Link href="/" className="transition-colors hover:text-zinc-100">
              Ask
            </Link>
            <Link
              href="/portfolio"
              className="transition-colors hover:text-zinc-100"
            >
              Portfolio
            </Link>
            <Link
              href="/mandate"
              className="hidden transition-colors hover:text-zinc-100 sm:inline"
            >
              Author a mandate
            </Link>
          </nav>
          <ConnectWallet />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {children}
      </main>
    </div>
  );
}
