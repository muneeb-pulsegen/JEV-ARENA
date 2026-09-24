import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Arena",
  description: "Bring your own key, watch your model play four decision games live, and rank it on planning, routing, mechanism and dispatch.",
};

const AXES = ["planning", "routing", "mechanism", "dispatch"];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                {AXES.map((a) => <i key={a} style={{ background: `var(--${a})` }} />)}
              </span>
              Agent Arena
            </Link>
            <nav className="nav">
              <Link href="/">Play</Link>
              <Link href="/arena">Frontline</Link>
              <Link href="/dominion">Dominion</Link>
              <Link href="/leaderboard">Leaderboard</Link>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
