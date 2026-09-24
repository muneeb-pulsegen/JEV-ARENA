import { createRng } from "../games/rng";
import { SEATS, SIZES, type SizeId } from "./config";

export type Dir = "U" | "D" | "L" | "R";
export const DIRS: Dir[] = ["U", "D", "L", "R"];
const WORD: Record<Dir, string> = { U: "up", D: "down", L: "left", R: "right" };

export const WALL = -2;
export const EMPTY = -1;

export type Seat = {
  id: string;
  name: string;
  pos: number;
  dir: Dir;
  alive: boolean;
  out?: string;
  outAt?: number;
  cells: number;
  moves: number;
  /** When the seat reached its current cell count, for the time-limit tiebreak. */
  reachedAt: number;
};

/** `occ` holds WALL, EMPTY, or the index of the seat whose trail or head is on the cell. */
export type Board = { grid: number; occ: Int16Array; seats: Seat[] };

export type MoveResult = { moved: true; to: number } | { moved: false; reason: string };

export type SeatResult = {
  seat: number;
  id: string;
  name: string;
  place: number;
  cells: number;
  moves: number;
  out?: string;
  outAt?: number;
};

export const delta = (grid: number, d: Dir) => (d === "U" ? -grid : d === "D" ? grid : d === "L" ? -1 : 1);
const neighbours = (grid: number, i: number) => DIRS.map((d) => i + delta(grid, d));
const isBorder = (grid: number, i: number) => {
  const x = i % grid, y = Math.floor(i / grid);
  return x === 0 || y === 0 || x === grid - 1 || y === grid - 1;
};

export const rowCol = (grid: number, i: number) => `row ${Math.floor(i / grid) + 1} col ${(i % grid) + 1}`;

export function cloneBoard(b: Board): Board {
  return { grid: b.grid, occ: b.occ.slice(), seats: b.seats.map((s) => ({ ...s })) };
}

/** Counts open cells connected to `from`, or all open cells when every one of them is reachable. */
function connectedOpen(grid: number, occ: Int16Array, from: number) {
  const seen = new Uint8Array(occ.length);
  const stack = [from];
  seen[from] = 1;
  let n = 0;
  while (stack.length) {
    const c = stack.pop()!;
    n++;
    for (const nb of neighbours(grid, c)) {
      if (!seen[nb] && occ[nb] !== WALL) {
        seen[nb] = 1;
        stack.push(nb);
      }
    }
  }
  return n;
}

/**
 * A square arena with border walls, clustered interior obstacles on 3–5% of the
 * interior, and starts spaced evenly around the centre, each facing it.
 */
export function generateArena(seed: number, size: SizeId, seatCount: number): Board {
  const { grid } = SIZES[size];
  const rng = createRng(seed);
  const occ = new Int16Array(grid * grid).fill(EMPTY);
  for (let i = 0; i < occ.length; i++) if (isBorder(grid, i)) occ[i] = WALL;

  const c = (grid - 1) / 2;
  const r = c - 3.5;
  const offset = rng.next() * Math.PI * 2;
  const seats: Seat[] = [];
  for (let k = 0; k < seatCount; k++) {
    const a = offset + (k * Math.PI * 2) / seatCount;
    const x = Math.round(c + r * Math.cos(a));
    const y = Math.round(c + r * Math.sin(a));
    const dx = c - x, dy = c - y;
    const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "R" : "L") : dy > 0 ? "D" : "U";
    seats.push({ ...SEATS[k], pos: y * grid + x, dir, alive: true, cells: 1, moves: 0, reachedAt: 0 });
  }

  // Keep each start's surroundings and the lane ahead of it clear.
  const keep = new Uint8Array(occ.length);
  for (const s of seats) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keep[s.pos + dy * grid + dx] = 1;
    let p = s.pos;
    for (let step = 0; step < 4; step++) {
      p += delta(grid, s.dir);
      if (isBorder(grid, p)) break;
      keep[p] = 1;
    }
  }

  const interior = (grid - 2) ** 2;
  const target = Math.round(interior * (0.035 + rng.next() * 0.01));
  let placed = 0;
  for (let attempt = 0; attempt < 2000 && placed < target; attempt++) {
    const start = rng.int(1, grid - 2) * grid + rng.int(1, grid - 2);
    if (occ[start] !== EMPTY || keep[start]) continue;
    const want = Math.min(rng.int(3, 8), target - placed);
    const cluster = [start];
    occ[start] = WALL;
    for (let tries = 0; cluster.length < want && tries < want * 6; tries++) {
      const next = rng.pick(neighbours(grid, rng.pick(cluster)));
      if (occ[next] !== EMPTY || keep[next]) continue;
      occ[next] = WALL;
      cluster.push(next);
    }
    const open = occ.reduce((n, v) => (v === EMPTY ? n + 1 : n), 0);
    if (connectedOpen(grid, occ, seats[0].pos) === open) placed += cluster.length;
    else for (const cell of cluster) occ[cell] = EMPTY;
  }

  seats.forEach((s, i) => (occ[s.pos] = i));
  return { grid, occ, seats };
}

