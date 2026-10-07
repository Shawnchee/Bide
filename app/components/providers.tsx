"use client";

import "@/lib/polyfills";

import { useMemo, type ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { RPC_URL } from "@/lib/env";
import { StatusProvider } from "@/hooks/use-status";

import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: ReactNode }) {
  // Phantom and Solflare also register via Wallet Standard; explicit adapters keep them listed
  // (with install links) when the extension is missing.
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  // No public RPC configured → go through our /api/rpc proxy (keyed RPC, server-side) instead of rate-limited public devnet.
  // "devnet" must appear in the URL: Wallet Standard wallets pick their chain from it (getChainForEndpoint), else mainnet.
  const endpoint = RPC_URL ?? (typeof window !== "undefined" ? `${window.location.origin}/api/rpc?cluster=devnet` : "https://api.devnet.solana.com");
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed", wsEndpoint: "wss://api.devnet.solana.com/" }}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>
            <TooltipProvider delayDuration={200}>
              <StatusProvider>{children}</StatusProvider>
              <Toaster position="bottom-right" />
            </TooltipProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </ThemeProvider>
  );
}
