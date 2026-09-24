import { createRng, deriveSeed, type Rng } from "./rng";
import type { GameDef, GameSession } from "./types";
import { LIFE_PENALTY, type LadderStep, type Lever, type TumblerView } from "./views";
import type { Choices } from "../agents/types";

export type LevelConfig = { dials: number; modulus: number; levers: number };

export const VAULT_LADDER: LevelConfig[] = [
  { dials: 3, modulus: 4, levers: 3 },
  { dials: 3, modulus: 5, levers: 3 },
  { dials: 4, modulus: 5, levers: 4 },
  { dials: 4, modulus: 6, levers: 4 },
  { dials: 5, modulus: 6, levers: 5 },
];
const TOTAL_WEIGHT = VAULT_LADDER.reduce((a, _, i) => a + i + 1, 0);
const LEVER_NAMES = "ABCDEFGH";
export const LIVES = 3;
const SOLVE_CAP = 200_000;

function buildLevers(rng: Rng, cfg: LevelConfig): Lever[] {
  return Array.from({ length: cfg.levers }, (_, k) => {
    const deltas = Array(cfg.dials).fill(0);
    const touch = Math.min(cfg.dials, rng.int(1, 2));
    for (const i of rng.shuffle(Array.from({ length: cfg.dials }, (_, i) => i)).slice(0, touch)) {
      deltas[i] = rng.int(1, cfg.modulus - 1);
    }
    return { id: LEVER_NAMES[k], deltas };
  });
}

const apply = (dials: number[], lever: Lever, modulus: number) => dials.map((d, i) => (d + lever.deltas[i]) % modulus);
const key = (dials: number[]) => dials.join(",");
const isZero = (dials: number[]) => dials.every((d) => d === 0);