/** What moving `dir` would run into, or null if the destination is empty. */
function obstacle(b: Board, seat: number, dest: number): { kind: "wall" | "own" | "trail" | "head"; owner?: Seat } | null {
  const o = b.occ[dest];
  if (o === EMPTY) return null;
  if (o === WALL) return { kind: "wall" };
  if (o === seat) return { kind: "own" };
  const owner = b.seats[o];
  return { kind: owner.pos === dest ? "head" : "trail", owner };
}

/** Applies one step for a living seat. Hitting a wall, any trail, or any head eliminates the mover. */
export function applyMove(b: Board, seat: number, dir: Dir, t: number): MoveResult {
  const s = b.seats[seat];
  const dest = s.pos + delta(b.grid, dir);
  const hit = obstacle(b, seat, dest);
  s.dir = dir;
  if (hit) {
    const reason =
      hit.kind === "wall" ? "crashed into a wall" : hit.kind === "own" ? "crashed into its own trail" : `crashed into ${hit.owner!.name}'s ${hit.kind}`;
    eliminate(b, seat, reason, t);
    return { moved: false, reason };
  }
  b.occ[dest] = seat;
  s.pos = dest;
  s.cells++;
  s.moves++;
  s.reachedAt = t;
  return { moved: true, to: dest };
}

/** Takes a seat out. Its trail and head stay on the board as obstacles. */
export function eliminate(b: Board, seat: number, reason: string, t: number) {
  const s = b.seats[seat];
  if (!s.alive) return;
  s.alive = false;
  s.out = reason;
  s.outAt = t;
}

export const aliveSeats = (b: Board) => b.seats.flatMap((s, i) => (s.alive ? [i] : []));

/** The last seat alive, or null while two or more remain. */
export function winnerOf(b: Board): number | null {
  const alive = aliveSeats(b);
  return alive.length === 1 ? alive[0] : null;
}

/** At the time limit: most cells among the living, then earliest to reach that count, then seat order. */
export function timeWinner(b: Board): number {
  const pool = aliveSeats(b).length ? aliveSeats(b) : b.seats.map((_, i) => i);
  return pool.reduce((best, i) => {
    const s = b.seats[i], w = b.seats[best];
    return s.cells > w.cells || (s.cells === w.cells && s.reachedAt < w.reachedAt) ? i : best;
  });
}

/** Winner first, then the living by cells, then the eliminated from last out to first out. */
export function standings(b: Board, winner: number): SeatResult[] {
  const order = b.seats
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i !== winner)
    .sort((a, z) => {
      if (a.s.alive !== z.s.alive) return a.s.alive ? -1 : 1;
      if (a.s.alive) return z.s.cells - a.s.cells || a.s.reachedAt - z.s.reachedAt || a.i - z.i;
      return (z.s.outAt ?? 0) - (a.s.outAt ?? 0) || z.i - a.i;
    });
  return [{ s: b.seats[winner], i: winner }, ...order].map(({ s, i }, n) => ({
    seat: i,
    id: s.id,
    name: s.name,
    place: n + 1,
    cells: s.cells,
    moves: s.moves,
    ...(s.out ? { out: s.out, outAt: s.outAt } : {}),
  }));
}

/** Empty cells reachable from the destination (counted as occupied), and the living rivals whose heads border them. */
export function room(b: Board, seat: number, dir: Dir): { cells: number; rivals: number[] } {
  const dest = b.seats[seat].pos + delta(b.grid, dir);
  if (b.occ[dest] !== EMPTY) return { cells: 0, rivals: [] };
  const seen = new Uint8Array(b.occ.length);
  seen[dest] = 1;
  const stack: number[] = [];
  for (const nb of neighbours(b.grid, dest)) {
    if (b.occ[nb] === EMPTY && !seen[nb]) {
      seen[nb] = 1;
      stack.push(nb);
    }
  }
  const heads = new Map<number, number>();
  b.seats.forEach((s, i) => s.alive && i !== seat && heads.set(s.pos, i));
  const rivals = new Set<number>();
  let cells = 0;
  while (stack.length) {
    const c = stack.pop()!;
    cells++;
    for (const nb of neighbours(b.grid, c)) {
      const h = heads.get(nb);
      if (h !== undefined) rivals.add(h);
      if (b.occ[nb] === EMPTY && !seen[nb]) {
        seen[nb] = 1;
        stack.push(nb);
      }
    }
  }
  return { cells, rivals: [...rivals].sort((a, z) => a - z) };
}

