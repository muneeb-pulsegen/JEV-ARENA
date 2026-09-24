import {
  BUILDING_IDS,
  BUILDINGS,
  MAX_BUILD_QUESTIONS,
  SETTLER,
  TECHS,
  UNIT_IDS,
  UNITS,
  WONDER_IDS,
  WONDERS,
  type SizeId,
  type TechId,
  type UnitId,
} from "./config";
import { battle, defendersAt, defenceStrength, describeStack, stackStrength } from "./combat";
import {
  availableTechs,
  buyCost,
  cannotBuild,
  cityYield,
  economy,
  hexCity,
  itemName,
  resourcesOf,
  tileYield,
  turnsFor,
} from "./economy";
import { distance, path, steps, type GameMap } from "./map";
import { unitCount, type BuildItem, type City, type State } from "./state";
import { validSite, visible, type Orders } from "./turn";

export type QuestionKind = "build" | "research" | "army" | "settle";

export type Question = {
  key: string;
  kind: QuestionKind;
  instructions: string;
  /** Option id → the outcome text shown to the model. */
  choices: Record<string, string>;
  /** Option id → the orders that option stands for. */
  orders: Record<string, Orders>;
  /** The demo bot's pick, also used when an answer is missing or invalid. */
  recommended: string;
};

// ---------- Build ----------

const DEFENDERS: UnitId[] = ["archer", "spearman", "swordsman", "warrior"];
const ATTACKERS: UnitId[] = ["swordsman", "horseman", "catapult", "archer", "spearman", "warrior"];

function unlockText(t: TechId): string {
  const parts = [
    ...UNIT_IDS.filter((u) => UNITS[u].tech === t).map((u) => `${UNITS[u].plural} (strength ${UNITS[u].strength}${UNITS[u].resource ? `, need ${UNITS[u].resource}` : ""})`),
    ...BUILDING_IDS.filter((b) => BUILDINGS[b].tech === t).map((b) => `${BUILDINGS[b].name} (${BUILDINGS[b].effect})`),
    ...WONDER_IDS.filter((w) => WONDERS[w].tech === t).map((w) => `the ${WONDERS[w].name} wonder (${WONDERS[w].effect})`),
  ];
  if (t === "mining") parts.push("+1 production on hills");
  const leads = (Object.keys(TECHS) as TechId[]).filter((x) => TECHS[x].needs.includes(t)).map((x) => TECHS[x].name);
  return `Unlocks ${parts.join("; ") || "nothing directly"}.${leads.length ? ` Leads to ${leads.join(", ")}.` : ""}`;
}

function itemText(m: GameMap, s: State, c: City, item: BuildItem, owners: ReturnType<typeof hexCity>): string {
  const turns = turnsFor(m, s, c, item, owners);
  const when = Number.isFinite(turns) ? `${turns} turn${turns === 1 ? "" : "s"}` : "never at current production";
  switch (item.kind) {
    case "unit": {
      const u = UNITS[item.unit];
      const beats = u.beats ? `, strong against ${Object.keys(u.beats).map((b) => UNITS[b as UnitId].plural).join(" and ")}` : "";
      return `${u.name}: ${when}. Strength ${u.strength}${u.siege ? ` (${u.siege} against cities)` : ""}${beats}${u.cityDefence ? ", +50% defending a city" : ""}. Joins ${c.name}'s garrison (now ${describeStack(c.garrison)}).`;
    }
    case "settler":
      return `Settler: ${when}; ${c.name} drops from population ${c.pop} to ${c.pop - 1} when it's done. Founds a new city on an open site.`;
    case "building":
      return `${BUILDINGS[item.building].name}: ${when}. ${BUILDINGS[item.building].effect[0].toUpperCase()}${BUILDINGS[item.building].effect.slice(1)}.`;
    case "wonder":
      return `${WONDERS[item.wonder].name} (wonder): ${when}. ${WONDERS[item.wonder].effect[0].toUpperCase()}${WONDERS[item.wonder].effect.slice(1)}. Only the first civilization to finish it gets it; 3 wonders win the game.`;
  }
}

