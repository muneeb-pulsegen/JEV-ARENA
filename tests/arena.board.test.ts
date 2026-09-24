import { describe, expect, it } from "vitest";
import {
  applyMove,
  cloneBoard,
  contested,
  delta,
  describeOptions,
  describeState,
  DIRS,
  EMPTY,
  eliminate,
  generateArena,
  renderMap,
  room,
  standings,
  timeWinner,
  WALL,
  winnerOf,
  type Board,
  type Dir,
} from "@/lib/arena/board";
import { defaultSize, estimateMatch, SEATS, SIZE_IDS, SIZES } from "@/lib/arena/config";

/** Builds a board from a map: uppercase letters are living heads, lowercase letters their trails. */
export function boardFrom(rows: string[], dirs: Record<string, Dir> = {}): Board {
  const grid = rows.length;
  const occ = new Int16Array(grid * grid).fill(EMPTY);
  const present = SEATS.filter((s) => rows.some((r) => r.includes(s.id)));
  const seats = present.map((s) => ({ ...s, pos: 0, dir: dirs[s.id] ?? ("U" as Dir), alive: true, cells: 0, moves: 0, reachedAt: 0 }));
  rows.join("").split("").forEach((ch, i) => {
    if (ch === "#") occ[i] = WALL;
    const k = seats.findIndex((s) => s.id === ch.toUpperCase());
    if (k < 0) return;
    occ[i] = k;
    seats[k].cells++;
    if (ch === seats[k].id) seats[k].pos = i;
  });
  return { grid, occ, seats };
}

/** Straightforward room count: repeat relaxation until nothing changes. */
function bruteRoom(b: Board, seat: number, dir: Dir) {
  const dest = b.seats[seat].pos + delta(b.grid, dir);
  if (b.occ[dest] !== EMPTY) return 0;
  const reach = new Set<number>();
  for (const d of DIRS) if (b.occ[dest + delta(b.grid, d)] === EMPTY) reach.add(dest + delta(b.grid, d));
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of [...reach]) {
      for (const d of DIRS) {
        const n = c + delta(b.grid, d);
        if (n !== dest && b.occ[n] === EMPTY && !reach.has(n)) {
          reach.add(n);
          changed = true;
        }
      }
    }
  }
  return reach.size;
}