/** Shortest press sequence from `dials` back to all-zero, or null if the cap is hit (should not happen at these sizes). */
export function solve(dials: number[], levers: Lever[], modulus: number, cap = SOLVE_CAP): string | null {
  if (isZero(dials)) return "";
  const seen = new Map<string, { prev: string; id: string }>();
  seen.set(key(dials), { prev: "", id: "" });
  let frontier = [dials];
  while (frontier.length) {
    const next: number[][] = [];
    for (const s of frontier) {
      for (const lever of levers) {
        const n = apply(s, lever, modulus);
        const k = key(n);
        if (seen.has(k)) continue;
        seen.set(k, { prev: key(s), id: lever.id });
        if (isZero(n)) {
          const path: string[] = [];
          let cur = k;
          while (cur) {
            const e = seen.get(cur)!;
            if (e.id) path.push(e.id);
            cur = e.prev;
          }
          return path.reverse().join("");
        }
        if (seen.size > cap) return null;
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

function generateStart(rng: Rng, levers: Lever[], cfg: LevelConfig): { dials: number[]; par: number } {
  for (let attempt = 0; attempt < 20; attempt++) {
    let dials = Array(cfg.dials).fill(0);
    const presses = rng.int(cfg.dials + 1, cfg.dials * 2 + 2);
    for (let i = 0; i < presses; i++) dials = apply(dials, rng.pick(levers), cfg.modulus);
    if (isZero(dials)) continue;
    const sol = solve(dials, levers, cfg.modulus);
    if (sol !== null) return { dials, par: sol.length };
  }
  throw new Error("Could not generate a Tumbler Vault puzzle");
}

/** Fraction of a level's points: full credit at or under par, sliding to 40% at the press budget. */
export const levelCredit = (pressesUsed: number | null, par: number, budget: number) =>
  pressesUsed === null ? 0 : pressesUsed <= par ? 1 : 1 - (0.6 * (pressesUsed - par)) / Math.max(1, budget - par);

type Board = {
  level: number; levers: Lever[]; dials: number[]; par: number; budget: number;
  presses: number; status: "playing" | "solved" | "failed";
};

class TumblerVaultSession implements GameSession<string> {
  private boards: Board[] = [];
  private lives = LIVES;
  private notice = "";

  constructor(private seed: number) {
    this.deal(0);
  }

  private deal(level: number) {
    const attempt = this.boards.filter((b) => b.level === level).length;
    const rng = createRng(deriveSeed(this.seed, level * 16 + attempt));
    const cfg = VAULT_LADDER[level];
    const levers = buildLevers(rng, cfg);
    const { dials, par } = generateStart(rng, levers, cfg);
    const budget = Math.max(par + 4, Math.ceil(par * 1.8));
    this.boards.push({ level, levers, dials, par, budget, presses: 0, status: "playing" });
  }

  private get board() {
    return this.boards[this.boards.length - 1];
  }

  private failsAt(level: number) {
    return this.boards.filter((b) => b.level === level && b.status === "failed").length;
  }

  state() {
    const b = this.board;
    const cfg = VAULT_LADDER[b.level];
    const retry = this.failsAt(b.level);
    const table = b.levers.map((l) => `${l.id}: ${l.deltas.map((d, i) => (d ? `dial ${i + 1} +${d}` : null)).filter(Boolean).join(", ")}`);
    return [
      this.notice,
      `Vault ${b.level + 1} of ${VAULT_LADDER.length}: ${cfg.dials} dials mod ${cfg.modulus}, ${cfg.levers} levers, ${b.budget} presses (par ${b.par}).` +
        `${retry ? ` Attempt ${retry + 1}: this is a new puzzle.` : ""} Lives: ${this.lives}/${LIVES}.`,
      `Presses used: ${b.presses}/${b.budget}.`,
      `Current dials (each wraps mod ${cfg.modulus}): ${b.dials.join(" ")}`,
      `Lever effects (each press adds these amounts, wrapping mod ${cfg.modulus}):`,
      table.join("\n"),
    ].filter(Boolean).join("\n");
  }

  options(): Choices {
    return Object.fromEntries(
      this.board.levers.map((l) => [
        l.id,
        `Press lever ${l.id}: ${l.deltas.map((d, i) => (d ? `dial ${i + 1} +${d}` : null)).filter(Boolean).join(", ")}.`,
      ]),
    );
  }

  step(choice: string | null, elapsedMs?: number) {
    void elapsedMs;
    const b = this.board;
    const level = b.level;
    this.notice = "";
    const lever = choice === null ? null : b.levers.find((l) => l.id === choice) ?? null;
    if (lever) {
      b.dials = apply(b.dials, lever, VAULT_LADDER[level].modulus);
    }
    b.presses++;

    if (isZero(b.dials)) {
      b.status = "solved";
      if (level < VAULT_LADDER.length - 1) this.deal(level + 1);
    } else if (b.presses >= b.budget) {
      b.status = "failed";
      this.lives--;
      if (this.lives > 0) {
        this.notice = `You did not solve vault ${level + 1} within budget and lost a life. Here is a new puzzle at the same level.`;
        this.deal(level);
      }
    }
  }

  done() {
    return this.lives === 0 || (this.board.status === "solved" && this.board.level === VAULT_LADDER.length - 1);
  }

  score() {
    let earned = 0;
    VAULT_LADDER.forEach((_, i) => {
      const solved = this.boards.find((b) => b.level === i && b.status === "solved");
      if (solved) earned += (i + 1) * levelCredit(solved.presses, solved.par, solved.budget) * LIFE_PENALTY ** this.failsAt(i);
    });
    return Math.round((earned / TOTAL_WEIGHT) * 100);
  }

  view(): TumblerView {
    const b = this.board;
    const over = this.done();
    const ladder: LadderStep[] = VAULT_LADDER.map((_, i) => {
      if (this.boards.some((x) => x.level === i && x.status === "solved")) return "passed";
      if (i === b.level) return over ? "failed" : "active";
      return "locked";
    });
    return {
      kind: "mechanism",
      ladder,
      lives: { left: this.lives, max: LIVES },
      level: b.level + 1,
      levels: VAULT_LADDER.length,
      modulus: VAULT_LADDER[b.level].modulus,
      levers: b.levers,
      dials: b.dials,
      presses: b.presses,
      budget: b.budget,
      par: b.par,
      failedAttempts: this.failsAt(b.level),
      note: this.notice,
    };
  }

  progress() {
    const solved = this.boards.filter((b) => b.status === "solved").length;
    if (this.done()) return `finished · ${solved}/${VAULT_LADDER.length} vaults solved · ${this.lives}/${LIVES} lives left`;
    const b = this.board;
    return `vault ${b.level + 1}/${VAULT_LADDER.length} (${VAULT_LADDER[b.level].dials} dials), press ${b.presses}/${b.budget} · lives ${this.lives}/${LIVES}`;
  }
}

export const tumblerVault: GameDef<string> = {
  id: "mechanism",
  name: "Tumbler Vault",
  axis: "Mechanism",
  blurb: `Combination-lock ladder: ${VAULT_LADDER.length} vaults, from 3 dials mod 4 up to 5 dials mod 6. One lever press per turn; every lever's effect is shown up front. 3 lives; failing a vault costs one.`,
  instructions:
    "You are playing Tumbler Vault, a ladder of increasingly hard combination locks. Every dial holds a number that wraps around modulo " +
    "the vault's modulus (so at the top value it rolls back to 0). Each lever's exact effect on every dial is given to you up front, " +
    "and pressing it always does exactly that, deterministically. There is no hidden secret: work out, from the shown lever effects, " +
    "which lever to press next in a sequence that returns every dial to 0 within the press budget. Failing a vault costs one of your " +
    "3 lives and deals a new puzzle at the same level; losing all lives ends the game. Fewer presses score higher. " +
    "Choose exactly one lever to press for this turn.",
  estTokens: 40 * 500,
  create: (seed) => new TumblerVaultSession(seed),
};

export function createTumblerVault(seed: number) {
  return new TumblerVaultSession(seed);
}
