import type { Board } from "@/lib/arena/board";
import type { MatchEvent } from "@/lib/arena/match";
import { applyEvent, boardAtStart } from "@/lib/arena/replay";

export type StartEvent = Extract<MatchEvent, { type: "start" }>;
export type EndEvent = Extract<MatchEvent, { type: "end" }>;

export type SeatStat = { choice?: string; confidence?: number; note?: string; waiting?: string; lastMoveT?: number };
export type FeedItem = { key: number; t: number; seat?: number; text: string; tone: "crash" | "retry" | "end" };

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const MAX_FEED = 80;

/** Everything a match screen shows, built by applying the event log in order. Mutable, for speed on big boards. */
export class MatchModel {
  readonly board: Board;
  readonly stats: SeatStat[];
  feed: FeedItem[] = [];
  end: EndEvent | null = null;
  /** Time of the latest applied event. */
  t = 0;
  applied = 0;

  constructor(readonly start: StartEvent) {
    this.board = boardAtStart(start);
    this.stats = start.seats.map(() => ({}));
  }

  private say(e: { t: number }, text: string, tone: FeedItem["tone"], seat?: number) {
    this.feed = [{ key: this.applied, t: e.t, seat, text, tone }, ...this.feed].slice(0, MAX_FEED);
  }

  apply(e: MatchEvent) {
    this.applied++;
    if ("t" in e) this.t = Math.max(this.t, e.t);
    applyEvent(this.board, e);
    const name = (i: number) => this.start.seats[i].name;
    switch (e.type) {
      case "move":
        this.stats[e.seat] = { choice: e.choice, confidence: e.confidence, note: e.note, lastMoveT: e.t };
        break;
      case "crash":
        this.say(e, `${name(e.seat)} ${e.reason}`, "crash", e.seat);
        break;
      case "retry":
        this.stats[e.seat] = { ...this.stats[e.seat], waiting: `retrying in ${Math.round(e.waitMs / 1000)}s (attempt ${e.attempt})` };
        this.say(e, `${name(e.seat)} ${/HTTP 429|HTTP 529/.test(e.message) ? "is rate limited" : "hit a provider error"}, retrying in ${Math.round(e.waitMs / 1000)}s`, "retry", e.seat);
        break;
      case "end":
        this.end = e;
        this.say(e, `${name(e.winner)} wins, ${e.reason === "last" ? "last one standing" : "most cells when time ran out"}`, "end", e.winner);
        break;
    }
  }
}
