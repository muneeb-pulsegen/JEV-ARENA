import { describe, expect, it } from "vitest";
import { frontlineOrder } from "@/lib/agents/demo";
import { defaultSize, estimateMatch, hexCount, PLAYERS, SIZE_IDS, SIZES } from "@/lib/frontline/config";
import { generateMap, hexDistance, landHexes, newState, NEUTRAL, regionsOf, type GameMap, type State } from "@/lib/frontline/map";
import {
  battle,
  describeState,
  fallbackOrder,
  income,
  options,
  resolveRound,
  standings,
  winnerOf,
  type Order,
} from "@/lib/frontline/rules";

/** A hand-built map from an edge list; names are A..Z. */
function mapOf(n: number, edges: [number, number][], cities: number[] = []): GameMap {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  return {
    radius: 1,
    q: Array(n).fill(0),
    r: Array(n).fill(0),
    name: Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)),
    lake: Array(n).fill(false),
    city: Array.from({ length: n }, (_, i) => cities.includes(i)),
    adj,
    starts: [],
  };
}

/** `cells` is [owner, troops] per region; owner -1 is neutral. */
function stateOf(players: number, cells: [number, number][]): State {
  return {
    round: 0,
    owner: cells.map((c) => c[0]),
    troops: cells.map((c) => c[1]),
    players: Array.from({ length: players }, (_, p) => ({ ...PLAYERS[p], alive: true, reachedAt: 0, fallbacks: 0 })),
  };
}

const attack = (from: number, to: number): Order => ({ kind: "attack", from, to });
const reinforce = (at: number): Order => ({ kind: "reinforce", at });

function landConnected(m: GameMap) {
  const land = landHexes(m);
  const seen = new Set([land[0]]);
  const stack = [land[0]];
  while (stack.length) for (const n of m.adj[stack.pop()!]) if (!seen.has(n)) (seen.add(n), stack.push(n));
  return seen.size === land.length;
}

describe("frontline config", () => {
  it("defaults the map size by player count and estimates bigger matches as dearer", () => {
    expect([2, 3, 4, 5, 6].map(defaultSize)).toEqual(["small", "small", "medium", "medium", "large"]);
    expect(estimateMatch(6, "large").tokens).toBeGreaterThan(estimateMatch(2, "small").tokens);
    expect(estimateMatch(6, "large").tokens).toBeLessThan(700_000);
  });
});

describe("map generation", () => {
  it("is deterministic per seed, with connected land, ~10% lakes, the right cities and spaced starts", () => {
    for (const size of SIZE_IDS) {
      for (let players = 2; players <= 6; players++) {
        for (let seed = 1; seed <= 5; seed++) {
          const m = generateMap(seed * 31 + players, size, players);
          expect(generateMap(seed * 31 + players, size, players)).toEqual(m);
          const n = hexCount(SIZES[size].radius);
          expect(m.q).toHaveLength(n);
          const lakes = m.lake.filter(Boolean).length / n;
          expect(lakes, `${size} ${players} ${seed}`).toBeGreaterThanOrEqual(0.08);
          expect(lakes).toBeLessThanOrEqual(0.12);
          expect(landConnected(m)).toBe(true);
          expect(m.city.filter(Boolean)).toHaveLength(SIZES[size].cities + players);
          expect(new Set(m.name).size).toBe(n);
          expect(m.starts).toHaveLength(players);
          for (const s of m.starts) {
            expect([m.lake[s], m.city[s]]).toEqual([false, true]);
            for (const o of m.starts) if (o !== s) expect(hexDistance(m, s, o)).toBeGreaterThanOrEqual(2);
          }
          const st = newState(m);
          m.starts.forEach((s, p) => expect([st.owner[s], st.troops[s]]).toEqual([p, 6]));
        }
      }
    }
  });
});

