import type { Metadata } from "next";
import Link from "next/link";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site/header";
import { Wordmark } from "@/components/site/wordmark";
import { StatusBanner } from "@/components/site/status-banner";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://bide-token.vercel.app"),
  title: { default: "Bide — Name your price. Get paid until it fills.", template: "%s · Bide" },
  description:
    "Set the price you want to buy or sell SOL at and a deadline. Bide pays you upfront every round while you wait, and your funds earn Jupiter Lend interest. Solana devnet.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <Providers>
          <SiteHeader />
          <StatusBanner />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border">
            <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="flex flex-wrap items-center gap-4">
                <Link href="/" aria-label="Bide home" className="rounded-md text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"><Wordmark /></Link>
                <p>Solana devnet. Unaudited — test tokens only.</p>
              </div>
              <nav aria-label="Footer" className="flex gap-4">
                <Link href="/maker" className="py-2 hover:text-foreground">For market makers</Link>
                <Link href="/pool" className="py-2 hover:text-foreground">Backstop pool</Link>
              </nav>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
