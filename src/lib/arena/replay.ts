import { applyMove, eliminate, generateArena, type Board } from "./board";
import type { MatchEvent } from "./match";

type StartEvent = Extract<MatchEvent, { type: "start" }>;

/** The board at the start of a match, rebuilt from its seed. */
export function boardAtStart(start: StartEvent): Board {
  return generateArena(start.seed, start.size, start.seats.length);
}

/** Applies one logged event to a board. Returns true if the board changed. */
export function applyEvent(board: Board, e: MatchEvent): boolean {
  if (e.type === "move") {
    if (!board.seats[e.seat]?.alive) return false;
    applyMove(board, e.seat, e.dir, e.t);
    return true;
  }
  if (e.type === "crash" && board.seats[e.seat]?.alive) {
    eliminate(board, e.seat, e.reason, e.t);
    return true;
  }
  return false;
}

/** Rebuilds the board as it stood at time `t` of a saved log (the end, by default). */
export function replayTo(log: MatchEvent[], t = Infinity): Board {
  const start = log.find((e): e is StartEvent => e.type === "start");
  if (!start) throw new Error("The match log has no start event.");
  const board = boardAtStart(start);
  for (const e of log) {
    if ("t" in e && e.t > t) break;
    applyEvent(board, e);
  }
  return board;
}
