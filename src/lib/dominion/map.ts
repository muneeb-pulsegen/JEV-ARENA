import { createRng } from "../games/rng";
import { RESOURCES, SIZES, TERRAIN, type Resource, type SizeId, type Terrain } from "./config";

const AXIAL: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** The static world: hex positions, names, terrain, resources and starts. Indexed by hex id. */
export type GameMap = {
  radius: number;
  q: number[];
  r: number[];
  name: string[];
  terrain: Terrain[];
  resource: (Resource | null)[];
  /** All neighbours of each hex. */
  nb: number[][];
  /** Each player's starting hex (its capital), in seat order. */
  starts: number[];
};

export const distance = (m: GameMap, a: number, b: number) =>
  (Math.abs(m.q[a] - m.q[b]) + Math.abs(m.r[a] - m.r[b]) + Math.abs(m.q[a] + m.r[a] - m.q[b] - m.r[b])) / 2;

export const passable = (m: GameMap, i: number) => TERRAIN[m.terrain[i]].passable;

/** Hexes within `radius` of `centre`, centre included. */
export function around(m: GameMap, centre: number, radius: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.q.length; i++) if (distance(m, centre, i) <= radius) out.push(i);
  return out;
}

/** Shortest passable path from `from` to `to` (both included), or null. `to` may itself be impassable only if it is `from`. */
export function path(m: GameMap, from: number, to: number): number[] | null {
  if (from === to) return [from];
  const prev = new Int32Array(m.q.length).fill(-1);
  prev[from] = from;
  const queue = [from];
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k];
    for (const n of m.nb[c]) {
      if (prev[n] !== -1 || !passable(m, n)) continue;
      prev[n] = c;
      if (n === to) {
        const out = [to];
        for (let x = c; x !== from; x = prev[x]) out.push(x);
        out.push(from);
        return out.reverse();
      }
      queue.push(n);
    }
  }
  return null;
}

/** Passable steps between two hexes, or Infinity if unreachable. */
export const steps = (m: GameMap, a: number, b: number) => {
  const p = path(m, a, b);
  return p ? p.length - 1 : Infinity;
};

const WEIGHTS: [Terrain, number][] = [
  ["grassland", 28],
  ["plains", 25],
  ["forest", 18],
  ["hills", 13],
  ["desert", 6],
  ["lake", 5],
  ["mountain", 5],
];

/** Which resources can sit on which terrain. */
const FITS: Record<Resource, Terrain[]> = {
  wheat: ["grassland", "plains"],
  horses: ["plains", "grassland"],
  iron: ["hills"],
  gold: ["hills", "desert"],
  marble: ["plains", "hills"],
};

/**
 * A hexagon of clustered terrain (nearest-seed patches), with every passable hex
 * connected, one start per player spaced around a ring, good land at each start,
 * and wheat, horses and iron within reach of every start.
 */
