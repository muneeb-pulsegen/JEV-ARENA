import { BUILDINGS, SIZES, TECHS, TERRAIN, UNITS, WONDERS, type SizeId } from "./config";
import { defendersAt, defenceStrength, describeStack, stackStrength } from "./combat";
import { cityYield, economy, hexCity, itemCost, itemName, resourcesOf, turnsToGrow, workedTiles } from "./economy";
import { grid, type GameMap } from "./map";
import { unitCount, type City, type State } from "./state";
import { visible, type TurnReport } from "./turn";
import { score } from "./victory";

/** The rules in short. Sent at the top of every state, since every question shares it. */
export const RULES = [
  "You are playing Dominion, a Civilization-style game on a hex map against rival civilizations. All players act at the same time each turn.",
  "Win by DOMINATION (hold every original capital, or be the last player with cities), SCIENCE (research Astronomy and build an Observatory), WONDERS (own 3 of the 5 wonders), or SCORE at the turn limit (3 per population, 4 per tech, 10 per wonder, 5 per city, 1 per 4 territory hexes).",
  "Cities work one territory hex per population. Each population eats 2 food; stored food makes the city grow. Territory grows from 1 to 2 hexes around a city at population 3.",
  "Production builds units, buildings and wonders. Gold pays upkeep: 2 units per city are free, each extra unit costs 1 gold per turn. Science researches one tech at a time.",
  "You have one field army (a stack that moves together, 1 hex per turn, 2 if all horsemen) and a garrison in every city. New units join their city's garrison; muster them into the army.",
  "Combat: the stronger side wins and the loser's stack is destroyed; the winner loses a share of its units. Spearmen are strong against horsemen, archers against spearmen and swordsmen (and defend cities well), horsemen against archers and catapults, catapults against cities. Hills, forest, fortifying, walls and castles help defenders. Taking a city captures it.",
  "Rivals' armies, cities and settlers are only visible near your own cities and army. Each question you are asked is answered on its own, so judge each one from this state.",
].join("\n");

