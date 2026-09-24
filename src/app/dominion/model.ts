import { TECHS, WONDERS } from "@/lib/dominion/config";
import { generateMap, type GameMap } from "@/lib/dominion/map";
import type { Decision, MatchEvent, Snapshot } from "@/lib/dominion/match";
import type { TurnReport } from "@/lib/dominion/turn";

export type StartEvent = Extract<MatchEvent, { type: "start" }>;
export type EndEvent = Extract<MatchEvent, { type: "end" }>;
export type FeedItem = { key: number; turn: number; player?: number; text: string; tone: "city" | "war" | "tech" | "wonder" | "out" | "retry" | "end" };

const MAX_FEED = 120;

export const VICTORY: Record<EndEvent["victory"], string> = {
  domination: "Domination victory",
  science: "Science victory",
  wonders: "Wonder victory",
  score: "Victory on score at the turn limit",
};

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Everything a Dominion screen shows, built by applying the event log in order. */
export class DominionModel {
  readonly map: GameMap;
  state: Snapshot;
  report: TurnReport | null = null;
  /** Each player's decisions in the latest orders. */
  decisions: Decision[][];
  answered = new Set<number>();
  waiting: (string | null)[];
  feed: FeedItem[] = [];
  end: EndEvent | null = null;
  applied = 0;
  private feedKey = 0;

  constructor(readonly start: StartEvent) {
    // The map is regenerated from the seed; importing the server-side replay module would pull in Node-only code.
    this.map = generateMap(start.seed, start.size, start.players.length);
    this.state = start.snapshot;
    this.decisions = start.players.map(() => []);
    this.waiting = start.players.map(() => null);
  }

  get turn() {
    return this.end ? this.state.turn : Math.min(this.state.turn + 1, this.start.turns);
  }

  private say(turn: number, text: string, tone: FeedItem["tone"], player?: number) {
    this.feed = [{ key: this.feedKey++, turn, player, text, tone }, ...this.feed].slice(0, MAX_FEED);
  }

  apply(e: MatchEvent) {
    this.applied++;
    const name = (p: number) => this.start.players[p].name;
    const city = (id: number) => this.state.cities.find((c) => c.id === id)?.name ?? "a city";
    switch (e.type) {
      case "answered":
        this.answered.add(e.player);
        this.waiting[e.player] = null;
        break;
      case "orders":
        this.decisions = this.start.players.map((_, p) => e.decisions.filter((d) => d.player === p));
        this.answered.clear();
        break;
      case "turn":
        this.state = e.snapshot;
        this.report = e.report;
        for (const x of e.report.events) {
          switch (x.kind) {
            case "founded":
              this.say(e.turn, `${name(x.player)} founded ${city(x.city)}`, "city", x.player);
              break;
            case "captured":
              this.say(e.turn, `${name(x.to)} captured ${city(x.city)} from ${name(x.from)}`, "war", x.to);
              break;
            case "battle":
              if (x.city === undefined) this.say(e.turn, `${name(x.attackerWins ? x.attacker : x.defender)} won a battle against ${name(x.attackerWins ? x.defender : x.attacker)} (${x.attack.toFixed(0)} vs ${x.defence.toFixed(0)})`, "war", x.attackerWins ? x.attacker : x.defender);
              else if (!x.attackerWins) this.say(e.turn, `${city(x.city)} held off ${name(x.attacker)} (${x.defence.toFixed(0)} vs ${x.attack.toFixed(0)})`, "war", x.defender);
              break;
            case "wonder":
              this.say(e.turn, `${name(x.player)} completed the ${WONDERS[x.wonder].name}`, "wonder", x.player);
              break;
            case "tech":
              this.say(e.turn, `${name(x.player)} discovered ${TECHS[x.tech].name}`, "tech", x.player);
              break;
            case "observatory":
              this.say(e.turn, `${name(x.player)} completed the Observatory`, "wonder", x.player);
              break;
            case "settler_lost":
              this.say(e.turn, `${name(x.by)} caught a ${name(x.player)} settler`, "war", x.by);
              break;
          }
        }
        break;
      case "out":
        this.say(e.turn, `${name(e.player)} is out: ${e.reason}`, "out", e.player);
        break;
      case "retry":
        this.waiting[e.player] = `retrying in ${Math.round(e.waitMs / 1000)}s`;
        this.say(this.state.turn + 1, `${name(e.player)} ${/HTTP (429|529)/.test(e.message) ? "is rate limited" : "hit a provider error"}, retrying`, "retry", e.player);
        break;
      case "end":
        this.end = e;
        this.say(e.turns, `${name(e.winner)} wins: ${VICTORY[e.victory].toLowerCase()}`, "end", e.winner);
        break;
    }
  }
}

/** A decision in a few words, for the civ cards. */
export function decisionText(d: Decision): string {
  switch (d.kind) {
    case "build":
      return `${d.key.replace(/^build_/, "").replace(/^./, (c) => c.toUpperCase())}: ${d.option}`;
    case "research":
      return `Research ${d.option}`;
    case "army":
      return `Army: ${d.option}`;
    case "settle":
      return d.option === "Wait" ? "Settler: waiting" : d.option;
  }
}

/** How long each event holds the screen before the next is shown. */
export const beatMs = (e: MatchEvent) => (e.type === "turn" ? 650 : e.type === "out" ? 400 : 0);