/** Enemy army strength visible within `r` hexes of a hex. */
function threatNear(m: GameMap, s: State, p: number, hex: number, r: number, see = visible(m, s, p)): number {
  let t = 0;
  s.armies.forEach((a, q) => {
    if (q !== p && a && unitCount(a.units) && see.has(a.hex) && distance(m, a.hex, hex) <= r) t = Math.max(t, stackStrength(a.units, {}));
  });
  return t;
}

function bestUnit(m: GameMap, s: State, c: City, order: UnitId[]): UnitId {
  return order.find((u) => !cannotBuild(m, s, c, { kind: "unit", unit: u })) ?? "warrior";
}

/** The demo bot's build: defend when threatened, expand to a target city count, grow the economy, then wonders and armies. */
function recommendBuild(m: GameMap, s: State, c: City, size: SizeId, see: Set<number>): BuildItem {
  const p = c.owner;
  const cities = s.cities.filter((x) => x.owner === p);
  const threat = threatNear(m, s, p, c.hex, 3, see);
  const d = defendersAt(m, s, c.hex)!;
  if (threat > 0 && threat >= defenceStrength(m, {}, d.defence) * 0.8) {
    if (!c.buildings.includes("walls") && !cannotBuild(m, s, c, { kind: "building", building: "walls" })) return { kind: "building", building: "walls" };
    return { kind: "unit", unit: bestUnit(m, s, c, DEFENDERS) };
  }
  if (unitCount(c.garrison) === 0) return { kind: "unit", unit: bestUnit(m, s, c, DEFENDERS) };
  const target = { small: 4, medium: 5, large: 5 }[size];
  const expanding = cities.length + s.settlers.filter((st) => st.owner === p).length + s.cities.filter((x) => x.owner === p && x.build?.kind === "settler").length;
  const openSite = m.q.some((_, i) => (s.players[p].seen[i] || s.owner[i] === p) && validSite(m, s, i, p) && steps(m, c.hex, i) <= 8);
  if (expanding < target && openSite && c.pop >= SETTLER.minPop && c.build?.kind !== "settler") return { kind: "settler" };
  if (!cannotBuild(m, s, c, { kind: "building", building: "observatory" })) return { kind: "building", building: "observatory" };
  for (const b of ["granary", "workshop"] as const) if (!cannotBuild(m, s, c, { kind: "building", building: b })) return { kind: "building", building: b };
  // Keep a standing army that grows over the game; siege engines once the army has none.
  const units = unitCount(s.armies[p]?.units ?? {}) + cities.reduce((n, x) => n + unitCount(x.garrison), 0);
  if (units < cities.length * 2 + Math.floor(s.turn / 6)) {
    const army = s.armies[p]?.units ?? {};
    if (!army.catapult && unitCount(army) >= 4 && !cannotBuild(m, s, c, { kind: "unit", unit: "catapult" })) return { kind: "unit", unit: "catapult" };
    return { kind: "unit", unit: bestUnit(m, s, c, ATTACKERS) };
  }
  for (const b of ["library", "market"] as const) if (!cannotBuild(m, s, c, { kind: "building", building: b })) return { kind: "building", building: b };
  if (!s.cities.some((x) => x.owner === p && x.build?.kind === "wonder")) {
    const w = WONDER_IDS.find((w) => !cannotBuild(m, s, c, { kind: "wonder", wonder: w }));
    if (w && cityYield(m, s, c).prod >= 5) return { kind: "wonder", wonder: w };
  }
  for (const b of ["walls", "castle"] as const) if (!cannotBuild(m, s, c, { kind: "building", building: b })) return { kind: "building", building: b };
  return { kind: "unit", unit: bestUnit(m, s, c, ATTACKERS) };
}

const itemKey = (item: BuildItem) => itemName(item);

