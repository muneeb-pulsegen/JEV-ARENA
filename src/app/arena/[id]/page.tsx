import Link from "next/link";
import { notFound } from "next/navigation";
import { getMatch } from "@/lib/db";
import ArenaReplay from "./ArenaReplay";

export const dynamic = "force-dynamic";

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const match = getMatch(id);
  if (!match) notFound();
  const winner = match.results[0];
  return (
    <>
      <p className="crumbs"><Link href="/arena">← Arena</Link></p>
      <h1>Replay: {winner.name} wins</h1>
      <p className="lede">
        {match.seats} {match.provider === "demo" ? "demo bots" : "JEV agents"} · {new Date(match.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC ·
        seed {match.seed}
      </p>
      <ArenaReplay log={match.log} />
    </>
  );
}
