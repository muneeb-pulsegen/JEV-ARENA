import { createRng, deriveSeed, type Rng } from "./rng";
import type { GameDef, GameSession } from "./types";
import { LIFE_PENALTY, type LadderStep, type SignalView } from "./views";
import type { Choices } from "../agents/types";

export type LevelConfig = { size: number; walls: [number, number]; holes: [number, number]; minPar: number };

export const SIGNAL_LADDER: LevelConfig[] = [
  { size: 6, walls: [2, 4], holes: [2, 3], minPar: 7 },
  { size: 7, walls: [4, 7], holes: [4, 6], minPar: 9 },
  { size: 8, walls: [6, 10], holes: [6, 9], minPar: 12 },
  { size: 9, walls: [8, 13], holes: [9, 13], minPar: 15 },
  { size: 10, walls: [10, 16], holes: [12, 18], minPar: 18 },
];
const TOTAL_WEIGHT = SIGNAL_LADDER.reduce((a, _, i) => a + i + 1, 0);
export const LIVES = 3;

export type Dir = "U" | "D" | "L" | "R";
const DIRS: Dir[] = ["U", "D", "L", "R"];
const delta = (size: number, d: Dir) => (d === "U" ? -size : d === "D" ? size : d === "L" ? -1 : 1);

const DIR_WORD: Record<Dir, string> = { U: "up (toward row 1)", D: "down (toward the bottom row)", L: "left", R: "right" };
const where = (size: number, i: number) => `row ${Math.floor(i / size) + 1} col ${(i % size) + 1}`;
const onBorder = (size: number, i: number) => {
  const x = i % size, y = Math.floor(i / size);
  return x === 0 || y === 0 || x === size - 1 || y === size - 1;
};

export type Level = { size: number; walls: boolean[]; holes: boolean[]; start: number; goal: number };

export function applyMove(level: Level, player: number, d: Dir): number | null {
  const np = player + delta(level.size, d);
  if (level.walls[np]) return null;
  return np;
}