function buildQuestion(m: GameMap, s: State, c: City, size: SizeId, see: Set<number>, owners: ReturnType<typeof hexCity>): Question {
  const items: BuildItem[] = [
    ...UNIT_IDS.map((unit) => ({ kind: "unit", unit }) as BuildItem),
    { kind: "settler" } as BuildItem,
    ...BUILDING_IDS.map((building) => ({ kind: "building", building }) as BuildItem),
    ...WONDER_IDS.map((wonder) => ({ kind: "wonder", wonder }) as BuildItem),
  ].filter((item) => !cannotBuild(m, s, c, item));
  const choices: Record<string, string> = {};
  const orders: Record<string, Orders> = {};
  for (const item of items) {
    choices[itemKey(item)] = itemText(m, s, c, item, owners);
    orders[itemKey(item)] = { builds: { [c.id]: { item } } };
  }
  const rec = recommendBuild(m, s, c, size, see);
  // Buying: the recommended item, and the best defender, if the treasury covers it.
  const gold = s.players[c.owner].gold;
  const buyable = [rec, { kind: "unit", unit: bestUnit(m, s, c, DEFENDERS) } as BuildItem].filter((it, k, arr) => k === arr.findIndex((x) => itemKey(x) === itemKey(it)));
  for (const item of buyable) {
    const cost = buyCost(m, s, c, item);
    if (cannotBuild(m, s, c, item) || cost <= 0 || cost > gold) continue;
    const key = `Buy ${itemKey(item)}`;
    choices[key] = `Buy ${itemName(item)} now for ${cost} of your ${Math.floor(gold)} gold: it is finished at the end of this turn instead of in ${turnsFor(m, s, c, item, owners)} turns.`;
    orders[key] = { builds: { [c.id]: { item, buy: true } } };
  }
  // Buy when the city is threatened, or when the treasury is comfortably full.
  const threatened = threatNear(m, s, c.owner, c.hex, 2, see) > 0;
  const rich = gold - buyCost(m, s, c, rec) >= 50;
  const recommended = (threatened || rich) && choices[`Buy ${itemKey(rec)}`] ? `Buy ${itemKey(rec)}` : itemKey(rec);
  return {
    key: `build_${c.name.toLowerCase().replace(/[^a-z]/g, "")}`,
    kind: "build",
    instructions: `Choose what your city ${c.name} (population ${c.pop}, ${cityYield(m, s, c, owners).prod} production per turn) builds next.`,
    choices,
    orders,
    recommended,
  };
}

// ---------- Research ----------

const RESEARCH_ORDER: TechId[] = ["bronze", "pottery", "mining", "archery", "writing", "currency", "iron", "mathematics", "horseback", "philosophy", "engineering", "astronomy"];

function researchQuestion(m: GameMap, s: State, p: number, owners: ReturnType<typeof hexCity>): Question | null {
  const techs = availableTechs(s, p);
  if (s.players[p].research || !techs.length) return null;
  const sci = economy(m, s, p, owners).science;
  const res = resourcesOf(m, s, p);
  const choices: Record<string, string> = {};
  const orders: Record<string, Orders> = {};
  for (const t of techs) {
    const need = UNIT_IDS.filter((u) => UNITS[u].tech === t && UNITS[u].resource).map((u) => UNITS[u].resource!);
    const have = need.length ? ` You ${need.every((r) => res.has(r)) ? "have" : "do not have"} ${need.join(" and ")} in your land.` : "";
    choices[TECHS[t].name] = `${TECHS[t].name}: ${sci > 0 ? Math.ceil(TECHS[t].cost / sci) : "∞"} turns at ${sci} science per turn. ${unlockText(t)}${have}`;
    orders[TECHS[t].name] = { research: t };
  }
  const pick = RESEARCH_ORDER.find((t) => techs.includes(t))!;
  return { key: "research", kind: "research", instructions: "Choose the technology your civilization researches next.", choices, orders, recommended: TECHS[pick].name };
}

// ---------- Army ----------

type Target = { hex: number; label: string; kind: "city" | "army"; owner: number };

