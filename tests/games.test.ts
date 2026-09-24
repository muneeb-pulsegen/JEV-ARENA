import { describe, expect, it } from "vitest";
import { GAMES, gameSeed } from "@/lib/games";
import {
  applyMove, applyPush, CRATE_LADDER, createCrateRunner, generateLevel, isSolved, labelBoxes, legalPushes, pushId, render, solve,
  solvePushes, type Dir, type State,
} from "@/lib/games/crateRunner";
import { GATES, gateFor, rulesFor, SORTER_MAX_ROUNDS, createRelaySorter, tierOf } from "@/lib/games/relaySorter";
import {
  SIGNAL_LADDER, createSignalRun, generateLevel as generateSignalLevel,
  shortestPath, describeMove as describeSignalMove, applyMove as applySignalMove, type Dir as SignalDir,
} from "@/lib/games/signalRun";
import { VAULT_LADDER, createTumblerVault, levelCredit as vaultCredit, solve as solveVault } from "@/lib/games/tumblerVault";
import { createRng } from "@/lib/games/rng";

function pushOf(state: State, box: number, dir: Dir) {
  return pushId(labelBoxes(state.boxes).find((b) => b.cell === box)!.label, dir);
}

function bestPush(s: ReturnType<typeof createCrateRunner>) {
  const { level, state } = s.current;
  const p = solvePushes(level, state)![0];
  return pushOf(state, p.box, p.dir);
}

describe("rng", () => {
  it("is deterministic per seed", () => {
    const a = createRng(42), b = createRng(42), c = createRng(43);
    const sa = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(sa);
    expect([c.next(), c.next(), c.next()]).not.toEqual(sa);
  });

  it("derives distinct per-game seeds", () => {
    expect(new Set(GAMES.map((g) => gameSeed(7, g.id))).size).toBe(GAMES.length);
  });
});

