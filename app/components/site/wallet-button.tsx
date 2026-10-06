"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Copy, ExternalLink, LogOut, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { explorerAddress } from "@/lib/constants";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/utils";

export function WalletButton({ size = "default", className }: { size?: "default" | "lg"; className?: string }) {
  const { publicKey, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();

  if (!publicKey) {
    return (
      <Button variant={size === "lg" ? "default" : "soft"} size={size} className={cn("rounded-full font-semibold", className)} onClick={() => setVisible(true)} disabled={connecting}>
        <Wallet aria-hidden />
        {connecting ? "Connecting…" : "Connect wallet"}
      </Button>
    );
  }
  const addr = publicKey.toBase58();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size={size} className={cn("rounded-full gap-2", className)}>
          <span className="size-2 rounded-full bg-primary" aria-hidden />
          <span className="font-mono text-xs">{shortAddr(addr)}</span>
          <span className="sr-only">Wallet menu{wallet ? ` (${wallet.adapter.name})` : ""}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          onClick={() => {
            navigator.clipboard.writeText(addr);
            toast.success("Address copied");
          }}
        >
          <Copy aria-hidden /> Copy address
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={explorerAddress(addr)} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden /> View on explorer
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => disconnect()}>
          <LogOut aria-hidden /> Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