function armyQuestion(m: GameMap, s: State, p: number, see: Set<number>): Question | null {
  const a = s.armies[p];
  const mine = s.cities.filter((c) => c.owner === p);
  const units = a ? a.units : {};
  const has = unitCount(units) > 0;
  const choices: Record<string, string> = {};
  const orders: Record<string, Orders> = {};
  const add = (key: string, text: string, o: Orders["army"]) => {
    if (Object.keys(choices).length >= 8 || choices[key]) return;
    choices[key] = text;
    orders[key] = { army: o };
  };
  let recommended = "";
  const strength = stackStrength(units, {});

  if (!has) {
    const musters = mine.filter((c) => unitCount(c.garrison) >= 2).sort((x, y) => unitCount(y.garrison) - unitCount(x.garrison));
    if (!musters.length) return null;
    for (const c of musters.slice(0, 4)) {
      add(`Muster at ${c.name}`, `Form a new army at ${c.name} from all but one unit of its garrison (${describeStack(c.garrison)}).`, { kind: "muster", city: c.id });
    }
    add("Stay home", "Keep every unit in its city garrison this turn.", { kind: "hold" });
    return { key: "army", kind: "army", instructions: "Your civilization has no army in the field. Decide whether to form one.", choices, orders, recommended: Object.keys(choices)[0] };
  }

  const here = a!.hex;
  const targets: Target[] = [];
  for (const c of s.cities) if (c.owner !== p && see.has(c.hex)) targets.push({ hex: c.hex, label: `${s.players[c.owner].name}'s city ${c.name}`, kind: "city", owner: c.owner });
  s.armies.forEach((x, q) => {
    if (q !== p && x && unitCount(x.units) && see.has(x.hex) && !s.cities.some((c) => c.hex === x.hex)) targets.push({ hex: x.hex, label: `${s.players[q].name}'s army`, kind: "army", owner: q });
  });
  const reach = targets
    .map((t) => ({ t, d: steps(m, here, t.hex) }))
    .filter((x) => Number.isFinite(x.d))
    .sort((x, y) => x.d - y.d || x.t.hex - y.t.hex)
    .slice(0, 3);
  let bestAttack: { key: string; margin: number } | null = null;
  for (const { t, d } of reach) {
    const def = defendersAt(m, s, t.hex);
    if (!def) continue;
    const r = battle(m, units, def.defence);
    const lost = unitCount(units) - unitCount(r.attackerLeft);
    const outcome = r.attackerWins
      ? `you win${t.kind === "city" ? " and capture it" : ""}, losing ${lost} of your ${unitCount(units)} units`
      : "you lose your whole army";
    const turns = Math.ceil(d / (unitCount(units) === (units.horseman ?? 0) ? 2 : 1));
    const key = `${d === 1 ? "Attack" : "March on"} ${t.kind === "city" ? t.label.split(" city ")[1] : `${s.players[t.owner].name} army at ${m.name[t.hex]}`}`;
    add(
      key,
      `${d === 1 ? "Attack" : "March toward"} ${t.label} at ${m.name[t.hex]}, ${d} hex${d === 1 ? "" : "es"} away (${turns} turn${turns === 1 ? "" : "s"}). Defended by ${describeStack(def.defence.units)}${t.kind === "city" ? ` and the city itself` : ""}: defence ${r.defence.toFixed(1)} against your attack ${r.attack.toFixed(1)}. If nothing changes when you arrive, ${outcome}.`,
      { kind: "march", target: t.hex },
    );
    const margin = r.attack / Math.max(0.1, r.defence);
    if (r.attackerWins && (!bestAttack || margin > bestAttack.margin)) bestAttack = { key, margin };
  }

  // Defend a threatened city of ours.
  const threatenedCity = mine
    .map((c) => ({ c, t: threatNear(m, s, p, c.hex, 3, see), d: defenceStrength(m, {}, defendersAt(m, s, c.hex)!.defence) }))
    .filter((x) => x.t > 0 && x.c.hex !== here)
    .sort((x, y) => y.t / y.d - x.t / x.d)[0];
  if (threatenedCity) {
    const d = steps(m, here, threatenedCity.c.hex);
    add(`Defend ${threatenedCity.c.name}`, `March back to ${threatenedCity.c.name} (${d} hexes): a rival army of strength ${threatenedCity.t.toFixed(1)} is within 3 hexes; the city alone defends at ${threatenedCity.d.toFixed(1)}.`, { kind: "march", target: threatenedCity.c.hex });
  }

  const cityHere = s.cities.find((c) => c.hex === here && c.owner === p);
  const def = defendersAt(m, s, here)!;
  add("Fortify", `Stay at ${m.name[here]} and fortify: your army defends at ${(defenceStrength(m, {}, { ...def.defence, fortified: true })).toFixed(1)} this turn instead of ${defenceStrength(m, {}, { ...def.defence, fortified: false }).toFixed(1)}.`, { kind: "fortify" });
  if (cityHere && unitCount(cityHere.garrison) >= 2) {
    add(`Muster at ${cityHere.name}`, `Take all but one unit of ${cityHere.name}'s garrison (${describeStack(cityHere.garrison)}) into the army.`, { kind: "muster", city: cityHere.id });
  }
  if (cityHere) add(`Garrison ${cityHere.name}`, `Disband the field army into ${cityHere.name}'s garrison to defend the city.`, { kind: "garrison" });

  // Go where recruits are, or explore.
  const depot = mine.filter((c) => unitCount(c.garrison) >= 2 && c.hex !== here).sort((x, y) => unitCount(y.garrison) - unitCount(x.garrison))[0];
  if (depot) add(`Rally at ${depot.name}`, `March to ${depot.name} (${steps(m, here, depot.hex)} hexes) to pick up its garrison of ${describeStack(depot.garrison)}.`, { kind: "march", target: depot.hex });
  const unseen = m.q
    .map((_, i) => i)
    .filter((i) => !s.players[p].seen[i] && path(m, here, i))
    .sort((x, y) => distance(m, here, x) - distance(m, here, y) || x - y)[0];
  if (unseen !== undefined) add(`Explore toward ${m.name[unseen]}`, `March toward unexplored land around ${m.name[unseen]} (${distance(m, here, unseen)} hexes) to find rivals and sites.`, { kind: "march", target: unseen });

  // The demo bot: defend, then attack with a clear edge, then gather strength, then explore, else fortify.
  const home = mine.find((c) => c.capitalOf === p) ?? mine[0];
  if (threatenedCity && threatenedCity.t > threatenedCity.d * 0.8) recommended = `Defend ${threatenedCity.c.name}`;
  else if (bestAttack && bestAttack.margin >= 1.15 && unitCount(units) >= 3) recommended = bestAttack.key;
  else if (cityHere && unitCount(cityHere.garrison) >= 2) recommended = `Muster at ${cityHere.name}`;
  else if (depot) recommended = `Rally at ${depot.name}`;
  else if (unseen !== undefined && (s.turn < 45 || !reach.length)) recommended = `Explore toward ${m.name[unseen]}`;
  else if (!cityHere && home && steps(m, here, home.hex) > 3 && !bestAttack) {
    add(`Return to ${home.name}`, `March home to ${home.name} (${steps(m, here, home.hex)} hexes).`, { kind: "march", target: home.hex });
    recommended = `Return to ${home.name}`;
  } else recommended = "Fortify";
  if (!choices[recommended]) recommended = "Fortify";
  return { key: "army", kind: "army", instructions: `Choose your field army's order this turn (it has ${describeStack(units)}, strength ${strength.toFixed(1)}).`, choices, orders, recommended };
}

