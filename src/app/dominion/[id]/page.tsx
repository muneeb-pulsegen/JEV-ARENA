import Link from "next/link";
import { notFound } from "next/navigation";
import type { MatchEvent, Standing } from "@/lib/dominion/match";
import { getMatch } from "@/lib/db";
import { VICTORY } from "../model";
import DominionReplay from "./DominionReplay";

export const dynamic = "force-dynamic";

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const match = getMatch<Standing, MatchEvent>(id);
  if (!match || match.game !== "dominion") notFound();
  const winner = match.results[0];
  return (
    <>
      <p className="crumbs"><Link href="/dominion">← Dominion</Link></p>
      <h1>Replay: {winner.name} wins</h1>
      <p className="lede">
        {VICTORY[match.endReason as keyof typeof VICTORY] ?? match.endReason} on turn {match.rounds} · {match.seats}{" "}
        {match.provider === "demo" ? "built-in AIs" : "JEV agents"} · {new Date(match.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC · seed {match.seed}
      </p>
      <DominionReplay log={match.log} />
    </>
  );
}
