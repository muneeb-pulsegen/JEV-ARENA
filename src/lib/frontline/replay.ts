import { generateMap, newState, type GameMap, type State } from "./map";
import type { MatchEvent } from "./match";
import { disconnect, resolveRound, type Order } from "./rules";

type StartEvent = Extract<MatchEvent, { type: "start" }>;

export function mapFor(start: StartEvent): GameMap {
  return generateMap(start.seed, start.size, start.players.length);
}

/** Recomputes the state after `rounds` rounds (all of them by default) from the revealed orders alone. */
export function replayTo(log: MatchEvent[], rounds = Infinity): { map: GameMap; state: State } {
  const start = log.find((e): e is StartEvent => e.type === "start");
  if (!start) throw new Error("The match log has no start event.");
  const map = mapFor(start);
  let state = newState(map);
  for (const e of log) {
    if (e.type === "reveal" && e.round <= rounds) {
      const orders: (Order | null)[] = state.players.map(() => null);
      for (const o of e.orders) orders[o.player] = o.order;
      state = resolveRound(map, state, orders).state;
    }
    if (e.type === "round" && e.round <= rounds) for (const p of e.disconnected) disconnect(state, p);
  }
  return { map, state };
}
