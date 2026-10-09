import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { SolanaProviders } from "@/components/wallet-provider";
import { THEME_SCRIPT } from "@/lib/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Conduit",
  description:
    "A portfolio copilot for tokenized equities whose risk mandate is enforced by a Solana program rather than by the good behaviour of a model.",
};

/**
 * Providers and nothing else.
 *
 * Chrome lives with the routes that want it. The conversation fills the viewport
 * and brings its own sidebar, while the structured screens sit under a header,
 * and a shared container here would have to be fought by one of them.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The head script sets data-theme before React runs, so the server's
      // html and the browser's differ by that attribute on purpose.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="h-full bg-canvas text-ink">
        <SolanaProviders>{children}</SolanaProviders>
      </body>
    </html>
  );
}