function openConnected(b: Board) {
  const open = [...b.occ.keys()].filter((i) => b.occ[i] !== WALL);
  const seen = new Set([open[0]]);
  const stack = [open[0]];
  while (stack.length) {
    const c = stack.pop()!;
    for (const d of DIRS) {
      const n = c + delta(b.grid, d);
      if (b.occ[n] !== WALL && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen.size === open.length;
}

describe("arena config", () => {
  it("defaults the map size by seat count", () => {
    expect([2, 3, 4, 5, 6].map(defaultSize)).toEqual(["small", "medium", "medium", "large", "large"]);
  });

  it("estimates more tokens for more seats and bigger maps", () => {
    expect(estimateMatch(4, "medium").tokens).toBeGreaterThanOrEqual(estimateMatch(2, "medium").tokens);
    expect(estimateMatch(6, "huge").tokens).toBeGreaterThan(estimateMatch(6, "large").tokens);
    expect(estimateMatch(6, "huge").minutes).toBe(12);
  });
});

describe("arena generation", () => {
  it("is deterministic per seed", () => {
    const a = generateArena(42, "medium", 4);
    const b = generateArena(42, "medium", 4);
    expect(renderMap(a)).toBe(renderMap(b));
    expect(renderMap(generateArena(43, "medium", 4))).not.toBe(renderMap(a));
  });

  it("keeps obstacles in the 3–5% band with every open cell connected, at every size and seat count", () => {
    for (const size of SIZE_IDS) {
      for (let seats = 2; seats <= 6; seats++) {
        for (let seed = 1; seed <= 6; seed++) {
          const b = generateArena(seed * 101 + seats, size, seats);
          const { grid } = SIZES[size];
          let blocked = 0;
          for (let y = 1; y < grid - 1; y++) for (let x = 1; x < grid - 1; x++) if (b.occ[y * grid + x] === WALL) blocked++;
          const share = blocked / (grid - 2) ** 2;
          expect(share, `${size} ${seats} ${seed}`).toBeGreaterThanOrEqual(0.03);
          expect(share, `${size} ${seats} ${seed}`).toBeLessThanOrEqual(0.05);
          expect(openConnected(b)).toBe(true);
        }
      }
    }
  });

  it("spaces the starts apart, each facing open cells with plenty of room", () => {
    for (const size of SIZE_IDS) {
      for (let seats = 2; seats <= 6; seats++) {
        const b = generateArena(7 + seats, size, seats);
        expect(b.seats).toHaveLength(seats);
        const g = b.grid;
        for (let i = 0; i < seats; i++) {
          const s = b.seats[i];
          for (let j = i + 1; j < seats; j++) {
            const o = b.seats[j];
            const dist = Math.abs((s.pos % g) - (o.pos % g)) + Math.abs(Math.floor(s.pos / g) - Math.floor(o.pos / g));
            expect(dist).toBeGreaterThanOrEqual(3);
          }
          let p = s.pos;
          for (let step = 0; step < 3; step++) {
            p += delta(g, s.dir);
            expect(b.occ[p]).toBe(EMPTY);
          }
          expect(room(b, i, s.dir).cells).toBeGreaterThan(((g - 2) ** 2) / 2);
        }
      }
    }
  });
});

describe("moves and crashes", () => {
  const map = [
    "#######",
    "#..b..#",
    "#.rRbB#",
    "#.....#",
    "#.....#",
    "#.....#",
    "#######",
  ];

  it("advances the head and leaves a permanent trail", () => {
    const b = boardFrom(map);
    const r = applyMove(b, 0, "D", 100);
    expect(r).toEqual({ moved: true, to: 3 * 7 + 3 });
    expect(b.occ[2 * 7 + 3]).toBe(0);
    expect(b.seats[0]).toMatchObject({ cells: 3, moves: 1, reachedAt: 100, dir: "D" });
    expect(renderMap(b).split("\n")[3]).toBe("#..R..#");
  });

  it("names what the mover crashed into, and only the mover goes out", () => {
    const cases: [number, Dir, string][] = [
      [0, "L", "crashed into its own trail"],
      [0, "R", "crashed into Blue's trail"],
      [0, "U", "crashed into Blue's trail"],
      [1, "R", "crashed into a wall"],
    ];
    for (const [seat, dir, reason] of cases) {
      const b = boardFrom(map);
      expect(applyMove(b, seat, dir, 5)).toEqual({ moved: false, reason });
      expect(b.seats[seat]).toMatchObject({ alive: false, out: reason, outAt: 5 });
      expect(b.seats[1 - seat].alive).toBe(true);
    }
    const heads = boardFrom(["#####", "#RB.#", "#...#", "#...#", "#####"]);
    expect(applyMove(heads, 0, "R", 1)).toEqual({ moved: false, reason: "crashed into Blue's head" });
  });

  it("keeps a crashed seat's trail and head as obstacles", () => {
    const b = boardFrom(map);
    applyMove(b, 1, "R", 1);
    const blueHead = b.seats[1].pos;
    expect(b.occ[blueHead]).toBe(1);
    expect(renderMap(b)).toContain("b");
    expect(renderMap(b)).not.toContain("B");
    // Red loops round below and steps up onto Blue's crashed head.
    for (const d of ["D", "R", "R"] as Dir[]) expect(applyMove(b, 0, d, 2).moved).toBe(true);
    expect(b.seats[0].pos + delta(7, "U")).toBe(blueHead);
    expect(applyMove(b, 0, "U", 3)).toEqual({ moved: false, reason: "crashed into Blue's head" });
  });

  it("finds the last seat standing, and breaks time-limit ties by cells then by who got there first", () => {
    const b = boardFrom(["#######", "#R....#", "#.....#", "#..B..#", "#.....#", "#....G#", "#######"]);
    expect(winnerOf(b)).toBeNull();
    eliminate(b, 2, "disconnected", 10);
    expect(winnerOf(b)).toBeNull();
    b.seats[0].cells = 5;
    b.seats[0].reachedAt = 900;
    b.seats[1].cells = 5;
    b.seats[1].reachedAt = 400;
    expect(timeWinner(b)).toBe(1);
    b.seats[0].cells = 6;
    expect(timeWinner(b)).toBe(0);
    eliminate(b, 1, "crashed into a wall", 20);
    expect(winnerOf(b)).toBe(0);
    expect(standings(b, 0).map((s) => [s.name, s.place])).toEqual([["Red", 1], ["Blue", 2], ["Green", 3]]);
  });
});

describe("what a seat sees", () => {
  it("counts room exactly like a brute-force fill and names the rivals sharing it", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const b = generateArena(seed, "small", 3);
      // Play a few random-ish safe moves so the board has trails.
      for (let t = 1; t < 40; t++) {
        const seat = t % 3;
        if (!b.seats[seat].alive) continue;
        const safe = DIRS.filter((d) => b.occ[b.seats[seat].pos + delta(b.grid, d)] === EMPTY);
        if (safe.length) applyMove(b, seat, safe[(seed + t) % safe.length], t);
      }
      for (let s = 0; s < 3; s++) {
        if (!b.seats[s].alive) continue;
        for (const d of DIRS) expect(room(b, s, d).cells).toBe(bruteRoom(b, s, d));
      }
    }
    const sealed = boardFrom(["#######", "#R#...#", "#.#.B.#", "###...#", "#.....#", "#.....#", "#######"]);
    expect(room(sealed, 0, "D")).toEqual({ cells: 0, rivals: [] });
    expect(describeOptions(sealed, 0).D).toBe("Move down to row 3 col 2. Open. Room after this move: 0 cells, sealed off, only you.");
    expect(room(sealed, 1, "D").rivals).toEqual([]);
  });

  it("marks CONTESTED exactly on cells next to a living rival's head", () => {
    const b = boardFrom(["#######", "#.....#", "#.R.B.#", "#.....#", "#.....#", "#.....#", "#######"]);
    expect(contested(b, 0, "R")).toEqual([1]);
    expect(contested(b, 0, "U")).toEqual([]);
    expect(contested(b, 0, "D")).toEqual([]);
    eliminate(b, 1, "disconnected", 1);
    expect(contested(b, 0, "R")).toEqual([]);
    expect(describeOptions(b, 0).R).not.toContain("CONTESTED");
  });

  it("describes every option by what applying it really does", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const b = generateArena(seed, "medium", 4);
      for (let t = 1; t < 160; t++) {
        const seat = t % 4;
        if (!b.seats[seat].alive) continue;
        const opts = describeOptions(b, seat);
        for (const d of DIRS) {
          const copy = cloneBoard(b);
          const r = applyMove(copy, seat, d, t);
          expect(opts[d].includes("FATAL"), opts[d]).toBe(!r.moved);
          if (r.moved) {
            expect(opts[d]).toContain(`Room after this move: ${room(b, seat, d).cells} cells`);
            expect(opts[d]).toContain(`to row ${Math.floor(r.to / b.grid) + 1} col ${(r.to % b.grid) + 1}.`);
          }
        }
        const pick = DIRS[(seed * 7 + t) % 4];
        applyMove(b, seat, pick, t);
      }
    }
  });

  it("prints the state with 1-based coordinates that match the map", () => {
    const b = boardFrom(["#######", "#..b..#", "#.rRbB#", "#.....#", "#.....#", "#.....#", "#######"], { R: "R", B: "D" });
    const text = describeState(b, 0, 72_000, 300_000);
    expect(text).toContain("You are RED (R). Alive: Red, Blue.");
    expect(text).toContain("Match time 1:12 of 5:00.");
    expect(text).toContain("#.rRbB#");
    expect(text).toContain("You are at row 3 col 4, heading right. Blue's head: row 3 col 6, heading down.");
    expect(describeOptions(b, 0).D).toBe(
      "Move down to row 4 col 4. Open. Room after this move: 17 cells, shared with Blue.",
    );
    applyMove(b, 1, "D", 5);
    expect(describeState(b, 0, 0, 1000)).not.toContain("Out:");
    applyMove(b, 1, "U", 6);
    expect(describeState(b, 0, 0, 1000)).toContain("Out: Blue (crashed into its own trail).");
  });
});