const cityLine = (m: GameMap, s: State, c: City, owners: ReturnType<typeof hexCity>) => {
  const y = cityYield(m, s, c, owners);
  const grow = turnsToGrow(m, s, c, owners);
  const res = [...new Set(workedTiles(m, s, c, owners).concat(c.hex).map((h) => m.resource[h]).filter(Boolean))];
  const building = c.build
    ? `building ${itemName(c.build)} ${Math.floor(c.prod)}/${itemCost(m, s, c, c.build)}${y.prod > 0 ? ` (${Math.max(1, Math.ceil((itemCost(m, s, c, c.build) - c.prod) / y.prod))} turns)` : ""}`
    : "building nothing";
  return [
    `  ${c.name}${c.capitalOf === c.owner ? " (capital)" : c.capitalOf >= 0 ? ` (${s.players[c.capitalOf].name}'s former capital)` : ""} at ${m.name[c.hex]}: population ${c.pop}`,
    `food ${y.surplus >= 0 ? "+" : ""}${y.surplus}${Number.isFinite(grow) ? ` (grows in ${grow})` : ""}, production ${y.prod}, gold ${y.gold}, science ${y.science}`,
    building,
    `buildings: ${c.buildings.map((b) => BUILDINGS[b].name).join(", ") || "none"}`,
    `garrison: ${describeStack(c.garrison)}`,
    res.length ? `resources worked: ${res.join(", ")}` : "",
  ].filter(Boolean).join("; ");
};

function eventText(m: GameMap, s: State, p: number, e: TurnReport["events"][number]): string | null {
  const name = (q: number) => (q === p ? "You" : s.players[q].name);
  const city = (id: number) => s.cities.find((c) => c.id === id)?.name ?? "a city";
  switch (e.kind) {
    case "founded":
      return e.player === p ? `You founded ${city(e.city)} at ${m.name[e.hex]}.` : null;
    case "built":
      return e.player === p ? `${city(e.city)} finished ${itemName(e.item)}.` : null;
    case "bought":
      return e.player === p ? `You bought ${itemName(e.item)} in ${city(e.city)} for ${e.gold} gold.` : null;
    case "wonder":
      return `${name(e.player)} completed the ${WONDERS[e.wonder].name}.`;
    case "wonder_lost":
      return e.player === p ? `${city(e.city)} lost the race for the ${WONDERS[e.wonder].name}; its production became ${Math.floor(e.gold)} gold.` : null;
    case "tech":
      return e.player === p ? `You discovered ${TECHS[e.tech].name}.` : null;
    case "grew":
    case "starved":
      return e.player === p && e.kind === "starved" ? `${city(e.city)} is starving (population ${e.pop}).` : null;
    case "disbanded":
      return e.player === p ? `A ${UNITS[e.unit].name.toLowerCase()} was disbanded: you ran out of gold.` : null;
    case "battle":
      if (e.attacker !== p && e.defender !== p) return null;
      return `${name(e.attacker)} attacked ${name(e.defender)} at ${m.name[e.hex]} (${e.attack.toFixed(1)} vs ${e.defence.toFixed(1)}): ${e.attackerWins ? name(e.attacker) : name(e.defender)} won.`;
    case "captured":
      return `${name(e.to)} captured ${city(e.city)} from ${name(e.from)}.`;
    case "settler_lost":
      return e.player === p ? `Your settler was caught by ${s.players[e.by].name} at ${m.name[e.hex]}.` : e.by === p ? `You caught a ${s.players[e.player].name} settler.` : null;
    case "eliminated":
      return `${s.players[e.player].name} has been eliminated.`;
    case "observatory":
      return `${name(e.player)} built the Observatory.`;
  }
}

/** A player's view of the game, shared by every question it's asked this turn. */
export function describeState(m: GameMap, s: State, p: number, size: SizeId, last?: TurnReport): string {
  const pl = s.players[p];
  const owners = hexCity(m, s);
  const econ = economy(m, s, p, owners);
  const mine = s.cities.filter((c) => c.owner === p);
  const see = visible(m, s, p);
  const army = s.armies[p];
  const lines: string[] = [RULES, ""];

  const research = pl.research
    ? `researching ${TECHS[pl.research].name} ${pl.progress}/${TECHS[pl.research].cost}${econ.science > 0 ? ` (${Math.ceil((TECHS[pl.research].cost - pl.progress) / econ.science)} turns)` : ""}`
    : "not researching anything";
  lines.push(
    `Turn ${s.turn + 1} of ${SIZES[size].turns}. You are ${pl.name.toUpperCase()} (${pl.id}). Score ${score(s, p)}.`,
    `Gold ${Math.floor(pl.gold)} (${econ.net >= 0 ? "+" : ""}${econ.net} per turn after ${econ.upkeep} upkeep). Science ${econ.science} per turn, ${research}.`,
    `Techs: ${pl.techs.map((t) => TECHS[t].name).join(", ") || "none"}. Wonders: ${pl.wonders.map((w) => WONDERS[w].name).join(", ") || "none"}. Resources in your land: ${[...resourcesOf(m, s, p)].join(", ") || "none"}.`,
  );
  const built = Object.entries(s.wonders).map(([w, q]) => `${WONDERS[w as keyof typeof WONDERS].name} (${s.players[q!].name})`);
  if (built.length) lines.push(`Wonders already built: ${built.join(", ")}.`);

  lines.push("Rivals (public totals):");
  s.players.forEach((o, q) => {
    if (q === p) return;
    if (!o.alive) return void lines.push(`  ${o.name}: eliminated on turn ${o.outTurn}.`);
    const cs = s.cities.filter((c) => c.owner === q);
    lines.push(`  ${o.name}: ${cs.length} cities, population ${cs.reduce((n, c) => n + c.pop, 0)}, ${o.techs.length} techs, ${o.wonders.length} wonders, score ${score(s, q)}.`);
  });

  lines.push(`Your cities (${mine.length}):`, ...mine.map((c) => cityLine(m, s, c, owners)));
  if (army && unitCount(army.units)) {
    lines.push(`Your army at ${m.name[army.hex]} (${m.terrain[army.hex]}): ${describeStack(army.units)}, strength ${stackStrength(army.units, {}).toFixed(1)}${army.fortified ? ", fortified" : ""}.`);
  } else lines.push("Your army: none in the field.");
  const settlers = s.settlers.filter((st) => st.owner === p);
  if (settlers.length) lines.push(`Your settlers: ${settlers.map((st) => `at ${m.name[st.hex]}${st.target !== null ? ` heading to ${m.name[st.target]}` : " waiting"}`).join("; ")}.`);

  const seen: string[] = [];
  s.armies.forEach((a, q) => {
    if (q === p || !a || !unitCount(a.units) || !see.has(a.hex)) return;
    seen.push(`  ${s.players[q].name}'s army at ${m.name[a.hex]}: ${describeStack(a.units)}, strength ${stackStrength(a.units, {}).toFixed(1)}${a.fortified ? ", fortified" : ""}.`);
  });
  for (const c of s.cities) {
    if (c.owner === p || !see.has(c.hex)) continue;
    const d = defendersAt(m, s, c.hex)!;
    seen.push(`  ${s.players[c.owner].name}'s city ${c.name} at ${m.name[c.hex]}: population ${c.pop}, ${c.buildings.includes("castle") ? "castle" : c.buildings.includes("walls") ? "walls" : "no walls"}, garrison ${describeStack(c.garrison)}, defence about ${defenceStrength(m, {}, d.defence).toFixed(1)}.`);
  }
  for (const st of s.settlers) if (st.owner !== p && see.has(st.hex)) seen.push(`  ${s.players[st.owner].name}'s settler at ${m.name[st.hex]}.`);
  lines.push(seen.length ? "Rivals you can see now:" : "Rivals you can see now: none.", ...seen);

  const cityHex = new Map(s.cities.map((c) => [c.hex, c]));
  lines.push(
    "Terrain map (g grassland, p plains, f forest, h hills, d desert, ~ lake, ^ mountain; resources W wheat, H horses, I iron, G gold, M marble):",
    grid(m, (i) => {
      const r = m.resource[i];
      return r ? { wheat: "W", horses: "H", iron: "I", gold: "G", marble: "M" }[r] : TERRAIN[m.terrain[i]].letter;
    }),
    "Owner map (lowercase letter = that player's land, UPPERCASE = a city, . unclaimed, ? never seen; you are " + pl.id + "):",
    grid(m, (i) => {
      if (!pl.seen[i] && !see.has(i)) return "?";
      const c = cityHex.get(i);
      if (c && (c.owner === p || see.has(i) || pl.seen[i])) return s.players[c.owner].id;
      return s.owner[i] >= 0 ? s.players[s.owner[i]].id.toLowerCase() : ".";
    }),
  );

  const news = (last?.events ?? []).map((e) => eventText(m, s, p, e)).filter(Boolean);
  lines.push(`Last turn: ${news.length ? news.join(" ") : last ? "quiet." : "this is the first turn."}`);
  return lines.join("\n");
}