// ---------- Settle ----------

/** How good a spot is for a city: its tiles within 2, favouring food and resources. */
export function siteValue(m: GameMap, s: State, hex: number, p: number): { value: number; food: number; prod: number; resources: string[] } {
  let food = 0, prod = 0, value = 0;
  const resources: string[] = [];
  for (let i = 0; i < m.q.length; i++) {
    const d = distance(m, hex, i);
    if (d > 2 || (s.owner[i] >= 0 && s.owner[i] !== p)) continue;
    const y = tileYield(m, s, i, p);
    const w = d <= 1 ? 1 : 0.5;
    food += y.food * w;
    prod += y.prod * w;
    value += (y.food * 2.2 + y.prod * 2 + y.gold) * w;
    if (m.resource[i]) {
      resources.push(m.resource[i]!);
      value += 3;
    }
  }
  if (m.terrain[hex] === "hills") value += 2;
  return { value, food: Math.round(food), prod: Math.round(prod), resources };
}

function settleQuestion(m: GameMap, s: State, p: number): Question | null {
  const st = s.settlers.find((x) => x.owner === p && x.target === null);
  if (!st) return null;
  const pl = s.players[p];
  const sites = m.q
    .map((_, i) => i)
    .filter((i) => (pl.seen[i] || s.owner[i] === p) && validSite(m, s, i, p))
    .map((i) => ({ i, d: steps(m, st.hex, i) }))
    .filter((x) => x.d <= 10)
    .map((x) => ({ ...x, v: siteValue(m, s, x.i, p) }))
    .sort((a, b) => b.v.value - b.d * 1.5 - (a.v.value - a.d * 1.5) || a.i - b.i)
    .slice(0, 4);
  const choices: Record<string, string> = {};
  const orders: Record<string, Orders> = {};
  for (const x of sites) {
    const rival = s.cities.filter((c) => c.owner !== p).sort((a, b) => distance(m, a.hex, x.i) - distance(m, b.hex, x.i))[0];
    const near = rival && distance(m, rival.hex, x.i) <= 5 ? ` ${distance(m, rival.hex, x.i)} hexes from ${s.players[rival.owner].name}'s ${rival.name}.` : "";
    choices[`Settle ${m.name[x.i]}`] = `Found a city at ${m.name[x.i]} (${m.terrain[x.i]}), ${x.d} turn${x.d === 1 ? "" : "s"} away. Its land yields about ${x.v.food} food and ${x.v.prod} production${x.v.resources.length ? `, with ${[...new Set(x.v.resources)].join(", ")}` : ""}.${near}`;
    orders[`Settle ${m.name[x.i]}`] = { settle: { settler: st.id, target: x.i } };
  }
  choices.Wait = `Keep the settler at ${m.name[st.hex]} this turn.`;
  orders.Wait = { settle: { settler: st.id, target: null } };
  return { key: "settle", kind: "settle", instructions: `Choose where your settler at ${m.name[st.hex]} founds a new city.`, choices, orders, recommended: Object.keys(choices)[0] };
}

