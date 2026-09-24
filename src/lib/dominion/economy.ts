import {
  BORDER_GROWTH_POP,
  BUILDINGS,
  BUY_GOLD_PER_PROD,
  CAPITAL_BONUS,
  FOOD_PER_POP,
  FREE_UNITS_PER_CITY,
  growthCost,
  MARBLE_DISCOUNT,
  RESOURCES,
  SETTLER,
  TECHS,
  TERRAIN,
  UNITS,
  WONDERS,
  type Resource,
  type TechId,
  type UnitId,
  type WonderId,
  type Yield,
} from "./config";
import { distance, type GameMap } from "./map";
import { claim, unitCount, type BuildItem, type City, type State } from "./state";

/** What a hex yields for a player, including its resource and Mining's hill bonus. */
export function tileYield(m: GameMap, s: State, hex: number, p: number): Yield {
  const t = TERRAIN[m.terrain[hex]];
  const res = m.resource[hex];
  const y = { food: t.food, prod: t.prod, gold: t.gold };
  if (res) {
    y.food += RESOURCES[res].food;
    y.prod += RESOURCES[res].prod;
    y.gold += RESOURCES[res].gold;
  }
  if (m.terrain[hex] === "hills" && s.players[p].techs.includes("mining")) y.prod += 1;
  return y;
}

/** The city each owned hex belongs to: the nearest city of the same owner, ties to the older city. */
export function hexCity(m: GameMap, s: State): Map<number, City> {
  const out = new Map<number, City>();
  s.owner.forEach((o, hex) => {
    if (o < 0) return;
    let best: City | undefined;
    for (const c of s.cities) {
      if (c.owner !== o) continue;
      if (!best || distance(m, hex, c.hex) < distance(m, hex, best.hex)) best = c;
    }
    if (best) out.set(hex, best);
  });
  return out;
}

const score = (y: Yield) => y.food * 2.2 + y.prod * 2 + y.gold;

/** The tiles a city works: one per population point, the best yields in its share of territory, avoiding enemy armies. */
export function workedTiles(m: GameMap, s: State, c: City, owners = hexCity(m, s)): number[] {
  const enemyArmies = new Set(s.armies.flatMap((a, p) => (a && p !== c.owner ? [a.hex] : [])));
  const options = [...owners.entries()]
    .filter(([hex, city]) => city === c && hex !== c.hex && TERRAIN[m.terrain[hex]].workable && !enemyArmies.has(hex))
    .map(([hex]) => ({ hex, v: score(tileYield(m, s, hex, c.owner)) }))
    .sort((a, b) => b.v - a.v || a.hex - b.hex);
  return options.slice(0, c.pop).map((o) => o.hex);
}

export const hasBuilding = (c: City, b: City["buildings"][number]) => c.buildings.includes(b);

/** Resources inside a player's territory. */
export function resourcesOf(m: GameMap, s: State, p: number): Set<Resource> {
  const out = new Set<Resource>();
  s.owner.forEach((o, hex) => o === p && m.resource[hex] && out.add(m.resource[hex]!));
  return out;
}

export type CityYield = { food: number; prod: number; gold: number; science: number; surplus: number };

/** A city's full yield per turn after buildings, wonders and the capital bonus. */
export function cityYield(m: GameMap, s: State, c: City, owners = hexCity(m, s)): CityYield {
  const centre = tileYield(m, s, c.hex, c.owner);
  let food = Math.max(2, centre.food), prod = Math.max(1, centre.prod), gold = Math.max(1, centre.gold);
  for (const hex of workedTiles(m, s, c, owners)) {
    const y = tileYield(m, s, hex, c.owner);
    food += y.food;
    prod += y.prod;
    gold += y.gold;
  }
  const pl = s.players[c.owner];
  const capital = c.capitalOf === c.owner;
  let science = 1 + Math.floor(c.pop / 2);
  if (hasBuilding(c, "granary")) food += 2;
  if (pl.wonders.includes("gardens")) food += 2;
  if (hasBuilding(c, "workshop")) prod += 2;
  if (hasBuilding(c, "library")) science += 2;
  if (hasBuilding(c, "market")) gold += 2;
  if (capital) {
    gold += CAPITAL_BONUS.gold;
    science += CAPITAL_BONUS.science;
  }
  if (pl.wonders.includes("pyramids")) prod = Math.floor(prod * 1.25);
  science = Math.floor(science * (1 + (hasBuilding(c, "library") ? 0.5 : 0) + (pl.wonders.includes("library") ? 0.25 : 0)));
  if (hasBuilding(c, "market")) gold = Math.floor(gold * 1.5);
  return { food, prod, gold, science, surplus: food - FOOD_PER_POP * c.pop };
}

