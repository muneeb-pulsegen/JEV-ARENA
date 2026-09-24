import { SIZES, WONDERS_TO_WIN, type SizeId } from "./config";
import type { GameMap } from "./map";
import type { State, Victory } from "./state";

export function score(s: State, p: number): number {
  const cities = s.cities.filter((c) => c.owner === p);
  const pop = cities.reduce((n, c) => n + c.pop, 0);
  const land = s.owner.filter((o) => o === p).length;
  const pl = s.players[p];
  return 3 * pop + 4 * pl.techs.length + 10 * pl.wonders.length + 5 * cities.length + Math.floor(land / 4);
}

/** Highest score, then more techs, then seat order. */
function best(s: State, pool: number[]): number {
  return pool.reduce((w, p) => {
    const a = [score(s, p), s.players[p].techs.length], b = [score(s, w), s.players[w].techs.length];
    return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? p : w;
  });
}

/**
 * Checked every turn, in order: domination (every original capital, or the last
 * player with cities), science (an Observatory), wonders (three), then score at
 * the turn limit. Several players winning the same way the same turn are split by score.
 */
export function checkVictory(m: GameMap, s: State, size?: SizeId): Victory | null {
  const alive = s.players.flatMap((pl, p) => (pl.alive ? [p] : []));
  if (alive.length === 1) return { winner: alive[0], kind: "domination" };
  const capitals = s.cities.filter((c) => c.capitalOf >= 0);
  const holders = alive.filter((p) => capitals.length === m.starts.length && capitals.every((c) => c.owner === p));
  if (holders.length) return { winner: best(s, holders), kind: "domination" };

  const science = alive.filter((p) => s.cities.some((c) => c.owner === p && c.buildings.includes("observatory")));
  if (science.length) return { winner: best(s, science), kind: "science" };

  const wonders = alive.filter((p) => s.players[p].wonders.length >= WONDERS_TO_WIN);
  if (wonders.length) return { winner: best(s, wonders), kind: "wonders" };

  if (size && s.turn >= SIZES[size].turns) return { winner: best(s, alive), kind: "score" };
  return null;
}
