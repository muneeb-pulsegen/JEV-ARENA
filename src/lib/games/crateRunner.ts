import { createRng, deriveSeed, type Rng } from "./rng";
import type { GameDef, GameSession } from "./types";
import { LIFE_PENALTY, type CrateView, type LadderStep } from "./views";
import type { Choices } from "../agents/types";

export type LevelConfig = { size: number; boxes: number; walls: [number, number]; minPar: number; pulls: number };

export const CRATE_LADDER: LevelConfig[] = [
  { size: 7, boxes: 1, walls: [2, 4], minPar: 8, pulls: 60 },
  { size: 8, boxes: 2, walls: [4, 8], minPar: 14, pulls: 100 },
  { size: 8, boxes: 2, walls: [6, 10], minPar: 20, pulls: 160 },
  { size: 9, boxes: 3, walls: [10, 16], minPar: 24, pulls: 220 },
  { size: 9, boxes: 3, walls: [10, 16], minPar: 32, pulls: 300 },
];
const TOTAL_WEIGHT = CRATE_LADDER.reduce((a, _, i) => a + i + 1, 0);
export const LIVES = 3;
const SOLVER_STATE_CAP = 400_000;

export type Dir = "U" | "D" | "L" | "R";
const DIRS: Dir[] = ["U", "D", "L", "R"];
const delta = (size: number, d: Dir) => (d === "U" ? -size : d === "D" ? size : d === "L" ? -1 : 1);

const DIR_WORD: Record<Dir, string> = { U: "up (toward row 1)", D: "down (toward the bottom row)", L: "left", R: "right" };
const where = (size: number, i: number) => `row ${Math.floor(i / size) + 1} col ${(i % size) + 1}`;
const onBorder = (size: number, i: number) => {
  const x = i % size, y = Math.floor(i / size);
  return x === 0 || y === 0 || x === size - 1 || y === size - 1;
};

export type Level = { size: number; walls: boolean[]; targets: number[]; boxes: number[]; player: number };
export type State = { boxes: number[]; player: number };

const key = (s: State) => `${s.player}|${[...s.boxes].sort((a, b) => a - b).join(",")}`;

export function applyMove(level: Level, s: State, d: Dir): State | null {
  const step = delta(level.size, d);
  const np = s.player + step;
  if (level.walls[np]) return null;
  const bi = s.boxes.indexOf(np);
  if (bi === -1) return { boxes: s.boxes, player: np };
  const nb = np + step;
  if (level.walls[nb] || s.boxes.includes(nb)) return null;
  const boxes = [...s.boxes];
  boxes[bi] = nb;
  return { boxes, player: np };
}

export const isSolved = (level: Level, s: State) => s.boxes.every((b) => level.targets.includes(b));

/** A box off-target in a corner can never move again. */
export function hasCornerDeadlock(level: Level, s: State): boolean {
  const w = (i: number) => level.walls[i];
  return s.boxes.some((b) => {
    if (level.targets.includes(b)) return false;
    const up = w(b - level.size), down = w(b + level.size), left = w(b - 1), right = w(b + 1);
    return (up || down) && (left || right);
  });
}

