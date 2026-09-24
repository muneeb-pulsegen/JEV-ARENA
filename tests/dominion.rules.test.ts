import { describe, expect, it } from "vitest";
import { growthCost, SIZE_IDS, SIZES, TECHS, type Stack } from "@/lib/dominion/config";
import { battle, defendersAt, stackStrength } from "@/lib/dominion/combat";
import { buyCost, cityYield, runEconomy, turnsFor, workedTiles } from "@/lib/dominion/economy";
import { around, distance, generateMap, passable, path, type GameMap } from "@/lib/dominion/map";
import { questionsFor } from "@/lib/dominion/questions";
import { cloneState, newState, unitCount, type State } from "@/lib/dominion/state";
import { resolveTurn, validSite, type Orders } from "@/lib/dominion/turn";
import { checkVictory, score } from "@/lib/dominion/victory";

/** A small world of plain grassland with no resources, so every number is predictable. */
function flatWorld(players = 2): { m: GameMap; s: State } {
  const m = generateMap(1, "small", players);
  m.terrain = m.terrain.map(() => "grassland");
  m.resource = m.resource.map(() => null);
  return { m, s: newState(m, 1) };
}

const hold = (n: number): (Orders | null)[] => Array.from({ length: n }, () => ({}));
const neighbourOf = (m: GameMap, hex: number, k = 0) => m.nb[hex][k];

describe("map generation", () => {
  it("is deterministic, keeps passable land connected, and gives every start food, horses and iron nearby", () => {
    for (const size of SIZE_IDS) {
      for (let players = 2; players <= 6; players++) {
        for (let seed = 1; seed <= 4; seed++) {
          const m = generateMap(seed * 17 + players, size, players);
          expect(generateMap(seed * 17 + players, size, players)).toEqual(m);
          const land = m.terrain.map((_, i) => i).filter((i) => passable(m, i));
          const seen = new Set([m.starts[0]]);
          const stack = [m.starts[0]];
          while (stack.length) for (const x of m.nb[stack.pop()!]) if (passable(m, x) && !seen.has(x)) (seen.add(x), stack.push(x));
          expect(seen.size, `${size} ${players} ${seed}`).toBe(land.length);
          expect(land.length / m.q.length).toBeGreaterThan(0.78);
          for (const st of m.starts) {
            expect(passable(m, st)).toBe(true);
            const near = (r: number, res: string) => around(m, st, r).some((i) => m.resource[i] === res);
            expect(near(2, "wheat")).toBe(true);
            expect(near(4, "horses")).toBe(true);
            expect(near(4, "iron")).toBe(true);
            for (const o of m.starts) if (o !== st) expect(distance(m, st, o)).toBeGreaterThanOrEqual(3);
          }
          expect(m.q.length).toBe(3 * SIZES[size].radius * (SIZES[size].radius + 1) + 1);
        }
      }
    }
  });
});

