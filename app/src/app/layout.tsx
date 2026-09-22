import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { SolanaProviders } from "@/components/wallet-provider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CONDUIT",
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
    >
      <body className="h-full bg-zinc-950 text-zinc-100">
        <SolanaProviders>{children}</SolanaProviders>
      </body>
    </html>
  );
}