/** Living rivals whose heads are orthogonally next to the destination, so they could also step there. */
export function contested(b: Board, seat: number, dir: Dir): number[] {
  const dest = b.seats[seat].pos + delta(b.grid, dir);
  if (b.occ[dest] !== EMPTY) return [];
  const around = new Set(neighbours(b.grid, dest));
  return b.seats.flatMap((s, i) => (i !== seat && s.alive && around.has(s.pos) ? [i] : []));
}

const names = (b: Board, seats: number[]) => {
  const n = seats.map((i) => b.seats[i].name);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
};

export function renderMap(b: Board): string {
  const heads = new Map(b.seats.map((s) => [s.pos, s]));
  const rows: string[] = [];
  for (let y = 0; y < b.grid; y++) {
    let row = "";
    for (let x = 0; x < b.grid; x++) {
      const i = y * b.grid + x;
      const o = b.occ[i];
      const head = heads.get(i);
      if (o === WALL) row += "#";
      else if (o === EMPTY) row += ".";
      else if (head && head.alive) row += head.id;
      else row += b.seats[o].id.toLowerCase();
    }
    rows.push(row);
  }
  return rows.join("\n");
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const INSTRUCTIONS = [
  "You are playing Live Arena, a last-one-standing game on a shared grid against other players.",
  "Each move is one step up, down, left or right. Every cell you leave becomes your trail, permanently.",
  "Moving into a wall, any trail (including your own) or any player's head eliminates you. A crashed player's trail and head stay on the board.",
  "The last player left alive wins. If time runs out first, the living player with the most cells claimed wins.",
  "Rivals move independently and at the same time as you, so the board may change between when you look and when your move lands.",
  "Map legend: # wall, . empty, R/B/G/Y/V/T heads of living players, r/b/g/y/v/t trails (and heads of crashed players).",
  "Each option states its outcome. FATAL: the move eliminates you. CONTESTED: a rival's head is next to that cell, so it could step there first.",
  "Room: how many empty cells you can still reach after the move, and which rivals can reach that same region.",
  "Pick the option that keeps you alive longest and gives you the most room.",
].join("\n");

/** The per-call state text for one seat. Trail coordinates are not listed; the map carries them. */
export function describeState(b: Board, seat: number, elapsedMs: number, limitMs: number): string {
  const me = b.seats[seat];
  const alive = b.seats.filter((s) => s.alive).map((s) => s.name);
  const out = b.seats.filter((s) => !s.alive).map((s) => `${s.name} (${s.out})`);
  const heads = b.seats
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => i !== seat && s.alive)
    .map(({ s }) => `${s.name}'s head: ${rowCol(b.grid, s.pos)}, heading ${WORD[s.dir]}.`);
  return [
    `You are ${me.name.toUpperCase()} (${me.id}). Alive: ${alive.join(", ")}.${out.length ? ` Out: ${out.join(", ")}.` : ""}`,
    `You have claimed ${me.cells} cells. Match time ${clock(elapsedMs)} of ${clock(limitMs)}.`,
    `Map (row 1 top). # wall, . empty, R/B/G/Y/V/T heads, r/b/g/y/v/t trails:`,
    renderMap(b),
    [`You are at ${rowCol(b.grid, me.pos)}, heading ${WORD[me.dir]}.`, ...heads].join(" "),
  ].join("\n");
}

/** The four options, each describing its concrete outcome on the current board. */
export function describeOptions(b: Board, seat: number): Record<Dir, string> {
  const me = b.seats[seat];
  const out = {} as Record<Dir, string>;
  for (const d of DIRS) {
    const dest = me.pos + delta(b.grid, d);
    const head = `Move ${WORD[d]} to ${rowCol(b.grid, dest)}.`;
    const hit = obstacle(b, seat, dest);
    if (hit) {
      const what =
        hit.kind === "wall" ? "a wall is there" : hit.kind === "own" ? "your own trail" : `${hit.owner!.name}'s ${hit.kind} is there`;
      out[d] = `${head} FATAL: ${what}.`;
      continue;
    }
    const rivals = contested(b, seat, d);
    const r = room(b, seat, d);
    const cont = rivals.length ? ` CONTESTED: ${names(b, rivals)} can also reach this cell with one move.` : "";
    const shared = r.rivals.length ? `shared with ${names(b, r.rivals)}` : "sealed off, only you";
    out[d] = `${head} Open.${cont} Room after this move: ${r.cells} cells, ${shared}.`;
  }
  return out;
}