export function generateMap(seed: number, size: SizeId, players: number): GameMap {
  const R = SIZES[size].radius;
  const rng = createRng(seed);
  const cells: [number, number][] = [];
  for (let r = -R; r <= R; r++) for (let q = -R; q <= R; q++) if (Math.abs(q + r) <= R) cells.push([q, r]);
  const n = cells.length;
  const index = new Map(cells.map(([q, r], i) => [`${q},${r}`, i]));
  const m: GameMap = {
    radius: R,
    q: cells.map((c) => c[0]),
    r: cells.map((c) => c[1]),
    name: cells.map(([q, r]) => `${String.fromCharCode(65 + q + R)}${r + R + 1}`),
    terrain: [],
    resource: new Array(n).fill(null),
    nb: cells.map(([q, r]) => AXIAL.map(([dq, dr]) => index.get(`${q + dq},${r + dr}`)).filter((x): x is number => x !== undefined)),
    starts: [],
  };

  // Terrain: each hex takes the terrain of its nearest seed, so land comes in patches.
  const total = WEIGHTS.reduce((s, [, w]) => s + w, 0);
  const pickTerrain = () => {
    let x = rng.next() * total;
    for (const [t, w] of WEIGHTS) if ((x -= w) < 0) return t;
    return "grassland" as Terrain;
  };
  const seeds = Array.from({ length: Math.max(10, Math.round(n / 4)) }, () => ({ at: rng.int(0, n - 1), t: pickTerrain(), jitter: rng.next() }));
  m.terrain = cells.map((_, i) => {
    let best = seeds[0], bestD = Infinity;
    for (const s of seeds) {
      const d = distance(m, i, s.at) + s.jitter * 0.9;
      if (d < bestD) (best = s), (bestD = d);
    }
    return best.t;
  });

  // Starts: evenly spaced on a ring two hexes in from the edge.
  const ringR = Math.max(2, R - 2);
  const ring: number[] = [];
  let cq = -ringR, cr = ringR;
  for (const [dq, dr] of AXIAL) {
    for (let s = 0; s < ringR; s++) {
      ring.push(index.get(`${cq},${cr}`)!);
      cq += dq;
      cr += dr;
    }
  }
  const offset = rng.int(0, ring.length - 1);
  m.starts = Array.from({ length: players }, (_, k) => ring[(offset + Math.round((k * ring.length) / players)) % ring.length]);

  // Good land at every start: the start itself and at least four of its neighbours can feed a city.
  for (const s of m.starts) {
    m.terrain[s] = rng.next() < 0.5 ? "grassland" : "plains";
    for (const x of m.nb[s]) if (!TERRAIN[m.terrain[x]].passable || m.terrain[x] === "desert") m.terrain[x] = rng.next() < 0.6 ? "grassland" : "plains";
  }

  // Keep impassable terrain under a fifth of the map.
  const blocked = () => m.terrain.filter((t) => !TERRAIN[t].passable).length;
  for (const i of rng.shuffle([...m.terrain.keys()])) {
    if (blocked() <= n * 0.18) break;
    if (!TERRAIN[m.terrain[i]].passable) m.terrain[i] = "plains";
  }

  // Connect every passable pocket to the first start by turning the blocking hexes on a shortest route into hills.
  for (let guard = 0; guard < n; guard++) {
    const reach = new Uint8Array(n);
    const stack = [m.starts[0]];
    reach[m.starts[0]] = 1;
    while (stack.length) for (const x of m.nb[stack.pop()!]) if (!reach[x] && passable(m, x)) (reach[x] = 1), stack.push(x);
    const cut = [...m.terrain.keys()].find((i) => passable(m, i) && !reach[i]);
    if (cut === undefined) break;
    const prev = new Int32Array(n).fill(-1);
    prev[cut] = cut;
    const queue = [cut];
    let hit = -1;
    for (let k = 0; k < queue.length && hit < 0; k++) {
      for (const x of m.nb[queue[k]]) {
        if (prev[x] !== -1) continue;
        prev[x] = queue[k];
        if (reach[x]) {
          hit = x;
          break;
        }
        queue.push(x);
      }
    }
    for (let x = prev[hit]; x !== cut; x = prev[x]) if (!passable(m, x)) m.terrain[x] = "hills";
  }

  // Resources: wheat, horses and iron near every start, then a sprinkling at random.
  const place = (res: Resource, near: number, minD: number, maxD: number) => {
    const spots = rng.shuffle(around(m, near, maxD)).filter((i) => distance(m, near, i) >= minD && !m.starts.includes(i) && m.resource[i] === null);
    let spot = spots.find((i) => FITS[res].includes(m.terrain[i]));
    if (spot === undefined) {
      spot = spots.find((i) => passable(m, i));
      if (spot === undefined) return;
      m.terrain[spot] = FITS[res][0];
    }
    m.resource[spot] = res;
  };
  for (const s of m.starts) {
    place("wheat", s, 1, 2);
    place("horses", s, 2, 4);
    place("iron", s, 2, 4);
  }
  const kinds = Object.keys(RESOURCES) as Resource[];
  for (const i of rng.shuffle([...m.terrain.keys()])) {
    if (m.resource[i] !== null || m.starts.includes(i) || !passable(m, i) || rng.next() > 0.07) continue;
    const fits = kinds.filter((k) => FITS[k].includes(m.terrain[i]));
    if (fits.length) m.resource[i] = rng.pick(fits);
  }
  return m;
}

/** A compact grid, one character per hex, rows offset like the hexes. Used in the state text. */
export function grid(m: GameMap, cell: (i: number) => string): string {
  const R = m.radius;
  const lines: string[] = [];
  for (let r = -R; r <= R; r++) {
    const row: string[] = [];
    let first = "";
    for (let q = -R; q <= R; q++) {
      if (Math.abs(q + r) > R) continue;
      const i = m.q.findIndex((qq, k) => qq === q && m.r[k] === r);
      if (!first) first = m.name[i];
      row.push(cell(i));
    }
    lines.push(`${String(r + R + 1).padStart(2)} ${first.padEnd(3)}${" ".repeat(Math.abs(r))}${row.join(" ")}`);
  }
  return lines.join("\n");
}