describe("combat", () => {
  //  A - B - C, B is a city
  const m = mapOf(3, [[0, 1], [1, 2]], [1]);

  it("captures when the army beats the defence, cities counting 1.5×", () => {
    const plain = mapOf(2, [[0, 1]]);
    expect(battle(plain, 1, 5, 3)).toEqual({ captured: true, left: 2 });
    expect(battle(plain, 1, 3, 3)).toEqual({ captured: false, left: 1 });
    expect(battle(plain, 1, 2, 5)).toEqual({ captured: false, left: 3 });
    expect(battle(m, 1, 6, 4)).toEqual({ captured: false, left: 1 });
    expect(battle(m, 1, 7, 4)).toEqual({ captured: true, left: 1 });
    expect(battle(m, 1, 3, 4)).toEqual({ captured: false, left: 2 });
  });

  it("adds income to the source after an attack, and double income on a reinforce", () => {
    const s = stateOf(2, [[0, 9], [NEUTRAL, 2], [1, 3]]);
    expect(income(m, s, 0)).toBe(3);
    const { state, report } = resolveRound(m, s, [attack(0, 1), reinforce(2)]);
    expect(report.income).toEqual([3, 3]);
    // 8 against a city of 2 (defends as 3): taken with 5; A keeps 1 + 3.
    expect([state.owner[1], state.troops[1], state.troops[0]]).toEqual([0, 5, 4]);
    expect(state.troops[2]).toBe(9);
    expect(income(m, state, 0)).toBe(3 + 1 + 2);
  });

  it("meets head-on armies first: the larger carries on, a tie destroys both", () => {
    const line = mapOf(2, [[0, 1]]);
    const s = stateOf(2, [[0, 10], [1, 6]]);
    const r = resolveRound(line, s, [attack(0, 1), attack(1, 0)]);
    expect(r.report.clashes[0]).toMatchObject({ armies: [9, 5], survivor: 0, left: 4 });
    // Red's 4 hit B, now holding 1: taken with 3. Blue is out.
    expect([r.state.owner[1], r.state.troops[1]]).toEqual([0, 3]);
    expect(r.state.players[1]).toMatchObject({ alive: false, out: "lost its last region to Red" });

    const tie = resolveRound(line, stateOf(2, [[0, 6], [1, 6]]), [attack(0, 1), attack(1, 0)]);
    expect(tie.report.clashes[0]).toMatchObject({ survivor: null });
    expect(tie.report.battles).toHaveLength(0);
    expect([tie.state.troops[0], tie.state.troops[1]]).toEqual([1 + 3, 1 + 3]);
  });

  it("makes several attackers fight each other first, and a tie leaves the region alone", () => {
    //   A(R) - C(n) - B(G), C - D(B)
    const star = mapOf(4, [[0, 2], [1, 2], [2, 3]]);
    const s = stateOf(3, [[0, 10], [2, 7], [NEUTRAL, 2], [1, 5]]);
    const r = resolveRound(star, s, [attack(0, 2), attack(3, 2), attack(1, 2)]);
    const b = r.report.battles[0];
    expect(b.attackers).toEqual([{ player: 0, army: 9 }, { player: 2, army: 6 }, { player: 1, army: 4 }]);
    expect([b.captured, r.state.owner[2], r.state.troops[2]]).toEqual([0, 0, 1]);

    const even = resolveRound(star, stateOf(3, [[0, 7], [2, 7], [NEUTRAL, 2], [1, 1]]), [attack(0, 2), null, attack(1, 2)]);
    expect([even.state.owner[2], even.state.troops[2]]).toEqual([NEUTRAL, 2]);
  });

  it("lets an emptied source fall to a rival, and lands a rival's reinforcement before the battle", () => {
    //  A(R) - B(n) ; A - C(B)
    const tri = mapOf(3, [[0, 1], [0, 2]]);
    const s = stateOf(2, [[0, 8], [NEUTRAL, 2], [1, 4]]);
    const r = resolveRound(tri, s, [attack(0, 1), attack(2, 0)]);
    expect([r.state.owner[0], r.state.troops[0]]).toEqual([1, 2]);
    expect(r.state.owner[1]).toBe(0);

    const held = resolveRound(tri, stateOf(2, [[0, 9], [NEUTRAL, 2], [1, 4]]), [attack(0, 2), reinforce(2)]);
    // Blue's C goes from 4 to 4 + 2×3 = 10 before Red's 8 arrives.
    expect([held.state.owner[2], held.state.troops[2]]).toEqual([1, 2]);
  });

  it("ignores orders that aren't legal", () => {
    const s = stateOf(2, [[0, 1], [NEUTRAL, 2], [1, 4]]);
    const r = resolveRound(m, s, [attack(0, 1), attack(2, 0)]);
    expect(r.report.orders).toEqual([null, null]);
  });
});