describe("economy", () => {
  it("works the best tiles and grows on schedule", () => {
    const { m, s } = flatWorld();
    const c = s.cities[0];
    expect(workedTiles(m, s, c)).toHaveLength(1);
    // Centre 2/1/1 plus one grassland (2 food); the capital adds 2 gold and 2 science.
    expect(cityYield(m, s, c)).toEqual({ food: 4, prod: 1, gold: 3, science: 3, surplus: 2 });
    const turns = Math.ceil(growthCost(1) / 2);
    for (let t = 0; t < turns - 1; t++) runEconomy(m, s);
    expect(c.pop).toBe(1);
    runEconomy(m, s);
    expect([c.pop, c.food]).toEqual([2, 0]);
  });

  it("builds units into the garrison with overflow, clears finished buildings, and makes settlers from population", () => {
    const { m, s } = flatWorld();
    const c = s.cities[0];
    c.build = { kind: "unit", unit: "warrior" };
    c.prod = 9.5;
    runEconomy(m, s);
    expect([c.garrison.warrior, c.prod, c.build?.kind, c.idle]).toEqual([1, 0.5, "unit", true]);

    s.players[0].techs.push("pottery");
    c.build = { kind: "building", building: "granary" };
    c.prod = 30;
    runEconomy(m, s);
    expect([c.buildings, c.build]).toEqual([["granary"], null]);

    c.pop = 2;
    c.build = { kind: "settler" };
    c.prod = 29;
    runEconomy(m, s);
    expect([c.pop, s.settlers.length]).toEqual([1, 1]);
  });

  it("buys an item outright for 2 gold per missing production point", () => {
    const { m, s } = flatWorld();
    const c = s.cities[0];
    s.players[0].gold = 100;
    c.prod = 4;
    expect(buyCost(m, s, c, { kind: "unit", unit: "warrior" })).toBe(12);
    const { state, report } = resolveTurn(m, s, [{ builds: { [c.id]: { item: { kind: "unit", unit: "warrior" }, buy: true } } }, {}]);
    expect(state.cities[0].garrison.warrior).toBe(1);
    expect(state.players[0].gold).toBe(100 - 12 + 3);
    expect(report.events.some((e) => e.kind === "bought")).toBe(true);
  });

  it("charges upkeep beyond 2 units per city and disbands the weakest unit when broke", () => {
    const { m, s } = flatWorld();
    s.cities[0].garrison = { warrior: 2, swordsman: 1 };
    s.players[0].gold = 0;
    // 2 army warriors + 3 in garrison = 5 units, 2 free: upkeep 3 against 3 gold income.
    runEconomy(m, s);
    expect(s.players[0].gold).toBe(0);
    s.cities[0].garrison.swordsman = 3;
    const events = runEconomy(m, s);
    expect(events.filter((e) => e.kind === "disbanded").every((e) => e.kind === "disbanded" && e.unit === "warrior")).toBe(true);
    expect(s.players[0].gold).toBeGreaterThanOrEqual(0);
  });

  it("researches only techs whose prerequisites are known", () => {
    const { m, s } = flatWorld();
    const { state } = resolveTurn(m, s, [{ research: "iron" }, { research: "bronze" }]);
    expect(state.players[0].research).toBeNull();
    expect(state.players[1].research).toBe("bronze");
    s.players[1].research = "bronze";
    s.players[1].progress = TECHS.bronze.cost - 1;
    runEconomy(m, s);
    expect(s.players[1].techs).toEqual(["bronze"]);
  });

  it("gives a wonder to the first finisher and turns the other's production into gold", () => {
    const { m, s } = flatWorld();
    for (const p of [0, 1]) s.players[p].techs.push("pottery");
    s.cities[0].build = { kind: "wonder", wonder: "gardens" };
    s.cities[0].prod = 100;
    s.cities[1].build = { kind: "wonder", wonder: "gardens" };
    s.cities[1].prod = 60;
    const events = runEconomy(m, s);
    expect(s.wonders.gardens).toBe(0);
    expect(events.find((e) => e.kind === "wonder_lost")).toMatchObject({ player: 1, gold: 60 + 1 });
    expect(s.cities[1].build).toBeNull();
  });
});

describe("combat", () => {
  const { m } = flatWorld();
  const hex = m.starts[0];

  it("applies counters by how much of the enemy they hit", () => {
    const spear: Stack = { spearman: 2 }, horse: Stack = { horseman: 2 };
    expect(stackStrength(spear, horse)).toBe(8);
    expect(stackStrength(horse, spear)).toBe(6);
    expect(stackStrength({ spearman: 2 }, { horseman: 1, warrior: 1 })).toBe(6);
    expect(stackStrength({ catapult: 2 }, {}, { vsCity: true })).toBe(8);
  });

  it("gives the defender terrain, fortify and walls, and costs the winner (weaker / stronger)^1.5 of its units", () => {
    const hills = { ...m, terrain: m.terrain.map(() => "hills" as const) };
    const r = battle(hills, { swordsman: 3 }, { units: { spearman: 2 }, hex, fortified: true });
    // 12 against 2 × 2 × 1.5 (hills) × 1.5 (fortified) = 9.
    expect([r.attack, r.defence, r.attackerWins]).toEqual([12, 9, true]);
    expect(r.attackerLeft).toEqual({ swordsman: 3 - Math.round(3 * (9 / 12) ** 1.5) });
    // A tie goes to the defender, which loses (2 / 2)^1.5 = all of its units too.
    const tie = battle(m, { warrior: 2 }, { units: { warrior: 2 }, hex });
    expect([tie.attackerWins, tie.attackerLeft, tie.defenderLeft]).toEqual([false, {}, {}]);
  });

  it("defends cities with their base, walls and archers, and lets catapults break them", () => {
    const { m: w, s } = flatWorld();
    const c = s.cities[1];
    c.pop = 4;
    c.garrison = { archer: 2 };
    c.buildings.push("walls");
    s.armies[1] = null;
    const d = defendersAt(w, s, c.hex)!;
    // Against swordsmen: (2 archers × 2 × 1.5 counter × 1.5 in a city + base 6) × 1.5 walls = 22.5.
    expect(battle(w, { swordsman: 4 }, d.defence).defence).toBe(22.5);
    expect(battle(w, { swordsman: 4 }, d.defence).attackerWins).toBe(false);
    // Half the stack catapults (4 each against cities): 12 + 12 = 24 against 20.25.
    const siege = battle(w, { swordsman: 3, catapult: 3 }, d.defence);
    expect([siege.attack, siege.defence, siege.attackerWins]).toEqual([24, 20.25, true]);
  });
});

