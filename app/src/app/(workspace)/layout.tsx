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
const NAV_LINK =
  "rounded-full px-3 py-1.5 transition-colors hover:bg-raised hover:text-ink";

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="sticky top-0 z-10 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/logo.png"
              alt=""
              width={512}
              height={512}
              className="size-8"
            />
            <span className="text-[17px] font-semibold tracking-tight">
              Conduit
            </span>
          </Link>
          <nav className="ml-auto mr-2 flex gap-1 text-sm text-ink-muted">
            <Link href="/" className={NAV_LINK}>
              Ask
            </Link>
            <Link href="/portfolio" className={NAV_LINK}>
              Portfolio
            </Link>
            <Link href="/mandate" className={`hidden sm:inline ${NAV_LINK}`}>
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
