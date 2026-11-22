import type { Metadata } from "next";
import Link from "next/link";
import { Wrench } from "lucide-react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Plumberr — fixes production leaks in seconds",
  description: "Break a live production service. An OpenClaw agent on Kimi K3.1 Pro (Cerebras) finds the root cause and opens a fix PR.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <Wrench className="size-5 text-primary" /> Plumberr
            </Link>
            <nav className="flex gap-5 text-sm text-muted-foreground">
              <Link href="/" className="hover:text-foreground">Live</Link>
              <Link href="/incidents" className="hover:text-foreground">Incidents</Link>
              <a href="https://github.com/" className="hover:text-foreground" target="_blank" rel="noreferrer">GitHub</a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
        <footer className="mx-auto max-w-7xl px-6 py-8 text-xs text-muted-foreground">
          OpenClaw × Kimi K3.1 Pro on Cerebras · #KimiOnCerebras
        </footer>
      </body>
    </html>
  );
}