describe("turns", () => {
  it("moves armies a hex a turn, horsemen two, and fights armies that meet or swap", () => {
    const { m, s } = flatWorld();
    const a = s.armies[0]!;
    const far = m.q.map((_, i) => i).sort((x, y) => distance(m, a.hex, y) - distance(m, a.hex, x))[0];
    let r = resolveTurn(m, s, [{ army: { kind: "march", target: far } }, {}]);
    expect(distance(m, r.state.armies[0]!.hex, a.hex)).toBe(1);
    s.armies[0]!.units = { horseman: 2 };
    r = resolveTurn(m, s, [{ army: { kind: "march", target: far } }, {}]);
    expect(distance(m, r.state.armies[0]!.hex, a.hex)).toBe(2);

    const t = cloneState(s);
    const x = neighbourOf(m, m.starts[0], 0);
    const y = m.nb[x].find((n) => distance(m, n, m.starts[0]) === 2 && distance(m, n, m.starts[1]) > 1)!;
    t.armies[0] = { hex: x, units: { spearman: 3 }, fortified: false };
    t.armies[1] = { hex: y, units: { horseman: 2 }, fortified: false };
    r = resolveTurn(m, t, [{ army: { kind: "march", target: y } }, { army: { kind: "march", target: x } }]);
    const fight = r.report.events.find((e) => e.kind === "battle");
    expect(fight).toMatchObject({ field: true });
    expect(unitCount(r.state.armies[1]!.units)).toBe(0);
    expect(unitCount(r.state.armies[0]!.units)).toBeGreaterThan(0);
  });

  it("captures a city it beats, and knocks out a player that loses its last city", () => {
    const { m, s } = flatWorld();
    const target = s.cities[1];
    const next = m.nb[target.hex][0];
    s.armies[0] = { hex: next, units: { swordsman: 3 }, fortified: false };
    s.armies[1] = { hex: target.hex, units: {}, fortified: false };
    target.pop = 2;
    target.buildings.push("walls");
    const { state, report } = resolveTurn(m, s, [{ army: { kind: "march", target: target.hex } }, {}]);
    const c = state.cities.find((x) => x.id === target.id)!;
    expect([c.owner, c.pop, c.buildings]).toEqual([0, 1, []]);
    expect(report.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["battle", "captured", "eliminated"]));
    expect(state.players[1]).toMatchObject({ alive: false, out: "lost its last city to Red" });
    expect(checkVictory(m, state, "small")).toEqual({ winner: 0, kind: "domination" });
  });

  it("walks settlers to their site and founds a city there; an enemy army in the way catches them", () => {
    const { m, s } = flatWorld();
    const home = s.cities[0].hex;
    const site = m.q.map((_, i) => i).find((i) => distance(m, home, i) === 3 && validSite(m, s, i, 0) && distance(m, i, s.cities[1].hex) > 3)!;
    s.settlers.push({ id: 99, owner: 0, hex: home, target: null });
    let st = s;
    for (let k = 0; k < 3; k++) st = resolveTurn(m, st, [k === 0 ? { settle: { settler: 99, target: site } } : {}, {}]).state;
    expect(st.cities.some((c) => c.hex === site && c.owner === 0)).toBe(true);
    expect(st.settlers).toHaveLength(0);

    const t = cloneState(s);
    t.settlers[0].target = site;
    const step = path(m, home, site)![1];
    t.armies[1] = { hex: step, units: { warrior: 1 }, fortified: false };
    const r = resolveTurn(m, t, hold(2));
    expect(r.state.settlers).toHaveLength(0);
    expect(r.report.events.find((e) => e.kind === "settler_lost")).toMatchObject({ player: 0, by: 1, hex: step });
  });

  it("musters a garrison into the army and garrisons it back", () => {
    const { m, s } = flatWorld();
    s.cities[0].garrison = { archer: 1, spearman: 2 };
    let r = resolveTurn(m, s, [{ army: { kind: "muster", city: s.cities[0].id } }, {}]);
    expect(r.state.armies[0]!.units).toEqual({ warrior: 2, spearman: 2 });
    expect(r.state.cities[0].garrison).toEqual({ archer: 1 });
    r = resolveTurn(m, r.state, [{ army: { kind: "garrison" } }, {}]);
    expect(unitCount(r.state.armies[0]!.units)).toBe(0);
    expect(r.state.cities[0].garrison).toEqual({ archer: 1, warrior: 2, spearman: 2 });
  });
});

