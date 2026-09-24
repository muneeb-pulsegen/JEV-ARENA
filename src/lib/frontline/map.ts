import { createRng } from "../games/rng";
import { CITY_TROOPS, hexCount, NEUTRAL_TROOPS, PLAYERS, SIZES, START_TROOPS, type SizeId } from "./config";

/** Axial neighbour offsets on a pointy-top hex grid. */
const AXIAL: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** The static board: hex positions, names, lakes, cities and land adjacency. Indexed by hex id. */
export type GameMap = {
  radius: number;
  q: number[];
  r: number[];
  name: string[];
  lake: boolean[];
  city: boolean[];
  /** Land neighbours of each land hex; empty for lakes. */
  adj: number[][];
  /** Each player's starting hex, which is also its capital, in seat order. */
  starts: number[];
};

export const NEUTRAL = -1;

/** Who holds each hex and with how many troops, plus the players. Lakes are NEUTRAL with 0 troops. */
export type State = {
  round: number;
  owner: number[];
  troops: number[];
  players: PlayerState[];
};

export type PlayerState = {
  id: string;
  name: string;
  alive: boolean;
  out?: string;
  outRound?: number;
  /** Round at which the player first reached its current region count, for the round-limit tiebreak. */
  reachedAt: number;
  /** Rounds in a row the player's order was a fallback after an error or timeout. */
  fallbacks: number;
};

/** Every hex within `radius` of the centre, ring by ring from the centre outwards. */
function hexes(radius: number) {
  const out: [number, number][] = [];
  for (let r = -radius; r <= radius; r++) {
    for (let q = -radius; q <= radius; q++) if (Math.abs(q + r) <= radius) out.push([q, r]);
  }
  return out;
}

const distance = (q1: number, r1: number, q2: number, r2: number) =>
  (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(q1 + r1 - q2 - r2)) / 2;

export const hexDistance = (m: GameMap, a: number, b: number) => distance(m.q[a], m.r[a], m.q[b], m.r[b]);

/** Land hexes connected to `from`, counted by flood fill over `blocked`. */
function reachable(n: number, nb: number[][], blocked: boolean[], from: number) {
  const seen = new Uint8Array(n);
  const stack = [from];
  seen[from] = 1;
  let count = 0;
  while (stack.length) {
    const c = stack.pop()!;
    count++;
    for (const x of nb[c]) {
      if (!seen[x] && !blocked[x]) {
        seen[x] = 1;
        stack.push(x);
      }
    }
  }
  return count;
}

/**
 * A hexagon of hexes with about 10% lakes (land always connected), a fixed number
 * of cities, and one start per player spaced evenly around the edge.
 */
export function generateMap(seed: number, size: SizeId, players: number): GameMap {
  const { radius, cities } = SIZES[size];
  const rng = createRng(seed);
  const cells = hexes(radius);
  const n = cells.length;
  const index = new Map(cells.map(([q, r], i) => [`${q},${r}`, i]));
  const q = cells.map((c) => c[0]);
  const r = cells.map((c) => c[1]);
  const name = cells.map(([cq, cr]) => `${String.fromCharCode(65 + cq + radius)}${cr + radius + 1}`);
  const nb = cells.map(([cq, cr]) => AXIAL.map(([dq, dr]) => index.get(`${cq + dq},${cr + dr}`)).filter((x): x is number => x !== undefined));

  // The edge ring, walked in order, so evenly spaced picks are evenly spaced around the map.
  const ring: number[] = [];
  let cq = -radius, cr = radius;
  for (const [dq, dr] of AXIAL) {
    for (let step = 0; step < radius; step++) {
      ring.push(index.get(`${cq},${cr}`)!);
      cq += dq;
      cr += dr;
    }
  }
  const offset = rng.int(0, ring.length - 1);
  const starts = Array.from({ length: players }, (_, k) => ring[(offset + Math.round((k * ring.length) / players)) % ring.length]);

  const nearStart = (i: number) => starts.some((s) => distance(q[i], r[i], q[s], r[s]) <= 1);
  const lake = new Array<boolean>(n).fill(false);
  const lakes = Math.round(n * (0.09 + rng.next() * 0.02));
  let placed = 0;
  for (let attempt = 0; attempt < 500 && placed < lakes; attempt++) {
    const i = rng.int(0, n - 1);
    if (lake[i] || nearStart(i)) continue;
    lake[i] = true;
    const land = lake.filter((l) => !l).length;
    if (reachable(n, nb, lake, starts[0]) === land) placed++;
    else lake[i] = false;
  }

  const city = new Array<boolean>(n).fill(false);
  const cityHexes: number[] = [];
  // Cities stay off the starts' doorsteps and apart from each other; crowded small maps relax that in passes.
  const order = rng.shuffle(cells.map((_, i) => i));
  const passes: { gap: number; clearOfStarts: boolean }[] = [
    { gap: 2, clearOfStarts: true },
    { gap: 1, clearOfStarts: true },
    { gap: 1, clearOfStarts: false },
  ];
  for (const { gap, clearOfStarts } of passes) {
    for (const i of order) {
      if (cityHexes.length >= cities) break;
      if (lake[i] || city[i] || starts.includes(i) || (clearOfStarts && nearStart(i))) continue;
      if (cityHexes.some((c) => distance(q[i], r[i], q[c], r[c]) < gap + 1)) continue;
      city[i] = true;
      cityHexes.push(i);
    }
  }

  // Capitals defend and pay like cities, on top of the neutral cities placed above.
  for (const st of starts) city[st] = true;

  const adj = nb.map((list, i) => (lake[i] ? [] : list.filter((x) => !lake[x])));
  return { radius, q, r, name, lake, city, adj, starts };
}

export function newState(m: GameMap): State {
  const n = m.q.length;
  const owner = new Array<number>(n).fill(NEUTRAL);
  const troops = m.lake.map<number>((l, i) => (l ? 0 : m.city[i] ? CITY_TROOPS : NEUTRAL_TROOPS));
  m.starts.forEach((s, p) => {
    owner[s] = p;
    troops[s] = START_TROOPS;
  });
  const players = m.starts.map((_, p) => ({ ...PLAYERS[p], alive: true, reachedAt: 0, fallbacks: 0 }));
  return { round: 0, owner, troops, players };
}

export function cloneState(s: State): State {
  return { round: s.round, owner: [...s.owner], troops: [...s.troops], players: s.players.map((p) => ({ ...p })) };
}

export const landHexes = (m: GameMap) => m.lake.flatMap((l, i) => (l ? [] : [i]));
export const regionsOf = (s: State, p: number) => s.owner.reduce((n, o) => (o === p ? n + 1 : n), 0);
export const troopsOf = (s: State, p: number) => s.owner.reduce((n, o, i) => (o === p ? n + s.troops[i] : n), 0);
/** The player whose capital is on this hex, or -1. */
export const capitalOf = (m: GameMap, hex: number) => m.starts.indexOf(hex);

export const citiesOf = (m: GameMap, s: State, p: number) => s.owner.reduce((n, o, i) => (o === p && m.city[i] ? n + 1 : n), 0);