describe("capitals and borders", () => {
  it("knocks a player out when its capital falls and hands every region it holds to the captor", () => {
    //  A(R cap) - B(B cap) - C(B) - D(B)
    const m = mapOf(4, [[0, 1], [1, 2], [2, 3]], [0, 1]);
    m.starts = [0, 1];
    const s = stateOf(2, [[0, 12], [1, 4], [1, 5], [1, 3]]);
    // Blue's capital B defends as 6; Red's 11 takes it with 5.
    const { state, report } = resolveRound(m, s, [attack(0, 1), null]);
    expect(state.owner).toEqual([0, 0, 0, 0]);
    expect(state.troops).toEqual([1 + income(m, s, 0), 5, 5, 3]);
    expect(report.eliminated).toEqual([{ player: 1, by: 0, capital: true }]);
    expect(state.players[1]).toMatchObject({ alive: false, out: "lost its capital to Red" });
    expect(options(m, s, 0).choices.A1).toContain("Taking it knocks Blue out and hands you all 3 of its regions.");
  });

  it("settles two capitals falling at once in seat order, passing the first loser's conquests on", () => {
    //  A(R cap 2) - E(B 12) ; B(B cap 2) - D(R 12) ; A - B
    const m = mapOf(4, [[0, 3], [1, 2], [0, 1]], [0, 1]);
    m.starts = [0, 1];
    const s = stateOf(2, [[0, 2], [1, 2], [0, 12], [1, 12]]);
    const r = resolveRound(m, s, [attack(2, 1), attack(3, 0)]);
    // Red falls first (seat order) and its regions, Blue's capital included, go to Blue, who survives.
    expect(r.report.eliminated).toEqual([{ player: 0, by: 1, capital: true }]);
    expect(r.state.owner).toEqual([1, 1, 1, 1]);
    expect(winnerOf(r.state, "small")).toEqual({ winner: 1, reason: "last" });
  });

  it("grows borders into empty land only one player touches", () => {
    //  A(R) - B(n) - C(n) - D(B) ; E(n) touches A and D
    const m = mapOf(5, [[0, 1], [1, 2], [2, 3], [0, 4], [3, 4]]);
    const s = stateOf(2, [[0, 3], [NEUTRAL, 2], [NEUTRAL, 2], [1, 3], [NEUTRAL, 2]]);
    const { state, report } = resolveRound(m, s, [null, null]);
    expect(report.grown).toEqual([{ hex: 1, player: 0 }, { hex: 2, player: 1 }]);
    expect([state.owner[1], state.troops[1], state.owner[2], state.owner[4]]).toEqual([0, 1, 1, NEUTRAL]);
  });
});

