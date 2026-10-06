"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { WalletButton } from "./wallet-button";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/earn", label: "Earn" },
  { href: "/plans", label: "My plans" },
  { href: "/desk", label: "Desk" },
  { href: "/auctions", label: "Auctions" },
];

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[17px] leading-none font-semibold tracking-[-0.03em]", className)}>
      <span aria-hidden className="grid size-6 place-items-center rounded-md bg-primary text-[13px] font-bold text-primary-foreground">b</span>
      Bide
    </span>
  );
}

export function SiteHeader() {
  const path = usePathname();
  const active = (href: string) => path === href || path.startsWith(`${href}/`) || (href === "/plans" && path.startsWith("/plan/"));
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="Bide home">
          <Wordmark />
        </Link>
        <span className="hidden rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-foreground sm:inline">
          Devnet
        </span>
        <nav aria-label="Main" className="ml-1 hidden items-center gap-0.5 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active(n.href) && "bg-secondary text-primary hover:text-primary",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <WalletButton />
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-10 md:hidden" aria-label="Open menu">
                <Menu aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle>
                  <Wordmark />
                </SheetTitle>
              </SheetHeader>
              <nav aria-label="Mobile" className="flex flex-col gap-1 px-4">
                {NAV.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={cn("rounded-lg px-3 py-2.5 text-[15px] font-medium", active(n.href) ? "bg-secondary text-primary" : "text-muted-foreground")}
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
