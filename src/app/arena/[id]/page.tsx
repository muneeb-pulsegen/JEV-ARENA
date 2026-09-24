import Link from "next/link";
import { notFound } from "next/navigation";
import { getMatch } from "@/lib/db";
import type { MatchEvent } from "@/lib/frontline/match";
import type { Standing } from "@/lib/frontline/rules";
import FrontlineReplay from "./FrontlineReplay";

export const dynamic = "force-dynamic";

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const match = getMatch<Standing, MatchEvent>(id);
  if (!match || match.game !== "frontline") notFound();
  const winner = match.results[0];
  return (
    <>
      <p className="crumbs"><Link href="/arena">← Frontline</Link></p>
      <h1>Replay: {winner.name} wins</h1>
      <p className="lede">
        {match.seats} {match.provider === "demo" ? "demo bots" : "JEV agents"} · {match.rounds} rounds ·{" "}
        {new Date(match.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC · seed {match.seed}
      </p>
      <FrontlineReplay log={match.log} />
    </>
  );
}
