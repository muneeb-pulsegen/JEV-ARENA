import { CASTLE, cityBase, FORTIFY, GREAT_WALL_FIELD, TERRAIN, UNIT_IDS, UNITS, WALLS, type Stack, type UnitId } from "./config";
import type { GameMap } from "./map";
import { unitCount, type City, type State } from "./state";

/**
 * A stack's strength against an enemy stack: each unit's strength times its
 * counter bonuses, weighted by how much of the enemy each bonus applies to.
 */
export function stackStrength(units: Stack, enemy: Stack, opts: { vsCity?: boolean; defendingCity?: boolean } = {}): number {
  const enemyTotal = unitCount(enemy);
  let total = 0;
  for (const u of UNIT_IDS) {
    const n = units[u] ?? 0;
    if (!n) continue;
    const def = UNITS[u];
    let str = opts.vsCity && def.siege ? def.siege : def.strength;
    if (enemyTotal > 0 && def.beats) {
      let mult = 1;
      for (const [target, bonus] of Object.entries(def.beats) as [UnitId, number][]) mult += ((enemy[target] ?? 0) / enemyTotal) * (bonus - 1);
      str *= mult;
    }
    if (opts.defendingCity && def.cityDefence) str *= def.cityDefence;
    total += n * str;
  }
  return total;
}

export type Defence = {
  units: Stack;
  hex: number;
  fortified?: boolean;
  /** The city on this hex, if the defenders hold it. */
  city?: City;
  /** Defending an army inside its own territory with the Great Wall. */
  greatWallField?: boolean;
  /** The defending player owns the Great Wall (for cities). */
  greatWallCity?: boolean;
};

export function defenceMultiplier(m: GameMap, d: Defence): number {
  let mult = TERRAIN[m.terrain[d.hex]].defence;
  if (d.fortified) mult *= FORTIFY;
  if (d.city) {
    if (d.city.buildings.includes("castle")) mult *= CASTLE;
    else if (d.city.buildings.includes("walls") || d.greatWallCity) mult *= WALLS;
  } else if (d.greatWallField) mult *= GREAT_WALL_FIELD;
  return mult;
}

export function defenceStrength(m: GameMap, attackers: Stack, d: Defence): number {
  const base = stackStrength(d.units, attackers, { defendingCity: !!d.city }) + (d.city ? cityBase(d.city.pop) : 0);
  return base * defenceMultiplier(m, d);
}

export type BattleResult = {
  attackerWins: boolean;
  attack: number;
  defence: number;
  attackerLeft: Stack;
  defenderLeft: Stack;
};

/** Removes a share of each unit type, rounded. */
function losses(units: Stack, share: number): Stack {
  const out: Stack = {};
  for (const u of UNIT_IDS) {
    const n = units[u] ?? 0;
    if (!n) continue;
    const left = n - Math.round(n * share);
    if (left > 0) out[u] = left;
  }
  return out;
}

/** Deterministic: the stronger side wins (ties to the defender), the loser is destroyed, the winner loses (weaker / stronger)^1.5 of each unit type. */
export function battle(m: GameMap, attackers: Stack, d: Defence): BattleResult {
  const attack = stackStrength(attackers, d.units, { vsCity: !!d.city });
  const defence = defenceStrength(m, attackers, d);
  if (attack > defence) {
    return { attackerWins: true, attack, defence, attackerLeft: losses(attackers, (defence / attack) ** 1.5), defenderLeft: {} };
  }
  return { attackerWins: false, attack, defence, attackerLeft: {}, defenderLeft: attack > 0 ? losses(d.units, (attack / defence) ** 1.5) : d.units };
}

/** Everything defending a hex for its owner: the city's garrison plus that player's army if it stands there. */
export function defendersAt(m: GameMap, s: State, hex: number): { player: number; defence: Defence } | null {
  const city = s.cities.find((c) => c.hex === hex);
  const armyOwner = s.armies.findIndex((a) => a?.hex === hex && unitCount(a.units) > 0);
  const player = city ? city.owner : armyOwner;
  if (player < 0) return null;
  const army = s.armies[player]?.hex === hex ? s.armies[player]! : null;
  const units: Stack = { ...(city?.garrison ?? {}) };
  for (const [u, n] of Object.entries(army?.units ?? {}) as [UnitId, number][]) units[u] = (units[u] ?? 0) + n;
  const wall = s.players[player].wonders.includes("wall");
  return {
    player,
    defence: {
      units,
      hex,
      fortified: army?.fortified,
      city,
      greatWallField: wall && s.owner[hex] === player,
      greatWallCity: wall,
    },
  };
}

export function describeStack(units: Stack): string {
  const parts = UNIT_IDS.filter((u) => units[u]).map((u) => `${units[u]} ${units[u] === 1 ? UNITS[u].name.toLowerCase() : UNITS[u].plural}`);
  return parts.length ? parts.join(", ") : "no units";
}