/** Move-optimal BFS. Returns the move string, null if unsolvable, or undefined if the state cap was hit. */
export function solve(level: Level, start: State, cap = SOLVER_STATE_CAP): string | null | undefined {
  if (isSolved(level, start)) return "";
  if (hasCornerDeadlock(level, start)) return null;
  const seen = new Map<string, { prev: string | null; dir: Dir | null }>();
  seen.set(key(start), { prev: null, dir: null });
  let frontier: State[] = [start];
  while (frontier.length) {
    const next: State[] = [];
    for (const s of frontier) {
      for (const d of DIRS) {
        const n = applyMove(level, s, d);
        if (!n) continue;
        const k = key(n);
        if (seen.has(k)) continue;
        seen.set(k, { prev: key(s), dir: d });
        if (isSolved(level, n)) {
          const path: Dir[] = [];
          let cur: string | null = k;
          while (cur) {
            const e: { prev: string | null; dir: Dir | null } = seen.get(cur)!;
            if (e.dir) path.push(e.dir);
            cur = e.prev;
          }
          return path.reverse().join("");
        }
        if (seen.size > cap) return undefined;
        if (n.boxes !== s.boxes && hasCornerDeadlock(level, n)) continue;
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

/** Walls off every floor cell not connected to the largest open region. */
function fillPockets(size: number, walls: boolean[]): number {
  const seen = new Set<number>();
  let best: number[] = [];
  for (let i = 0; i < walls.length; i++) {
    if (walls[i] || seen.has(i)) continue;
    const region = [i];
    seen.add(i);
    for (let k = 0; k < region.length; k++) {
      for (const d of DIRS) {
        const n = region[k] + delta(size, d);
        if (!walls[n] && !seen.has(n)) {
          seen.add(n);
          region.push(n);
        }
      }
    }
    if (region.length > best.length) best = region;
  }
  const keep = new Set(best);
  for (let i = 0; i < walls.length; i++) if (!walls[i] && !keep.has(i)) walls[i] = true;
  return best.length;
}

function pullWalk(rng: Rng, size: number, walls: boolean[], targets: number[], start: number, pulls: number): State {
  let s: State = { boxes: [...targets], player: start };
  for (let i = 0; i < pulls; i++) {
    const d = rng.pick(DIRS);
    const np = s.player + delta(size, d);
    if (walls[np] || s.boxes.includes(np)) continue;
    const bi = s.boxes.indexOf(s.player - delta(size, d));
    if (bi !== -1 && rng.next() < 0.85) {
      const boxes = [...s.boxes];
      boxes[bi] = s.player;
      s = { boxes, player: np };
    } else {
      s = { boxes: s.boxes, player: np };
    }
  }
  return s;
}

/**
 * Builds a level by pulling boxes backwards off their targets, so it is always solvable.
 * Returns the first candidate whose optimal solution reaches `minPar`, or the hardest one found.
 */
export function generateLevel(rng: Rng, cfg: LevelConfig): { level: Level; par: number } {
  const { size } = cfg;
  let best: { level: Level; par: number } | null = null;
  for (let layout = 0; layout < 60; layout++) {
    const walls = Array.from({ length: size * size }, (_, i) => {
      const x = i % size, y = Math.floor(i / size);
      return x === 0 || y === 0 || x === size - 1 || y === size - 1;
    });
    const interior = walls.map((w, i) => (w ? -1 : i)).filter((i) => i >= 0);
    for (const c of rng.shuffle(interior).slice(0, rng.int(cfg.walls[0], cfg.walls[1]))) walls[c] = true;
    if (fillPockets(size, walls) < cfg.boxes * 6 + 6) continue;

    const floor = walls.map((w, i) => (w ? -1 : i)).filter((i) => i >= 0);
    for (let walk = 0; walk < 8; walk++) {
      const picks = rng.shuffle(floor);
      const targets = picks.slice(0, cfg.boxes);
      const s = pullWalk(rng, size, walls, targets, picks[cfg.boxes], cfg.pulls);
      if (s.boxes.some((b) => targets.includes(b))) continue;
      const level: Level = { size, walls: [...walls], targets, boxes: s.boxes, player: s.player };
      const sol = solve(level, s, 150_000);
      if (typeof sol !== "string") continue;
      if (sol.length >= cfg.minPar) return { level, par: sol.length };
      if (!best || sol.length > best.par) best = { level, par: sol.length };
    }
  }
  if (best) return best;
  throw new Error("Could not generate a Crate Runner level");
}

export function render(level: Level, s: State): string {
  const rows: string[] = [];
  for (let y = 0; y < level.size; y++) {
    let row = "";
    for (let x = 0; x < level.size; x++) {
      const i = y * level.size + x;
      const t = level.targets.includes(i);
      if (level.walls[i]) row += "#";
      else if (s.player === i) row += t ? "+" : "@";
      else if (s.boxes.includes(i)) row += t ? "*" : "$";
      else row += t ? "." : "-";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** Boxes in reading order (top row first, then left to right), labelled A, B, C. */
export function labelBoxes(boxes: number[]): { cell: number; label: string }[] {
  return [...boxes].sort((a, b) => a - b).map((cell, i) => ({ cell, label: BOX_LABELS[i] }));
}
const BOX_LABELS = "ABCDEFGH";

/** Walking distance from `from` to every cell reachable without pushing a box. */
export function walkDistances(level: Level, boxes: number[], from: number): Map<number, number> {
  const dist = new Map([[from, 0]]);
  let frontier = [from];
  while (frontier.length) {
    const next: number[] = [];
    for (const p of frontier) {
      for (const d of DIRS) {
        const n = p + delta(level.size, d);
        if (level.walls[n] || boxes.includes(n) || dist.has(n)) continue;
        dist.set(n, dist.get(p)! + 1);
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

export type Push = { box: number; dir: Dir; walk: number };

/** Every push the player can make right now: the cell behind the box is reachable and the cell ahead is free. */
export function legalPushes(level: Level, s: State): Push[] {
  const dist = walkDistances(level, s.boxes, s.player);
  const out: Push[] = [];
  for (const box of [...s.boxes].sort((a, b) => a - b)) {
    for (const dir of DIRS) {
      const behind = box - delta(level.size, dir), ahead = box + delta(level.size, dir);
      if (!dist.has(behind) || level.walls[ahead] || s.boxes.includes(ahead)) continue;
      out.push({ box, dir, walk: dist.get(behind)! });
    }
  }
  return out;
}

export function applyPush(level: Level, s: State, box: number, dir: Dir): State {
  return { boxes: s.boxes.map((b) => (b === box ? box + delta(level.size, dir) : b)), player: box };
}

/** Positions that differ only by where the player stands inside the same open area are the same position. */
export function positionKey(level: Level, s: State): string {
  const area = Math.min(...walkDistances(level, s.boxes, s.player).keys());
  return `${area}|${[...s.boxes].sort((a, b) => a - b).join(",")}`;
}

/** Push-optimal BFS: the fewest pushes that solve the level, null if unsolvable, undefined if the state cap was hit. */
export function solvePushes(level: Level, start: State, cap = SOLVER_STATE_CAP): Push[] | null | undefined {
  if (isSolved(level, start)) return [];
  if (hasCornerDeadlock(level, start)) return null;
  const k0 = positionKey(level, start);
  const seen = new Map<string, { prev: string | null; push: Push | null }>([[k0, { prev: null, push: null }]]);
  let frontier: { s: State; k: string }[] = [{ s: start, k: k0 }];
  while (frontier.length) {
    const next: { s: State; k: string }[] = [];
    for (const { s, k } of frontier) {
      for (const p of legalPushes(level, s)) {
        const n = applyPush(level, s, p.box, p.dir);
        if (hasCornerDeadlock(level, n)) continue;
        const nk = positionKey(level, n);
        if (seen.has(nk)) continue;
        seen.set(nk, { prev: k, push: p });
        if (isSolved(level, n)) {
          const path: Push[] = [];
          let cur: string | null = nk;
          while (cur) {
            const e: { prev: string | null; push: Push | null } = seen.get(cur)!;
            if (e.push) path.push(e.push);
            cur = e.prev;
          }
          return path.reverse();
        }
        if (seen.size > cap) return undefined;
        next.push({ s: n, k: nk });
      }
    }
    frontier = next;
  }
  return null;
}

/** Spells out positions so the game tests planning rather than reading ASCII art. */
export function describePositions(level: Level, s: State): string {
  const at = (i: number) => where(level.size, i);
  const boxes = labelBoxes(s.boxes).map(({ cell, label }) => `box ${label} at ${at(cell)}${level.targets.includes(cell) ? " (on a target)" : ""}`).join("; ");
  const inner = level.walls.flatMap((w, i) => (w && !onBorder(level.size, i) ? [at(i)] : []));
  return (
    `Positions (row 1 is the top row, col 1 the left column): you at ${at(s.player)}. Boxes: ${boxes}. ` +
    `Targets: ${level.targets.map(at).join("; ")}. Walls: the whole outer border${inner.length ? `, plus ${inner.join("; ")}` : ""}.`
  );
}

/** Grid distance (ignoring walls) from `cell` to the nearest target not already covered by a different box. */
function targetGap(level: Level, boxes: number[], cell: number): number {
  const others = boxes.filter((b) => b !== cell);
  const free = level.targets.filter((t) => !others.includes(t));
  const r = Math.floor(cell / level.size), c = cell % level.size;
  return Math.min(...free.map((t) => Math.abs(Math.floor(t / level.size) - r) + Math.abs((t % level.size) - c)));
}

/** Option id for a push, e.g. "AR" = push box A right. */
export const pushId = (label: string, dir: Dir) => `${label}${dir}`;

/** The pushes available right now, each described by its exact outcome on this board. */
export function describePushes(level: Level, s: State, visits?: Map<string, number>): Choices {
  const at = (i: number) => where(level.size, i);
  const labels = new Map(labelBoxes(s.boxes).map(({ cell, label }) => [cell, label]));
  const out: Choices = {};
  for (const p of legalPushes(level, s)) {
    const label = labels.get(p.box)!;
    const to = p.box + delta(level.size, p.dir);
    const next = applyPush(level, s, p.box, p.dir);
    const behind = p.box - delta(level.size, p.dir);
    const walk = p.walk ? `You first walk ${p.walk} step${p.walk > 1 ? "s" : ""} to ${at(behind)} (the side opposite the push), then push.` : "You are already behind it.";
    let text = `Push box ${label} ${DIR_WORD[p.dir]}, from ${at(p.box)} to ${at(to)}. ${walk}`;
    if (level.targets.includes(to)) text += " The box lands ON a target.";
    else {
      const before = targetGap(level, s.boxes, p.box), after = targetGap(level, next.boxes, to);
      text += ` The box ends ${after} step${after === 1 ? "" : "s"} (grid distance, ignoring walls) from the nearest free target, ${after < before ? "closer than" : after > before ? "farther than" : "the same as"} before.`;
      if (level.targets.includes(p.box)) text += " This pushes it OFF a target.";
    }
    if (isSolved(level, next)) text += " This SOLVES the level.";
    else if (solvePushes(level, next) === null) text += " FATAL: after this push the level can no longer be solved, so you lose a life.";
    else {
      const v = visits?.get(positionKey(level, next)) ?? 0;
      if (v) text += ` REPEAT: this recreates a position you have already been in ${v} time${v > 1 ? "s" : ""} on this puzzle.`;
    }
    out[pushId(label, p.dir)] = text;
  }
  return out;
}

/** Fraction of a level's points: 0.5 for solving, up to 1 for matching the optimal push count. */
export const levelCredit = (pushesUsed: number | null, par: number) =>
  pushesUsed === null ? 0 : 0.5 + 0.5 * Math.min(1, par / pushesUsed);

/** Pushes allowed for a level of this par: generous enough to recover from a few wrong pushes. */
const pushBudget = (par: number) => Math.max(par + 6, par * 2);

type Board = {
  level: number; puzzle: Level; par: number; budget: number; pos: State; pushes: number;
  trail: string[]; visits: Map<string, number>; status: "playing" | "solved" | "failed";
};

class CrateRunnerSession implements GameSession<string> {
  private boards: Board[] = [];
  private lives = LIVES;
  private last = "";

  constructor(private seed: number) {
    this.deal(0);
  }

  /** Generates a fresh puzzle for this level; a retry after losing a life gets a new layout, not the same one. */
  private deal(idx: number) {
    let attempt = this.boards.filter((b) => b.level === idx).length;
    for (;;) {
      const { level } = generateLevel(createRng(deriveSeed(this.seed, idx * 16 + attempt)), CRATE_LADDER[idx]);
      const start = { boxes: [...level.boxes], player: level.player };
      const plan = solvePushes(level, start);
      if (Array.isArray(plan)) {
        this.boards.push({
          level: idx, puzzle: level, par: plan.length, budget: pushBudget(plan.length), pos: start, pushes: 0,
          trail: [], visits: new Map([[positionKey(level, start), 1]]), status: "playing",
        });
        return;
      }
      attempt += 100;
    }
  }

  private get board() {
    return this.boards[this.boards.length - 1];
  }

  private failsAt(idx: number) {
    return this.boards.filter((b) => b.level === idx && b.status === "failed").length;
  }

  get current() {
    const b = this.board;
    return { level: b.puzzle, par: b.par, budget: b.budget, state: b.pos };
  }

  state() {
    const b = this.board;
    const n = CRATE_LADDER[b.level].boxes;
    return [
      this.last,
      `Level ${b.level + 1} of ${CRATE_LADDER.length}: ${n} box${n > 1 ? "es" : ""}, optimal solution ${b.par} push${b.par === 1 ? "" : "es"}. ` +
        `Push ${b.pushes + 1}/${b.budget}. Lives: ${this.lives}/${LIVES}.`,
      render(b.puzzle, b.pos),
      describePositions(b.puzzle, b.pos),
      `Your pushes so far on this puzzle: ${b.trail.length ? b.trail.slice(-30).join(", ") : "none yet"}.`,
    ].filter(Boolean).join("\n");
  }

  options(): Choices {
    const b = this.board;
    return describePushes(b.puzzle, b.pos, b.visits);
  }

  step(choice: string | null, elapsedMs?: number) {
    void elapsedMs;
    const b = this.board;
    b.pushes++;
    const at = (i: number) => where(b.puzzle.size, i);
    const label = choice?.[0], dir = choice?.[1] as Dir | undefined;
    const box = labelBoxes(b.pos.boxes).find((x) => x.label === label)?.cell;
    const push = box === undefined || !dir ? undefined : legalPushes(b.puzzle, b.pos).find((p) => p.box === box && p.dir === dir);
    let applied: string;
    if (!push) {
      applied = "No valid push chosen, turn wasted.";
      b.trail.push("-");
    } else {
      b.pos = applyPush(b.puzzle, b.pos, push.box, push.dir);
      const k = positionKey(b.puzzle, b.pos);
      b.visits.set(k, (b.visits.get(k) ?? 0) + 1);
      const to = push.box + delta(b.puzzle.size, push.dir);
      applied = `Pushed box ${label} ${DIR_WORD[push.dir]} from ${at(push.box)} to ${at(to)}${b.puzzle.targets.includes(to) ? ", onto a target" : ""}.`;
      b.trail.push(`${label} ${push.dir}`);
    }

    if (isSolved(b.puzzle, b.pos)) {
      b.status = "solved";
      const note = `Level ${b.level + 1} solved in ${b.pushes} pushes (optimal ${b.par}).`;
      if (b.level < CRATE_LADDER.length - 1) this.deal(b.level + 1);
      this.last = `${applied} ${note}`;
      return;
    }
    const stuck = solvePushes(b.puzzle, b.pos) === null;
    if (stuck || b.pushes >= b.budget) {
      b.status = "failed";
      this.lives--;
      const why = stuck ? `The level can no longer be solved (level ${b.level + 1}).` : `Out of pushes on level ${b.level + 1}.`;
      if (this.lives === 0) {
        this.last = `${applied} ${why} No lives left.`;
        return;
      }
      this.last = `${applied} ${why} You lost a life (${this.lives} left); here is a new puzzle at the same level.`;
      this.deal(b.level);
      return;
    }
    this.last = applied;
  }

  done() {
    return this.lives === 0 || (this.board.status === "solved" && this.board.level === CRATE_LADDER.length - 1);
  }

  score() {
    let earned = 0;
    CRATE_LADDER.forEach((_, i) => {
      const solved = this.boards.find((b) => b.level === i && b.status === "solved");
      if (solved) earned += (i + 1) * levelCredit(solved.pushes, solved.par) * LIFE_PENALTY ** this.failsAt(i);
    });
    return Math.round((earned / TOTAL_WEIGHT) * 100);
  }

  view(): CrateView {
    const b = this.board;
    const over = this.done();
    const ladder: LadderStep[] = CRATE_LADDER.map((_, i) => {
      if (this.boards.some((x) => x.level === i && x.status === "solved")) return "passed";
      if (i === b.level) return over ? "failed" : "active";
      return "locked";
    });
    return {
      kind: "planning",
      ladder,
      lives: { left: this.lives, max: LIVES },
      size: b.puzzle.size,
      level: b.level + 1,
      levels: CRATE_LADDER.length,
      walls: b.puzzle.walls,
      targets: b.puzzle.targets,
      player: b.pos.player,
      boxes: b.pos.boxes,
      moves: b.pushes,
      par: b.par,
      turn: b.pushes,
      turns: b.budget,
      note: this.last,
    };
  }

  progress() {
    const solved = this.boards.filter((b) => b.status === "solved").length;
    if (this.done()) return `finished · ${solved}/${CRATE_LADDER.length} levels solved · ${this.lives}/${LIVES} lives left`;
    const b = this.board;
    return `level ${b.level + 1}/${CRATE_LADDER.length}, ${b.pushes}/${b.budget} pushes (optimal ${b.par}) · lives ${this.lives}/${LIVES}`;
  }
}

export const crateRunner: GameDef<string> = {
  id: "planning",
  name: "Crate Runner",
  axis: "Planning",
  blurb: `Sokoban ladder: ${CRATE_LADDER.length} puzzles from 1 box on 7×7 to 3 boxes on 9×9. One push per turn. 3 lives; making the level unsolvable or running out of pushes costs one and deals a new puzzle at the same level.`,
  instructions:
    "You are playing Crate Runner (Sokoban), a ladder of increasingly hard puzzles. Goal: get every box onto a target. " +
    "Map legend: # wall, - floor, . target, $ box, * box on target, @ you, + you on a target. Row 1 is the top. " +
    "Each turn you choose ONE PUSH: which box, and which direction. To push a box you must stand on the opposite side of it; the game " +
    "walks you there by the shortest route automatically, so only pushes you can actually make are offered. A box moves exactly one " +
    "cell per push and can never be pulled, so a box pushed into a corner, or against a wall with no target along that wall, can never " +
    "be brought back. A push that makes the level unsolvable, or running out of pushes, costs one of your 3 lives and deals a new " +
    "puzzle at the same level; losing all lives ends the game. Fewer pushes score higher. " +
    "Each option states exactly where that box ends up, whether it lands on a target or moves closer to or farther from one, and is " +
    "marked FATAL if it makes the level unsolvable or REPEAT if it recreates a position you have already been in. Never choose FATAL; " +
    "avoid REPEAT; prefer pushes that bring a box closer to a free target, unless that would block another box's only route.",
  estTokens: 40 * 500,
  create: (seed) => new CrateRunnerSession(seed),
};

export function createCrateRunner(seed: number) {
  return new CrateRunnerSession(seed);
}
