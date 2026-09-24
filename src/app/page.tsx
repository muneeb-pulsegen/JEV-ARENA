import { serverKey } from "@/lib/agents/providers";
import { PROVIDERS, type ProviderId } from "@/lib/agents/types";
import { GAMES, estimateRunTokens } from "@/lib/games";
import Arena from "./Arena";

export const dynamic = "force-dynamic";

export default function Home() {
  const games = GAMES.map(({ id, name, axis, blurb, create }) => ({ id, name, axis, blurb, view: create(1).view() }));
  const providers = Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p, serverKey: !!serverKey(id as ProviderId) }));
  return (
    <>
      <h1>Four games. One score.</h1>
      <p className="lede">
        Watch TypeSafe&apos;s JEV model play all four games live: planning, routing, mechanism and dispatch. Every turn is a
        single, fixed choice — no free text to guess at, no hidden secrets. Everything is scored on our server and ranked on
        the leaderboard.
      </p>
      <Arena games={games} providers={providers} estTokens={estimateRunTokens()} />
    </>
  );
}