describe("Crate Runner", () => {
  it("generates solvable levels that get bigger and harder up the ladder", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const pars = CRATE_LADDER.map((cfg, i) => {
        const { level, par } = generateLevel(createRng(seed * 31 + i), cfg);
        expect(level.size).toBe(cfg.size);
        expect(level.boxes).toHaveLength(cfg.boxes);
        expect(level.boxes.some((b) => level.targets.includes(b))).toBe(false);
        const sol = solve(level, { boxes: level.boxes, player: level.player })!;
        expect(sol.length).toBe(par);
        let st = { boxes: level.boxes, player: level.player };
        for (const d of sol) st = applyMove(level, st, d as Dir)!;
        expect(isSolved(level, st)).toBe(true);
        expect(par).toBeGreaterThanOrEqual(Math.floor(cfg.minPar * 0.8));
        return par;
      });
      expect(pars[4]).toBeGreaterThan(pars[0]);
    }
  }, 60_000);

  it("renders every level size with the documented legend", () => {
    const { level } = generateLevel(createRng(3), CRATE_LADDER[4]);
    const map = render(level, { boxes: level.boxes, player: level.player });
    expect(map.split("\n")).toHaveLength(9);
    expect((map.match(/\$/g) ?? []).length).toBe(3);
    expect((map.match(/\./g) ?? []).length).toBe(3);
  });

  it("offers exactly the legal pushes, keyed by box letter and direction", () => {
    for (const seed of [1, 2, 3]) {
      const s = createCrateRunner(seed);
      const { level, state } = s.current;
      const keys = Object.keys(s.options()).sort();
      expect(keys.length).toBeGreaterThan(0);
      expect(keys).toEqual(legalPushes(level, state).map((p) => pushOf(state, p.box, p.dir)).sort());
      for (const k of keys) expect(k).toMatch(/^[A-C][UDLR]$/);
    }
  });

  it("finds push-optimal solutions that really solve the level", () => {
    for (let seed = 1; seed <= 6; seed++) {
      CRATE_LADDER.forEach((cfg, i) => {
        const { level } = generateLevel(createRng(seed * 31 + i), cfg);
        let st: State = { boxes: level.boxes, player: level.player };
        const plan = solvePushes(level, st)!;
        expect(plan.length).toBeGreaterThan(0);
        for (const p of plan) {
          expect(legalPushes(level, st).some((q) => q.box === p.box && q.dir === p.dir)).toBe(true);
          st = applyPush(level, st, p.box, p.dir);
        }
        expect(isSolved(level, st)).toBe(true);
      });
    }
  }, 60_000);

  it("scores 100 when every level is played push-optimally", () => {
    const s = createCrateRunner(21);
    while (!s.done()) s.step(bestPush(s));
    expect(s.score()).toBe(100);
    expect(s.view().ladder).toEqual(Array(5).fill("passed"));
    expect(s.view().note).toMatch(/Level 5 solved/);
  }, 30_000);

  it("advances to the next level immediately after solving", () => {
    const s = createCrateRunner(21);
    while (s.progress().startsWith("level 1/")) s.step(bestPush(s));
    expect(s.view().level).toBe(2);
    expect(s.view().ladder.slice(0, 2)).toEqual(["passed", "active"]);
  });

  it("losing a life deals a new puzzle at the same level; losing all lives ends the game", () => {
    const s = createCrateRunner(21);
    const first = s.current;
    for (let i = 0; i < first.budget; i++) s.step(null);
    expect(s.done()).toBe(false);
    expect(s.view().note).toMatch(/Out of pushes.*You lost a life \(2 left\)/);
    expect(s.view().lives).toEqual({ left: 2, max: 3 });
    expect(s.state()).toContain("new puzzle at the same level");
    const second = s.current;
    expect(second.level).not.toEqual(first.level);
    for (let i = 0; i < second.budget; i++) s.step(null);
    const third = s.current;
    expect(third.level).not.toEqual(second.level);
    for (let i = 0; i < third.budget; i++) s.step(null);
    expect(s.done()).toBe(true);
    expect(s.view().ladder[0]).toBe("failed");
    expect(s.score()).toBe(0);
  });

  it("each push option states its real outcome: on a target, SOLVES, or FATAL", () => {
    let fatal = 0, landed = 0, solves = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = createCrateRunner(seed);
      const rng = createRng(seed);
      for (let turn = 0; turn < 12 && !s.done(); turn++) {
        const { level, state } = s.current;
        const opts = s.options();
        const safe: string[] = [];
        for (const p of legalPushes(level, state)) {
          const text = opts[pushOf(state, p.box, p.dir)];
          const next = applyPush(level, state, p.box, p.dir);
          const to = next.boxes.find((b) => !state.boxes.includes(b))!;
          expect(text.includes("lands ON a target")).toBe(level.targets.includes(to));
          if (level.targets.includes(to)) landed++;
          if (isSolved(level, next)) {
            expect(text).toMatch(/SOLVES the level/);
            solves++;
          } else if (solvePushes(level, next) === null) {
            expect(text).toMatch(/FATAL/);
            fatal++;
          } else {
            expect(text).not.toMatch(/FATAL/);
            safe.push(pushOf(state, p.box, p.dir));
          }
        }
        if (!safe.length) break;
        s.step(rng.pick(safe));
      }
    }
    expect(fatal).toBeGreaterThan(0);
    expect(landed).toBeGreaterThan(0);
    expect(solves).toBeGreaterThan(0);
  }, 60_000);

  it("marks a push that recreates an earlier position as REPEAT", () => {
    const back: Record<Dir, Dir> = { U: "D", D: "U", L: "R", R: "L" };
    let checked = false;
    for (let seed = 1; seed < 40 && !checked; seed++) {
      const s = createCrateRunner(seed);
      const { level, state } = s.current;
      for (const p of legalPushes(level, state)) {
        const next = applyPush(level, state, p.box, p.dir);
        const moved = next.boxes.find((b) => !state.boxes.includes(b))!;
        const undo = legalPushes(level, next).find((q) => q.box === moved && q.dir === back[p.dir]);
        if (!undo || isSolved(level, next) || solvePushes(level, next) === null) continue;
        expect(s.options()[pushOf(state, p.box, p.dir)]).not.toMatch(/REPEAT/);
        s.step(pushOf(state, p.box, p.dir));
        expect(s.options()[pushOf(next, undo.box, undo.dir)]).toMatch(/REPEAT: .* 1 time on this puzzle/);
        checked = true;
        break;
      }
    }
    expect(checked).toBe(true);
  });

  it("an unknown push id wastes the turn without moving anything", () => {
    const s = createCrateRunner(21);
    const before = s.current.state;
    s.step("ZZ");
    expect(s.current.state).toEqual(before);
    expect(s.state()).toContain("No valid push chosen, turn wasted.");
    expect(s.state()).toContain("Your pushes so far on this puzzle: -.");
    expect(s.state()).toMatch(/Walls: the whole outer border/);
  });

  it("spells out the player, box and target coordinates in the state", () => {
    const s = createCrateRunner(21);
    const { level, state } = s.current;
    const at = (i: number) => `row ${Math.floor(i / level.size) + 1} col ${(i % level.size) + 1}`;
    const p = s.state();
    expect(p).toContain(`you at ${at(state.player)}`);
    for (const b of state.boxes) expect(p).toContain(at(b));
    for (const t of level.targets) expect(p).toContain(at(t));
  });
});