export function upkeep(s: State, p: number): number {
  const units = unitCount(s.armies[p]?.units ?? {}) + s.cities.filter((c) => c.owner === p).reduce((n, c) => n + unitCount(c.garrison), 0);
  const free = FREE_UNITS_PER_CITY * s.cities.filter((c) => c.owner === p).length;
  return Math.max(0, units - free);
}

export type Economy = { gold: number; science: number; upkeep: number; net: number };

export function economy(m: GameMap, s: State, p: number, owners = hexCity(m, s)): Economy {
  let gold = 0, science = 0;
  for (const c of s.cities) {
    if (c.owner !== p) continue;
    const y = cityYield(m, s, c, owners);
    gold += y.gold;
    science += y.science;
  }
  if (s.players[p].wonders.includes("colossus")) gold += 6;
  const u = upkeep(s, p);
  return { gold, science, upkeep: u, net: gold - u };
}

// ---------- What can be built ----------

export function itemCost(m: GameMap, s: State, c: City, item: BuildItem): number {
  switch (item.kind) {
    case "unit":
      return UNITS[item.unit].cost;
    case "settler":
      return SETTLER.cost;
    case "building":
      return BUILDINGS[item.building].cost;
    case "wonder": {
      const marble = [...hexCity(m, s).entries()].some(([hex, city]) => city === c && m.resource[hex] === "marble");
      return Math.round(WONDERS[item.wonder].cost * (marble ? 1 - MARBLE_DISCOUNT : 1));
    }
  }
}

export const buyCost = (m: GameMap, s: State, c: City, item: BuildItem) => BUY_GOLD_PER_PROD * Math.max(0, itemCost(m, s, c, item) - c.prod);

export const sameItem = (a: BuildItem | null, b: BuildItem | null) => JSON.stringify(a) === JSON.stringify(b);

/** Why an item can't be built in this city, or null if it can. */
export function cannotBuild(m: GameMap, s: State, c: City, item: BuildItem): string | null {
  const pl = s.players[c.owner];
  switch (item.kind) {
    case "unit": {
      const u = UNITS[item.unit];
      if (u.tech && !pl.techs.includes(u.tech)) return `needs ${TECHS[u.tech].name}`;
      if (u.resource && !resourcesOf(m, s, c.owner).has(u.resource)) return `needs ${u.resource}`;
      return null;
    }
    case "settler":
      return c.pop < SETTLER.minPop ? `needs population ${SETTLER.minPop}` : null;
    case "building": {
      const b = BUILDINGS[item.building];
      if (c.buildings.includes(item.building)) return "already built";
      if (!pl.techs.includes(b.tech)) return `needs ${TECHS[b.tech].name}`;
      if (b.needs && !c.buildings.includes(b.needs)) return `needs ${BUILDINGS[b.needs].name}`;
      return null;
    }
    case "wonder": {
      const w = WONDERS[item.wonder];
      if (s.wonders[item.wonder] !== undefined) return "already built";
      if (!pl.techs.includes(w.tech)) return `needs ${TECHS[w.tech].name}`;
      if (s.cities.some((o) => o !== c && o.owner === c.owner && sameItem(o.build, item))) return "being built in another of your cities";
      return null;
    }
  }
}

export function itemName(item: BuildItem): string {
  switch (item.kind) {
    case "unit":
      return UNITS[item.unit].name;
    case "settler":
      return "Settler";
    case "building":
      return BUILDINGS[item.building].name;
    case "wonder":
      return WONDERS[item.wonder].name;
  }
}

// ---------- Research ----------

export function availableTechs(s: State, p: number): TechId[] {
  const known = s.players[p].techs;
  return (Object.keys(TECHS) as TechId[]).filter((t) => !known.includes(t) && TECHS[t].needs.every((n) => known.includes(n)));
}

// ---------- The economy phase of a turn ----------

export type EconomyEvent =
  | { kind: "built"; player: number; city: number; item: BuildItem }
  | { kind: "wonder"; player: number; city: number; wonder: WonderId }
  | { kind: "wonder_lost"; player: number; city: number; wonder: WonderId; gold: number }
  | { kind: "tech"; player: number; tech: TechId }
  | { kind: "grew"; player: number; city: number; pop: number }
  | { kind: "starved"; player: number; city: number; pop: number }
  | { kind: "disbanded"; player: number; unit: UnitId }
  | { kind: "observatory"; player: number; city: number };

const WEAKEST: UnitId[] = ["warrior", "catapult", "spearman", "archer", "horseman", "swordsman"];

/** Removes the weakest unit a player has, garrisons first. */
function disbandOne(s: State, p: number): UnitId | null {
  for (const u of WEAKEST) {
    const c = s.cities.find((x) => x.owner === p && (x.garrison[u] ?? 0) > 0);
    if (c) {
      c.garrison[u]! -= 1;
      return u;
    }
    const a = s.armies[p];
    if (a && (a.units[u] ?? 0) > 0) {
      a.units[u]! -= 1;
      return u;
    }
  }
  return null;
}