/** Shortest hop count between two cells over floor (non-wall) cells only, or null if unreachable. */
export function shortestPath(level: Level, from: number, to: number): number | null {
  const seen = new Set([from]);
  let frontier = [from];
  let dist = 0;
  while (frontier.length) {
    if (frontier.includes(to)) return dist;
    const next: number[] = [];
    for (const p of frontier) {
      for (const d of DIRS) {
        const n = p + delta(level.size, d);
        if (level.walls[n] || seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
    dist++;
  }
  return null;
}

function pathCells(level: Level, from: number, to: number): Set<number> {
  const prev = new Map<number, number>();
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length && !frontier.includes(to)) {
    const next: number[] = [];
    for (const p of frontier) {
      for (const d of DIRS) {
        const n = p + delta(level.size, d);
        if (level.walls[n] || seen.has(n)) continue;
        seen.add(n);
        prev.set(n, p);
        next.push(n);
      }
    }
    frontier = next;
  }
  const path = new Set<number>([to]);
  let cur = to;
  while (cur !== from) {
    cur = prev.get(cur)!;
    path.add(cur);
  }
  return path;
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

/** Builds a maze with a guaranteed hole-free shortest path, and scatters hazards off it. */
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
    if (fillPockets(size, walls) < 12) continue;

    const floor = walls.map((w, i) => (w ? -1 : i)).filter((i) => i >= 0);
    for (let pick = 0; pick < 10; pick++) {
      const [start, goal] = rng.shuffle(floor);
      const level: Level = { size, walls: [...walls], holes: walls.map(() => false), start, goal };
      const par = shortestPath(level, start, goal);
      if (par === null) continue;
      if (par < cfg.minPar) {
        if (!best || par > best.par) best = { level, par };
        continue;
      }
      placeHazards(rng, level, cfg);
      return { level, par };
    }
  }
  if (!best) throw new Error("Could not generate a Signal Run level");
  placeHazards(rng, best.level, cfg);
  return best;
}

/** Scatters hazards on floor cells off one shortest path, so a hazard-free route always exists. */
function placeHazards(rng: Rng, level: Level, cfg: LevelConfig) {
  const safe = pathCells(level, level.start, level.goal);
  const candidates = level.walls.flatMap((w, i) => (w || safe.has(i) ? [] : [i]));
  const count = Math.min(candidates.length, rng.int(cfg.holes[0], cfg.holes[1]));
  for (const h of rng.shuffle(candidates).slice(0, count)) level.holes[h] = true;
}

export function render(level: Level, player: number): string {
  const rows: string[] = [];
  for (let y = 0; y < level.size; y++) {
    let row = "";
    for (let x = 0; x < level.size; x++) {
      const i = y * level.size + x;
      if (level.walls[i]) row += "#";
      else if (player === i) row += "@";
      else if (level.goal === i) row += "G";
      else if (level.holes[i]) row += "X";
      else row += "-";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

export function describePositions(level: Level, player: number): string {
  const at = (i: number) => where(level.size, i);
  const holes = level.holes.flatMap((h, i) => (h ? [at(i)] : []));
  const inner = level.walls.flatMap((w, i) => (w && !onBorder(level.size, i) ? [at(i)] : []));
  return (
    `Positions (row 1 is the top row, col 1 the left column): you at ${at(player)}. Goal at ${at(level.goal)}. ` +
    `Hazard tiles: ${holes.join("; ") || "none"}. Walls: the whole outer border${inner.length ? `, plus ${inner.join("; ")}` : ""}.`
  );
}

/** What choosing `d` does right now, so each option is distinguishable on this exact board. */
export function describeMove(level: Level, player: number, d: Dir, visits?: Map<number, number>): string {
  const at = (i: number) => where(level.size, i);
  const head = `Move ${DIR_WORD[d]}`;
  const np = player + delta(level.size, d);
  if (level.walls[np]) return `${head}: BLOCKED, ${at(np)} is a wall. You stay at ${at(player)} and waste a move.`;
  if (level.holes[np]) return `${head}: FATAL, ${at(np)} is a hazard; stepping on it loses a life.`;
  if (np === level.goal) return `${head}: step onto the goal at ${at(np)}. This completes the level.`;
  const v = visits?.get(np) ?? 0;
  const repeat = v ? ` REPEAT: you have already stood on ${at(np)} ${v} time${v > 1 ? "s" : ""} in this maze.` : "";
  return `${head}: walk from ${at(player)} to ${at(np)} (open floor).${repeat}`;
}

/** Fraction of a level's points: 0.5 for reaching the goal, up to 1 for matching the optimal move count. */
export const levelCredit = (movesUsed: number | null, par: number) =>
  movesUsed === null ? 0 : 0.5 + 0.5 * Math.min(1, par / movesUsed);

/** Moves allowed to reach the goal of this par: generous enough to recover from a few wrong turns. */
const moveBudget = (par: number) => Math.max(par + 8, Math.ceil(par * 1.6));

type Board = { level: number; puzzle: Level; par: number; budget: number; player: number; moves: number; trail: string[]; visits: Map<number, number>; status: "playing" | "solved" | "failed" };

class SignalRunSession implements GameSession<Dir> {
  private boards: Board[] = [];
  private lives = LIVES;
  private last = "";

  constructor(private seed: number) {
    this.deal(0);
  }

  /** Generates a fresh maze for this level; a retry after losing a life gets a new layout, not the same one. */
  private deal(idx: number) {
    const attempt = this.boards.filter((b) => b.level === idx).length;
    const { level, par } = generateLevel(createRng(deriveSeed(this.seed, idx * 16 + attempt)), SIGNAL_LADDER[idx]);
    this.boards.push({ level: idx, puzzle: level, par, budget: moveBudget(par), player: level.start, moves: 0, trail: [], visits: new Map([[level.start, 1]]), status: "playing" });
  }

  private get board() {
    return this.boards[this.boards.length - 1];
  }

  private failsAt(idx: number) {
    return this.boards.filter((b) => b.level === idx && b.status === "failed").length;
  }

  get current() {
    const b = this.board;
    return { level: b.puzzle, par: b.par, budget: b.budget, player: b.player };
  }

  state() {
    const b = this.board;
    return [
      this.last,
      `Level ${b.level + 1} of ${SIGNAL_LADDER.length}: ${b.puzzle.size}×${b.puzzle.size} grid, optimal route ${b.par} moves. ` +
        `Move ${b.moves + 1}/${b.budget}. Lives: ${this.lives}/${LIVES}.`,
      render(b.puzzle, b.player),
      describePositions(b.puzzle, b.player),
      `Your moves so far on this maze: ${b.trail.length ? b.trail.slice(-30).join(" ") : "none yet"}.`,
    ].filter(Boolean).join("\n");
  }

  options(): Choices {
    const b = this.board;
    return Object.fromEntries(DIRS.map((d) => [d, describeMove(b.puzzle, b.player, d, b.visits)]));
  }

  step(choice: Dir | null, elapsedMs?: number) {
    void elapsedMs;
    const b = this.board;
    b.moves++;
    let applied: string;
    let hit: "goal" | "hole" | null = null;
    if (choice === null) {
      applied = "No valid move chosen, turn wasted.";
      b.trail.push("-");
    } else {
      const n = applyMove(b.puzzle, b.player, choice);
      if (n === null) {
        applied = `Tried ${choice} but a wall blocked it; you did not move.`;
        b.trail.push(`${choice}(blocked)`);
      } else {
        b.player = n;
        b.visits.set(n, (b.visits.get(n) ?? 0) + 1);
        applied = `Moved ${choice}.`;
        b.trail.push(choice);
        if (b.puzzle.holes[n]) hit = "hole";
        else if (n === b.puzzle.goal) hit = "goal";
      }
    }

    if (hit === "goal") {
      b.status = "solved";
      const note = `Level ${b.level + 1} reached the goal in ${b.moves} moves (optimal ${b.par}).`;
      if (b.level < SIGNAL_LADDER.length - 1) this.deal(b.level + 1);
      this.last = `${applied} ${note}`;
      return;
    }
    if (hit === "hole" || b.moves >= b.budget) {
      b.status = "failed";
      this.lives--;
      const why = hit === "hole" ? `You stepped on a hazard on level ${b.level + 1}.` : `Out of moves on level ${b.level + 1}.`;
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
    return this.lives === 0 || (this.board.status === "solved" && this.board.level === SIGNAL_LADDER.length - 1);
  }

  score() {
    let earned = 0;
    SIGNAL_LADDER.forEach((_, i) => {
      const solved = this.boards.find((b) => b.level === i && b.status === "solved");
      if (solved) earned += (i + 1) * levelCredit(solved.moves, solved.par) * LIFE_PENALTY ** this.failsAt(i);
    });
    return Math.round((earned / TOTAL_WEIGHT) * 100);
  }

  view(): SignalView {
    const b = this.board;
    const over = this.done();
    const ladder: LadderStep[] = SIGNAL_LADDER.map((_, i) => {
      if (this.boards.some((x) => x.level === i && x.status === "solved")) return "passed";
      if (i === b.level) return over ? "failed" : "active";
      return "locked";
    });
    return {
      kind: "routing",
      ladder,
      lives: { left: this.lives, max: LIVES },
      size: b.puzzle.size,
      level: b.level + 1,
      levels: SIGNAL_LADDER.length,
      walls: b.puzzle.walls,
      holes: b.puzzle.holes,
      goal: b.puzzle.goal,
      player: b.player,
      moves: b.moves,
      par: b.par,
      turn: b.moves,
      turns: b.budget,
      note: this.last,
    };
  }

  progress() {
    const solved = this.boards.filter((b) => b.status === "solved").length;
    if (this.done()) return `finished · ${solved}/${SIGNAL_LADDER.length} levels reached · ${this.lives}/${LIVES} lives left`;
    const b = this.board;
    return `level ${b.level + 1}/${SIGNAL_LADDER.length}, ${b.moves}/${b.budget} moves (optimal ${b.par}) · lives ${this.lives}/${LIVES}`;
  }
}

export const signalRun: GameDef<Dir> = {
  id: "routing",
  name: "Signal Run",
  axis: "Routing",
  blurb: `Grid ladder: ${SIGNAL_LADDER.length} mazes from 6×6 to 10×10. One move per turn. Reach the goal while avoiding hazard tiles. 3 lives; a hazard or running out of moves costs one and deals a new maze at the same level.`,
  instructions:
    "You are playing Signal Run, a ladder of increasingly hard grid mazes. Map legend: # wall, - floor, X hazard, G goal, @ you. " +
    "Row 1 is the top; moving up goes to the row above. Walking into a wall wastes that move and you stay where you are. " +
    "Stepping onto a hazard tile, or running out of moves, costs one of your 3 lives and deals a new maze at the same level; " +
    "losing all lives ends the game. Reach the goal; fewer moves score higher. " +
    "Each option states exactly what that move does on the current board (walk, BLOCKED by a wall, FATAL hazard, or goal). " +
    "Never pick a BLOCKED or FATAL option. The goal is often not reachable in a straight line: route around walls, even if that means " +
    "moving away from the goal first. Options marked REPEAT go back to a cell you have already stood on, which means you are going in " +
    "circles: prefer a new cell unless every other option is BLOCKED or FATAL.",
  estTokens: 90 * 500,
  create: (seed) => new SignalRunSession(seed),
};

export function createSignalRun(seed: number) {
  return new SignalRunSession(seed);
}
