import { generateMap, type GameMap } from "./map";
import { disconnect, snapshot, type MatchEvent, type Snapshot } from "./match";
import { newState, type State } from "./state";
import { resolveTurn } from "./turn";

type StartEvent = Extract<MatchEvent, { type: "start" }>;

export const mapFor = (start: StartEvent): GameMap => generateMap(start.seed, start.size, start.players.length);

/** Recomputes a match from its logged orders alone; returns the public state after `turns` turns (all, by default). */
export function replayTo(log: MatchEvent[], turns = Infinity): { map: GameMap; state: Snapshot } {
  const start = log.find((e): e is StartEvent => e.type === "start");
  if (!start) throw new Error("The match log has no start event.");
  const map = mapFor(start);
  let state: State = newState(map, start.seed);
  for (const e of log) {
    if (e.type === "orders" && e.turn <= turns) state = resolveTurn(map, state, e.orders).state;
    if (e.type === "turn" && e.turn <= turns) for (const p of e.disconnected) disconnect(state, p);
  }
  return { map, state: snapshot(state) };
}