describe("Signal Run", () => {
  it("generates mazes with a guaranteed hole-free shortest path that gets longer up the ladder", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const pars = SIGNAL_LADDER.map((cfg, i) => {
        const { level, par } = generateSignalLevel(createRng(seed * 31 + i), cfg);
        expect(level.size).toBe(cfg.size);
        expect(shortestPath(level, level.start, level.goal)).toBe(par);
        expect(level.holes[level.start]).toBe(false);
        expect(level.holes[level.goal]).toBe(false);
        return par;
      });
      expect(pars[4]).toBeGreaterThan(pars[0]);
    }
  }, 60_000);

  it("places hazards on every level, including ones that fall back to a shorter route", () => {
    for (let seed = 1; seed <= 40; seed++) {
      SIGNAL_LADDER.forEach((cfg, i) => {
        const { level } = generateSignalLevel(createRng(seed * 131 + i), cfg);
        expect(level.holes.filter(Boolean).length).toBeGreaterThan(0);
        expect(level.holes[level.start] || level.holes[level.goal]).toBe(false);
      });
    }
  }, 60_000);

  it("offers exactly the four directions as choices", () => {
    const s = createSignalRun(1);
    expect(Object.keys(s.options()).sort()).toEqual(["D", "L", "R", "U"]);
  });

  it("scores 100 when every level is played optimally, one move per turn", () => {
    const s = createSignalRun(21);
    while (!s.done()) {
      const { level, player } = s.current;
      const DIRS: SignalDir[] = ["U", "D", "L", "R"];
      const delta = (d: SignalDir) => (d === "U" ? -level.size : d === "D" ? level.size : d === "L" ? -1 : 1);
      const prev = new Map<number, SignalDir>();
      const seen = new Set([player]);
      let frontier = [player];
      while (frontier.length && !frontier.includes(level.goal)) {
        const next: number[] = [];
        for (const p of frontier) {
          for (const d of DIRS) {
            const n = p + delta(d);
            if (level.walls[n] || level.holes[n] || seen.has(n)) continue;
            seen.add(n);
            prev.set(n, d);
            next.push(n);
          }
        }
        frontier = next;
      }
      const path: SignalDir[] = [];
      let node = level.goal;
      while (node !== player) {
        const d = prev.get(node)!;
        path.push(d);
        node -= delta(d);
      }
      s.step(path.reverse()[0]);
    }
    expect(s.score()).toBe(100);
    expect(s.view().ladder).toEqual(Array(5).fill("passed"));
  }, 30_000);

  it("each option states that move's real outcome: walk, BLOCKED, FATAL hazard, or goal", () => {
    const DIRS: SignalDir[] = ["U", "D", "L", "R"];
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const { level } = generateSignalLevel(createRng(seed), SIGNAL_LADDER[seed % 5]);
      for (let cell = 0; cell < level.walls.length; cell++) {
        if (level.walls[cell] || level.holes[cell]) continue;
        for (const d of DIRS) {
          const text = describeSignalMove(level, cell, d);
          const n = applySignalMove(level, cell, d);
          if (n === null) { expect(text).toMatch(/BLOCKED/); seen.add("blocked"); }
          else if (level.holes[n]) { expect(text).toMatch(/FATAL/); seen.add("fatal"); }
          else if (n === level.goal) { expect(text).toMatch(/completes the level/); seen.add("goal"); }
          else { expect(text).toMatch(/open floor/); seen.add("walk"); }
        }
      }
    }
    expect([...seen].sort()).toEqual(["blocked", "fatal", "goal", "walk"]);
  });

  it("reports walking into a wall honestly instead of saying it moved", () => {
    let checked = false;
    for (let seed = 1; seed < 30 && !checked; seed++) {
      const s = createSignalRun(seed);
      const dir = (["U", "D", "L", "R"] as SignalDir[]).find((d) => /BLOCKED/.test(s.options()[d]));
      if (!dir) continue;
      const before = s.current.player;
      s.step(dir);
      expect(s.current.player).toBe(before);
      expect(s.state()).toContain("a wall blocked it; you did not move");
      expect(s.state()).toContain(`Your moves so far on this maze: ${dir}(blocked).`);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it("marks a step back onto a visited cell as REPEAT", () => {
    const back: Record<SignalDir, SignalDir> = { U: "D", D: "U", L: "R", R: "L" };
    const s = createSignalRun(21);
    const dir = (["U", "D", "L", "R"] as SignalDir[]).find((d) => /walk from/.test(s.options()[d]))!;
    s.step(dir);
    expect(s.options()[back[dir]]).toMatch(/REPEAT: you have already stood on .* 1 time in this maze/);
  });

  it("losing a life deals a new maze at the same level; losing all lives ends the game", () => {
    const s = createSignalRun(21);
    const first = s.current;
    for (let i = 0; i < first.budget; i++) s.step(null);
    expect(s.done()).toBe(false);
    expect(s.view().note).toMatch(/Out of moves.*You lost a life \(2 left\)/);
    expect(s.view().lives).toEqual({ left: 2, max: 3 });
    expect(s.state()).toContain("new puzzle at the same level");
    const second = s.current;
    expect(second.level).not.toEqual(first.level);
    for (let i = 0; i < second.budget; i++) s.step(null);
    const third = s.current;
    expect(third.level).not.toEqual(second.level);
    for (let i = 0; i < third.budget; i++) s.step(null);
    expect(s.done()).toBe(true);
    expect(s.view().ladder[0]).toBe("failed");
    expect(s.score()).toBe(0);
  });
});

function solveVaultBoard(s: ReturnType<typeof createTumblerVault>) {
  while (!s.done()) {
    const v = s.view();
    if (v.kind !== "mechanism") throw new Error("wrong view");
    const plan = solveVault(v.dials, v.levers, v.modulus)!;
    s.step(plan[0]);
  }
}

describe("Tumbler Vault", () => {
  it("gives full credit at or under par and slides to 40% at the budget limit", () => {
    expect(vaultCredit(3, 5, 10)).toBe(1);
    expect(vaultCredit(5, 5, 10)).toBe(1);
    expect(vaultCredit(10, 5, 10)).toBeCloseTo(0.4);
    expect(vaultCredit(null, 5, 10)).toBe(0);
  });

  it("offers one choice per lever, describing its exact effect", () => {
    const s = createTumblerVault(1);
    const cfg = VAULT_LADDER[0];
    const opts = s.options();
    expect(Object.keys(opts)).toHaveLength(cfg.levers);
    for (const desc of Object.values(opts)) expect(desc).toMatch(/^Press lever \w: /);
  });

  it("climbs the whole ladder solving optimally", () => {
    const s = createTumblerVault(99);
    solveVaultBoard(s);
    const v = s.view();
    expect(v.ladder).toEqual(Array(5).fill("passed"));
    expect(s.score()).toBe(100);
  }, 30_000);

  it("a failed vault costs a life and deals a fresh puzzle at the same level; three failures end the game", () => {
    const s = createTumblerVault(5);
    const failVault = () => {
      const budget = s.view().budget;
      for (let i = 0; i < budget; i++) s.step(null);
    };
    failVault();
    let v = s.view();
    expect(s.done()).toBe(false);
    expect(v.lives).toEqual({ left: 2, max: 3 });
    expect(v.failedAttempts).toBe(1);
    expect(s.state()).toContain("Attempt 2");
    failVault();
    failVault();
    v = s.view();
    expect(s.done()).toBe(true);
    expect(s.score()).toBe(0);
    expect(v.lives.left).toBe(0);
    expect(v.ladder).toEqual(["failed", "locked", "locked", "locked", "locked"]);
  });
});

describe("Relay Sorter", () => {
  it("raises the tier every 12 rounds", () => {
    expect([1, 12, 13, 24, 25, 48, 49, 60].map(tierOf)).toEqual([1, 1, 2, 2, 3, 4, 5, 5]);
  });

  it("every rule table covers every item with no ambiguity", () => {
    for (let tier = 1; tier <= 5; tier++) {
      const rules = rulesFor(tier);
      for (const r of rules) expect(GATES).toContain(r.gate);
      const keys = rules.map((r) => `${r.color}|${r.size}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("offers exactly the three gates as choices", () => {
    const s = createRelaySorter(1);
    expect(Object.keys(s.options()).sort()).toEqual(["X", "Y", "Z"]);
  });

  it("a perfect, fast run climbs every tier and scores 100", () => {
    const s = createRelaySorter(3, 60_000);
    while (!s.done()) {
      const v = s.view();
      if (v.kind !== "dispatch" || !v.item) break;
      s.step(gateFor(v.item, v.tier, v.rotation), 10);
    }
    expect(s.view().correct).toBe(SORTER_MAX_ROUNDS);
    expect(s.view().ladder).toEqual(Array(5).fill("passed"));
    expect(s.score()).toBe(100);
  });

  it("scores by tier, subtracts half a tier for wrong answers, and ends when the clock runs out", () => {
    const s = createRelaySorter(1, 10_000);
    const answer = () => {
      const v = s.view();
      if (v.kind !== "dispatch" || !v.item) throw new Error("no item");
      return gateFor(v.item, v.tier, v.rotation);
    };
    s.step(answer(), 1000);
    s.step(answer(), 1000);
    s.step(answer() === "X" ? "Y" : "X", 1000);
    expect(s.view().points).toBe(1.5);
    s.step(answer(), 20_000);
    expect(s.done()).toBe(true);
    expect(s.view().points).toBe(1.5);
    expect(s.view().ladder).toEqual(["failed", "locked", "locked", "locked", "locked"]);
  });
});