describe("victory", () => {
  it("checks domination, science, wonders and then score at the turn limit", () => {
    const { m, s } = flatWorld(3);
    expect(checkVictory(m, s, "small")).toBeNull();
    s.players[2].wonders.push("gardens", "pyramids", "colossus");
    expect(checkVictory(m, s, "small")).toEqual({ winner: 2, kind: "wonders" });
    s.cities[1].buildings.push("observatory");
    expect(checkVictory(m, s, "small")).toEqual({ winner: 1, kind: "science" });
    s.cities[1].owner = 0;
    s.cities[2].owner = 0;
    expect(checkVictory(m, s, "small")).toEqual({ winner: 0, kind: "domination" });

    const t = flatWorld(2).s;
    t.turn = SIZES.small.turns;
    t.cities[1].pop = 3;
    expect(checkVictory(flatWorld(2).m, t, "small")).toEqual({ winner: 1, kind: "score" });
    expect(score(t, 1)).toBeGreaterThan(score(t, 0));
  });
});

describe("questions", () => {
  it("asks only what a player needs to decide, and every recommendation is one of the options", () => {
    const m = generateMap(5, "medium", 4);
    const s = newState(m, 5);
    const { questions } = questionsFor(m, s, 0, "medium");
    expect(questions.map((q) => q.kind).sort()).toEqual(["army", "build", "research"]);
    for (const q of questions) {
      expect(Object.keys(q.choices)).toEqual(Object.keys(q.orders));
      expect(q.choices[q.recommended]).toBeTruthy();
    }
    const built = cloneState(s);
    built.cities[0].idle = false;
    built.cities[0].build = { kind: "unit", unit: "warrior" };
    built.players[0].research = "bronze";
    expect(questionsFor(m, built, 0, "medium").questions.map((q) => q.kind)).toEqual(["army"]);
  });

  it("states build times that match what actually happens", () => {
    const m = generateMap(8, "small", 2);
    let s = newState(m, 8);
    const q = questionsFor(m, s, 0, "small").questions.find((x) => x.kind === "build")!;
    const warrior = Number(q.choices.Warrior.match(/(\d+) turns?/)![1]);
    const c = s.cities[0];
    expect(turnsFor(m, s, c, { kind: "unit", unit: "warrior" })).toBe(warrior);
    const orders: (Orders | null)[] = [q.orders.Warrior, {}];
    let done = 0;
    for (let t = 1; t <= 20 && !done; t++) {
      s = resolveTurn(m, s, t === 1 ? orders : [{}, {}]).state;
      if (s.cities[0].garrison.warrior) done = t;
    }
    expect(done).toBe(warrior);
  });

  it("predicts attack outcomes that match the battle when the target stays put", () => {
    const { m, s } = flatWorld();
    const target = s.cities[1];
    s.armies[0] = { hex: m.nb[target.hex][0], units: { swordsman: 2, archer: 2 }, fortified: false };
    s.armies[1] = null;
    s.players[0].seen = s.players[0].seen.map(() => true);
    const q = questionsFor(m, s, 0, "small").questions.find((x) => x.kind === "army")!;
    const key = Object.keys(q.choices).find((k) => k === `Attack ${target.name}`)!;
    expect(q.choices[key]).toMatch(/you win and capture it|you lose your whole army/);
    const predictedWin = /you win/.test(q.choices[key]);
    const r = resolveTurn(m, s, [q.orders[key], {}]);
    expect(r.state.cities.find((c) => c.id === target.id)!.owner === 0).toBe(predictedWin);
  });
});