// ---------- All of a player's questions this turn ----------

/**
 * Every decision a player faces this turn: builds for cities that finished
 * something (at most MAX_BUILD_QUESTIONS; the rest take the recommendation
 * silently), research when idle, the army every turn it can act, and one
 * waiting settler.
 */
export function questionsFor(m: GameMap, s: State, p: number, size: SizeId): { questions: Question[]; auto: Orders } {
  const see = visible(m, s, p);
  const owners = hexCity(m, s);
  const questions: Question[] = [];
  const auto: Orders = { builds: {} };
  const idle = s.cities.filter((c) => c.owner === p && (c.idle || !c.build)).sort((a, b) => Number(!!a.build) - Number(!!b.build) || a.id - b.id);
  idle.forEach((c, k) => {
    const q = buildQuestion(m, s, c, size, see, owners);
    if (k < MAX_BUILD_QUESTIONS) questions.push(q);
    else Object.assign(auto.builds!, q.orders[q.recommended].builds);
  });
  const r = researchQuestion(m, s, p, owners);
  if (r) questions.push(r);
  const a = armyQuestion(m, s, p, see);
  if (a) questions.push(a);
  const st = settleQuestion(m, s, p);
  if (st) questions.push(st);
  return { questions, auto };
}

/** Merges the orders picked for each question into one set of orders for the turn. */
export function mergeOrders(parts: Orders[]): Orders {
  const out: Orders = { builds: {} };
  for (const o of parts) {
    if (o.builds) Object.assign(out.builds!, o.builds);
    if (o.research) out.research = o.research;
    if (o.army) out.army = o.army;
    if (o.settle) out.settle = o.settle;
  }
  return out;
}
