import { createRng } from "../games/rng";
import { PLAYERS, START_UNITS, type BuildingId, type Stack, type TechId, type UnitId, type WonderId } from "./config";
import type { GameMap } from "./map";

export type BuildItem =
  | { kind: "unit"; unit: UnitId }
  | { kind: "settler" }
  | { kind: "building"; building: BuildingId }
  | { kind: "wonder"; wonder: WonderId };

export type City = {
  id: number;
  name: string;
  owner: number;
  hex: number;
  pop: number;
  food: number;
  /** Production stored toward the current item; kept when the item changes. */
  prod: number;
  build: BuildItem | null;
  /** The city finished something (or was just founded) and should be asked what to build next. */
  idle: boolean;
  buildings: BuildingId[];
  garrison: Stack;
  /** The seat whose original capital this is, or -1. */
  capitalOf: number;
  founded: number;
};

export type Army = { hex: number; units: Stack; fortified: boolean };

export type Settler = { id: number; owner: number; hex: number; target: number | null };

export type Player = {
  id: string;
  name: string;
  alive: boolean;
  out?: string;
  outTurn?: number;
  gold: number;
  research: TechId | null;
  progress: number;
  techs: TechId[];
  wonders: WonderId[];
  /** Hexes this player has ever seen. */
  seen: boolean[];
  /** Turns in a row this player's answers were missing. */
  fallbacks: number;
};

export type Victory = { winner: number; kind: "domination" | "science" | "wonders" | "score" };

export type State = {
  turn: number;
  /** Territory owner per hex, or -1. */
  owner: number[];
  cities: City[];
  armies: (Army | null)[];
  settlers: Settler[];
  players: Player[];
  /** Who completed each wonder. */
  wonders: Partial<Record<WonderId, number>>;
  nextId: number;
  /** City names not yet used, in the order they'll be given out. */
  names: string[];
};

const CITY_NAMES = [
  "Ashford", "Brightwater", "Cinderfall", "Dunmore", "Elmstead", "Frostholm", "Glenrock", "Harrowgate", "Ironvale", "Juniper",
  "Kestrel", "Larkspur", "Millbrook", "Northwatch", "Oakheart", "Pinecrest", "Quarry", "Redcliff", "Stonebridge", "Thornbury",
  "Umberlee", "Valewood", "Westmarch", "Yarrow", "Zephyr", "Amberly", "Blackmoor", "Coldharbour", "Deepwell", "Eastwick",
  "Fairhaven", "Greywater", "Highgarden", "Irongate", "Kingsbridge", "Lowmoor", "Marshfield", "Newhaven", "Oldcastle", "Queensford",
  "Riverton", "Silverdale", "Tidewater", "Underhill", "Windmere", "Brambleton", "Copperhill", "Dawnfield", "Emberly", "Foxhollow",
];

export const unitCount = (s: Stack) => Object.values(s).reduce((n, c) => n + (c ?? 0), 0);

export function addStack(a: Stack, b: Stack): Stack {
  const out: Stack = { ...a };
  for (const [k, v] of Object.entries(b) as [UnitId, number][]) if (v) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Territory hexes a city claims: its ring of 1, or 2 once it has grown. */
export function claim(m: GameMap, s: State, c: City, radius: number) {
  for (let i = 0; i < m.q.length; i++) {
    const d = (Math.abs(m.q[i] - m.q[c.hex]) + Math.abs(m.r[i] - m.r[c.hex]) + Math.abs(m.q[i] + m.r[i] - m.q[c.hex] - m.r[c.hex])) / 2;
    if (d <= radius && s.owner[i] === -1) s.owner[i] = c.owner;
  }
  s.owner[c.hex] = c.owner;
}

export function foundCity(m: GameMap, s: State, owner: number, hex: number, capitalOf = -1): City {
  const city: City = {
    id: s.nextId++,
    name: s.names.shift() ?? `City ${s.nextId}`,
    owner,
    hex,
    pop: 1,
    food: 0,
    prod: 0,
    build: null,
    idle: true,
    buildings: [],
    garrison: {},
    capitalOf,
    founded: s.turn,
  };
  s.cities.push(city);
  claim(m, s, city, 1);
  return city;
}

export function newState(m: GameMap, seed: number): State {
  const n = m.q.length;
  const rng = createRng(seed ^ 0x5eed);
  const s: State = {
    turn: 0,
    owner: new Array(n).fill(-1),
    cities: [],
    armies: m.starts.map(() => null),
    settlers: [],
    players: m.starts.map((_, p) => ({
      ...PLAYERS[p],
      alive: true,
      gold: 10,
      research: null,
      progress: 0,
      techs: [],
      wonders: [],
      seen: new Array(n).fill(false),
      fallbacks: 0,
    })),
    wonders: {},
    nextId: 1,
    names: rng.shuffle(CITY_NAMES),
  };
  m.starts.forEach((hex, p) => {
    const c = foundCity(m, s, p, hex, p);
    s.armies[p] = { hex, units: { ...START_UNITS }, fortified: false };
    c.garrison = {};
  });
  return s;
}

export function cloneState(s: State): State {
  return structuredClone(s);
}

export const citiesOf = (s: State, p: number) => s.cities.filter((c) => c.owner === p);
export const cityAt = (s: State, hex: number) => s.cities.find((c) => c.hex === hex);
