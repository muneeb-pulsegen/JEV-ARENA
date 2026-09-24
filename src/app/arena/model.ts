import { newState, type GameMap, type State } from "@/lib/frontline/map";
import type { MatchEvent, RevealedOrder } from "@/lib/frontline/match";
import { mapFor } from "@/lib/frontline/replay";
import type { Order, Report } from "@/lib/frontline/rules";

export type StartEvent = Extract<MatchEvent, { type: "start" }>;
export type EndEvent = Extract<MatchEvent, { type: "end" }>;
export type FeedItem = { key: number; round: number; player?: number; text: string; tone: "battle" | "out" | "retry" | "end" };

const MAX_FEED = 80;

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function orderText(m: GameMap, o: Order) {
  return o.kind === "attack" ? `Attack ${m.name[o.to]} from ${m.name[o.from]}` : `Reinforce ${m.name[o.at]}`;
}

/** Everything a Frontline screen shows, built by applying the event log in order. */
export class FrontlineModel {
  readonly map: GameMap;
  state: State;
  /** Players whose answer for the round in progress is in. */
  locked = new Set<number>();
  /** The latest reveal, drawn as arrows until the next round starts. */
  reveal: RevealedOrder[] | null = null;
  /** The latest resolved round, drawn as battle markers until the next round starts. */
  report: Report | null = null;
  lastOrder: (RevealedOrder | null)[];
  waiting: (string | null)[];
  feed: FeedItem[] = [];
  end: EndEvent | null = null;
  applied = 0;
  private feedKey = 0;

  constructor(readonly start: StartEvent) {
    this.map = mapFor(start);
    this.state = newState(this.map);
    this.lastOrder = start.players.map(() => null);
    this.waiting = start.players.map(() => null);
  }

  /** The round on screen: the one just resolved while its results show, otherwise the one being played. */
  get round() {
    if (this.end || this.report) return this.state.round;
    return Math.min(this.state.round + 1, this.start.rounds);
  }

  private say(round: number, text: string, tone: FeedItem["tone"], player?: number) {
    this.feed = [{ key: this.feedKey++, round, player, text, tone }, ...this.feed].slice(0, MAX_FEED);
  }

  apply(e: MatchEvent) {
    this.applied++;
    const m = this.map;
    const name = (p: number) => this.start.players[p].name;
    switch (e.type) {
      case "locked":
        if (this.report || this.reveal) {
          // A new round has begun: clear last round's arrows and markers.
          this.reveal = null;
          this.report = null;
        }
        this.locked.add(e.player);
        this.waiting[e.player] = null;
        break;
      case "reveal":
        this.reveal = e.orders;
        this.report = null;
        for (const o of e.orders) this.lastOrder[o.player] = o;
        this.locked.clear();
        break;
      case "round": {
        this.state = { ...this.state, round: e.round, owner: e.owner, troops: e.troops };
        this.report = e.report;
        for (const c of e.report.clashes) {
          this.say(e.round, `${name(c.players[0])} and ${name(c.players[1])} met head-on at ${m.name[c.from]}–${m.name[c.to]} (${c.armies[0]} vs ${c.armies[1]})`, "battle", c.survivor ?? undefined);
        }
        for (const b of e.report.battles) {
          const who = name(b.attackers[0].player);
          const from = b.defender < 0 ? "neutral" : name(b.defender);
          // Neutral land changing hands is routine; only fights between players and neutral cities make the feed.
          if (b.defender < 0 && !m.city[b.target]) continue;
          if (b.captured !== null) this.say(e.round, `${who} took ${m.city[b.target] ? "city " : ""}${m.name[b.target]} from ${from}`, "battle", b.captured);
          else if (b.defender >= 0) this.say(e.round, `${from} held ${m.name[b.target]} against ${who}`, "battle", b.defender);
        }
        break;
      }
      case "out":
        this.state.players[e.player] = { ...this.state.players[e.player], alive: false, out: e.reason, outRound: e.round };
        this.say(e.round, `${name(e.player)} is out: ${e.reason}`, "out", e.player);
        break;
      case "retry":
        this.waiting[e.player] = `retrying in ${Math.round(e.waitMs / 1000)}s`;
        this.say(this.state.round + 1, `${name(e.player)} ${/HTTP (429|529)/.test(e.message) ? "is rate limited" : "hit a provider error"}, retrying in ${Math.round(e.waitMs / 1000)}s`, "retry", e.player);
        break;
      case "end":
        this.end = e;
        this.say(e.rounds, `${name(e.winner)} wins, ${e.reason === "last" ? "last player standing" : "most regions at the round limit"}`, "end", e.winner);
        break;
    }
  }
}

/** How long each event holds the screen before the next is shown, so a round reads as beats. */
export const beatMs = (e: MatchEvent) => (e.type === "reveal" ? 1100 : e.type === "round" ? 1100 : e.type === "out" ? 400 : 0);