/**
 * Runs production, growth, gold and science for every living player. Yields are
 * worked out from the start-of-phase state so city order doesn't matter.
 */
export function runEconomy(m: GameMap, s: State): EconomyEvent[] {
  const events: EconomyEvent[] = [];
  const owners = hexCity(m, s);
  const yields = new Map(s.cities.map((c) => [c.id, cityYield(m, s, c, owners)]));
  const econ = s.players.map((pl, p) => (pl.alive ? economy(m, s, p, owners) : null));

  for (const c of s.cities) {
    const y = yields.get(c.id)!;
    // Food and growth.
    c.food += y.surplus;
    if (c.food >= growthCost(c.pop)) {
      c.food = hasBuilding(c, "granary") ? Math.floor(growthCost(c.pop) / 2) : 0;
      c.pop++;
      events.push({ kind: "grew", player: c.owner, city: c.id, pop: c.pop });
      if (c.pop === BORDER_GROWTH_POP) claim(m, s, c, 2);
    } else if (c.food < 0) {
      c.food = 0;
      if (c.pop > 1) {
        c.pop--;
        events.push({ kind: "starved", player: c.owner, city: c.id, pop: c.pop });
      }
    }

    // Production.
    if (!c.build) continue;
    c.prod += y.prod;
    const cost = itemCost(m, s, c, c.build);
    if (c.prod < cost) continue;
    const item = c.build;
    if (item.kind === "wonder" && s.wonders[item.wonder] !== undefined) continue; // settled below
    if (item.kind === "settler" && c.pop < SETTLER.minPop) continue; // waits until the city regrows
    c.prod -= cost;
    c.idle = true;
    switch (item.kind) {
      case "unit":
        c.garrison[item.unit] = (c.garrison[item.unit] ?? 0) + 1;
        break;
      case "settler":
        c.pop--;
        s.settlers.push({ id: s.nextId++, owner: c.owner, hex: c.hex, target: null });
        break;
      case "building":
        c.buildings.push(item.building);
        if (item.building === "observatory") events.push({ kind: "observatory", player: c.owner, city: c.id });
        c.build = null;
        break;
      case "wonder":
        s.wonders[item.wonder] = c.owner;
        s.players[c.owner].wonders.push(item.wonder);
        events.push({ kind: "wonder", player: c.owner, city: c.id, wonder: item.wonder });
        c.build = null;
        break;
    }
    if (item.kind !== "wonder") events.push({ kind: "built", player: c.owner, city: c.id, item });
    // Units and settlers repeat until changed; buildings and wonders clear.
  }

  // A wonder someone else finished: the production spent turns into gold.
  for (const c of s.cities) {
    if (c.build?.kind !== "wonder" || s.wonders[c.build.wonder] === undefined || s.wonders[c.build.wonder] === c.owner) continue;
    const gold = c.prod;
    s.players[c.owner].gold += gold;
    events.push({ kind: "wonder_lost", player: c.owner, city: c.id, wonder: c.build.wonder, gold });
    c.prod = 0;
    c.build = null;
  }

  s.players.forEach((pl, p) => {
    const e = econ[p];
    if (!e || !pl.alive) return;
    pl.gold += e.net;
    while (pl.gold < 0) {
      const u = disbandOne(s, p);
      if (!u) {
        pl.gold = 0;
        break;
      }
      events.push({ kind: "disbanded", player: p, unit: u });
      pl.gold += 1;
    }
    if (pl.research) {
      pl.progress += e.science;
      const cost = TECHS[pl.research].cost;
      if (pl.progress >= cost) {
        pl.progress -= cost;
        pl.techs.push(pl.research);
        events.push({ kind: "tech", player: p, tech: pl.research });
        pl.research = null;
      }
    }
  });
  return events;
}

/** Turns until a city finishes an item at its current production, or Infinity. */
export function turnsFor(m: GameMap, s: State, c: City, item: BuildItem, owners = hexCity(m, s)): number {
  const left = itemCost(m, s, c, item) - c.prod;
  if (left <= 0) return 1;
  const prod = cityYield(m, s, c, owners).prod;
  return prod <= 0 ? Infinity : Math.ceil(left / prod);
}

/** Turns until a city grows at its current food, or Infinity. */
export function turnsToGrow(m: GameMap, s: State, c: City, owners = hexCity(m, s)): number {
  const surplus = cityYield(m, s, c, owners).surplus;
  if (surplus <= 0) return Infinity;
  return Math.max(1, Math.ceil((growthCost(c.pop) - c.food) / surplus));
}