describe("winning", () => {
  it("ends when one player is left, or at the round limit on regions, troops, then who got there first", () => {
    const m = mapOf(4, [[0, 1], [1, 2], [2, 3]]);
    const s = stateOf(2, [[0, 5], [0, 3], [1, 2], [1, 6]]);
    expect(winnerOf(s, "small")).toBeNull();
    s.round = SIZES.small.rounds;
    expect(winnerOf(s, "small")).toEqual({ winner: 0, reason: "limit" });
    s.players[0].reachedAt = 9;
    s.players[1].reachedAt = 4;
    expect(winnerOf(s, "small")).toEqual({ winner: 1, reason: "limit" });
    s.troops[3] = 7;
    expect(winnerOf(s, "small")).toEqual({ winner: 1, reason: "limit" });
    s.players[0].alive = false;
    expect(winnerOf(s, "small")).toEqual({ winner: 1, reason: "last" });
    expect(standings(s, 1).map((x) => [x.name, x.place])).toEqual([["Blue", 1], ["Red", 2]]);
    expect(regionsOf(s, 1)).toBe(2);
    void m;
  });
});

describe("what a player sees", () => {
  it("describes every option by what resolving it alone really does", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const players = 2 + (seed % 5);
      const m = generateMap(seed, players > 3 ? "medium" : "small", players);
      let s = newState(m);
      for (let round = 0; round < 14; round++) {
        const orders: (Order | null)[] = [];
        for (let p = 0; p < players; p++) {
          if (!s.players[p].alive) {
            orders.push(null);
            continue;
          }
          const { choices, orders: menu } = options(m, s, p);
          expect(Object.keys(choices).length).toBeLessThanOrEqual(9);
          expect(Object.keys(menu)).toEqual(Object.keys(choices));
          for (const [id, order] of Object.entries(menu)) {
            const solo = players ? s.players.map((_, k) => (k === p ? order : null)) : [];
            const { state: after } = resolveRound(m, s, solo);
            const text = choices[id];
            if (order.kind === "attack") {
              const took = text.match(/Takes it with (\d+) left/);
              if (took) expect([after.owner[order.to], after.troops[order.to]], text).toEqual([p, Number(took[1])]);
              const held = text.match(/holds with (\d+) if nobody/);
              if (held) expect([after.owner[order.to], after.troops[order.to]], text).toEqual([s.owner[order.to], Number(held[1])]);
              expect(took || held).toBeTruthy();
              const keeps = Number(text.match(/keeps 1 \+ (\d+) income/)![1]);
              expect(after.troops[order.from]).toBe(1 + keeps);
            } else {
              const to = Number(text.match(/→ (\d+)\./)![1]);
              expect(after.troops[order.at], text).toBe(to);
            }
          }
          orders.push(menu[frontlineOrder(choices, (seed + round + p) % 4 === 0)]);
        }
        s = resolveRound(m, s, orders).state;
      }
    }
  });

  it("falls back to reinforcing the most threatened region", () => {
    //  A(R 3) - B(G 9) ; C(R 5) - D(n 2)
    const m = mapOf(4, [[0, 1], [2, 3], [0, 2]]);
    const s = stateOf(2, [[0, 3], [1, 9], [0, 5], [NEUTRAL, 2]]);
    expect(fallbackOrder(m, s, 0)).toEqual({ kind: "reinforce", at: 0 });
    expect(options(m, s, 0).choices.R1).toBe("Reinforce A (3) with 8 → 11. No attack this round. Blue's B could attack it with 8.");
  });

  it("prints the map with one line per region and last round's news", () => {
    const m = generateMap(3, "small", 3);
    const s = newState(m);
    const first = describeState(m, s, 1, "small");
    expect(first).toContain("Round 1 of 30. You are BLUE (B). Income this round: 5 troops.");
    expect(first).toContain("Alive: Red 1 regions, Blue 1 regions, Green 1 regions.");
    expect(first.split("\n").filter((l) => l.startsWith("  "))).toHaveLength(landHexes(m).length);
    expect(first).toContain(`  ${m.name[m.starts[1]]}^ B6: `);
    expect(first).toContain(`Your capital: ${m.name[m.starts[1]]}.`);
    expect(first).toContain("Last round: this is the first round.");
    const orders = [0, 1, 2].map((p) => options(m, s, p).orders.A1);
    const { state, report } = resolveRound(m, s, orders);
    expect(describeState(m, state, 0, "small", report)).toMatch(/Last round: .*took/);
  });
});
