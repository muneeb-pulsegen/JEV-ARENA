/** Dominion's rules as data. Shared by the server and the browser; no Node imports. */

export type SizeId = "small" | "medium" | "large";

export const SIZES: Record<SizeId, { radius: number; turns: number; label: string }> = {
  small: { radius: 5, turns: 60, label: "Small" },
  medium: { radius: 6, turns: 75, label: "Medium" },
  large: { radius: 7, turns: 90, label: "Large" },
};
export const SIZE_IDS = Object.keys(SIZES) as SizeId[];

export const PLAYERS = [
  { id: "R", name: "Red" },
  { id: "B", name: "Blue" },
  { id: "G", name: "Green" },
  { id: "Y", name: "Gold" },
  { id: "V", name: "Violet" },
  { id: "T", name: "Teal" },
] as const;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = PLAYERS.length;

export function defaultSize(players: number): SizeId {
  return players <= 3 ? "small" : players === 4 ? "medium" : "large";
}

// ---------- Terrain and resources ----------

export type Terrain = "grassland" | "plains" | "forest" | "hills" | "desert" | "lake" | "mountain";
export type Yield = { food: number; prod: number; gold: number };

export const TERRAIN: Record<Terrain, Yield & { defence: number; passable: boolean; workable: boolean; letter: string }> = {
  grassland: { food: 2, prod: 0, gold: 0, defence: 1, passable: true, workable: true, letter: "g" },
  plains: { food: 1, prod: 1, gold: 0, defence: 1, passable: true, workable: true, letter: "p" },
  forest: { food: 1, prod: 2, gold: 0, defence: 1.25, passable: true, workable: true, letter: "f" },
  hills: { food: 0, prod: 2, gold: 0, defence: 1.5, passable: true, workable: true, letter: "h" },
  desert: { food: 0, prod: 1, gold: 0, defence: 1, passable: true, workable: true, letter: "d" },
  lake: { food: 2, prod: 0, gold: 1, defence: 1, passable: false, workable: true, letter: "~" },
  mountain: { food: 0, prod: 0, gold: 0, defence: 1, passable: false, workable: false, letter: "^" },
};

export type Resource = "wheat" | "gold" | "horses" | "iron" | "marble";
export const RESOURCES: Record<Resource, Yield> = {
  wheat: { food: 2, prod: 0, gold: 0 },
  gold: { food: 0, prod: 0, gold: 3 },
  horses: { food: 0, prod: 1, gold: 0 },
  iron: { food: 0, prod: 1, gold: 0 },
  marble: { food: 0, prod: 1, gold: 0 },
};

// ---------- Technology ----------

export type TechId =
  | "pottery" | "bronze" | "archery" | "mining"
  | "horseback" | "iron" | "writing" | "currency" | "mathematics"
  | "engineering" | "philosophy" | "astronomy";

export const TECHS: Record<TechId, { name: string; cost: number; needs: TechId[] }> = {
  pottery: { name: "Pottery", cost: 25, needs: [] },
  bronze: { name: "Bronze Working", cost: 25, needs: [] },
  archery: { name: "Archery", cost: 25, needs: [] },
  mining: { name: "Mining", cost: 25, needs: [] },
  horseback: { name: "Horseback Riding", cost: 60, needs: ["archery"] },
  iron: { name: "Iron Working", cost: 60, needs: ["bronze"] },
  writing: { name: "Writing", cost: 60, needs: ["pottery"] },
  currency: { name: "Currency", cost: 60, needs: ["mining"] },
  mathematics: { name: "Mathematics", cost: 60, needs: ["archery", "mining"] },
  engineering: { name: "Engineering", cost: 110, needs: ["mathematics", "iron"] },
  philosophy: { name: "Philosophy", cost: 110, needs: ["writing", "currency"] },
  astronomy: { name: "Astronomy", cost: 110, needs: ["philosophy", "mathematics"] },
};
export const TECH_IDS = Object.keys(TECHS) as TechId[];

// ---------- Units ----------

export type UnitId = "warrior" | "spearman" | "archer" | "horseman" | "swordsman" | "catapult";
export type Stack = Partial<Record<UnitId, number>>;

export const UNITS: Record<UnitId, {
  name: string;
  plural: string;
  cost: number;
  strength: number;
  tech?: TechId;
  resource?: Resource;
  /** Multiplier against these enemy unit types. */
  beats?: Partial<Record<UnitId, number>>;
  /** Strength when attacking a city, if different. */
  siege?: number;
  /** Extra multiplier when defending a city. */
  cityDefence?: number;
}> = {
  warrior: { name: "Warrior", plural: "warriors", cost: 10, strength: 1 },
  spearman: { name: "Spearman", plural: "spearmen", cost: 18, strength: 2, tech: "bronze", beats: { horseman: 2 } },
  archer: { name: "Archer", plural: "archers", cost: 18, strength: 2, tech: "archery", beats: { spearman: 1.5, swordsman: 1.5 }, cityDefence: 1.5 },
  horseman: { name: "Horseman", plural: "horsemen", cost: 25, strength: 3, tech: "horseback", resource: "horses", beats: { archer: 2, catapult: 2 } },
  swordsman: { name: "Swordsman", plural: "swordsmen", cost: 30, strength: 4, tech: "iron", resource: "iron" },
  catapult: { name: "Catapult", plural: "catapults", cost: 30, strength: 1, tech: "mathematics", siege: 4 },
};
export const UNIT_IDS = Object.keys(UNITS) as UnitId[];

export const SETTLER = { cost: 30, minPop: 2 };

// ---------- Buildings and wonders ----------

export type BuildingId = "granary" | "walls" | "workshop" | "library" | "market" | "castle" | "observatory";
export const BUILDINGS: Record<BuildingId, { name: string; cost: number; tech: TechId; needs?: BuildingId; effect: string }> = {
  granary: { name: "Granary", cost: 30, tech: "pottery", effect: "+2 food, keeps half the food store when the city grows" },
  walls: { name: "Walls", cost: 30, tech: "bronze", effect: "the city defends at 1.5×" },
  workshop: { name: "Workshop", cost: 40, tech: "mining", effect: "+2 production" },
  library: { name: "Library", cost: 40, tech: "writing", effect: "+2 science and +50% science" },
  market: { name: "Market", cost: 40, tech: "currency", effect: "+2 gold and +50% gold" },
  castle: { name: "Castle", cost: 50, tech: "engineering", needs: "walls", effect: "the city defends at 2×" },
  observatory: { name: "Observatory", cost: 150, tech: "astronomy", effect: "completing it wins the game (science victory)" },
};
export const BUILDING_IDS = Object.keys(BUILDINGS) as BuildingId[];

export type WonderId = "gardens" | "pyramids" | "library" | "colossus" | "wall";
export const WONDERS: Record<WonderId, { name: string; cost: number; tech: TechId; effect: string }> = {
  gardens: { name: "Hanging Gardens", cost: 100, tech: "pottery", effect: "+2 food in every city" },
  pyramids: { name: "Pyramids", cost: 110, tech: "mining", effect: "+25% production in every city" },
  library: { name: "Great Library", cost: 110, tech: "writing", effect: "+25% science in every city" },
  colossus: { name: "Colossus", cost: 110, tech: "currency", effect: "+6 gold per turn" },
  wall: { name: "Great Wall", cost: 130, tech: "engineering", effect: "every city defends as if walled; armies defend at +25% in your territory" },
};
export const WONDER_IDS = Object.keys(WONDERS) as WonderId[];
/** Wonders cost this much less in a city with marble in its territory. */
export const MARBLE_DISCOUNT = 0.25;
export const WONDERS_TO_WIN = 3;

// ---------- Economy numbers ----------

export const FOOD_PER_POP = 2;
export const growthCost = (pop: number) => 8 + 4 * pop;
/** Population at which a city's territory grows from radius 1 to radius 2. */
export const BORDER_GROWTH_POP = 3;
export const FREE_UNITS_PER_CITY = 2;
/** Gold per missing production point when buying an item outright. */
export const BUY_GOLD_PER_PROD = 2;
export const CAPITAL_BONUS = { gold: 2, science: 2 };
export const START_UNITS: Stack = { warrior: 2 };

// ---------- Combat numbers ----------

export const FORTIFY = 1.5;
export const WALLS = 1.5;
export const CASTLE = 2;
export const GREAT_WALL_FIELD = 1.25;
export const cityBase = (pop: number) => 2 + pop;

// ---------- Calls ----------

export const ANSWER_MS = 60_000;
export const RATE_LIMIT_HOLD_MS = 180_000;
export const MAX_FALLBACK_TURNS = 3;
/** At most this many cities are asked what to build in one turn; the rest keep going with the demo bot's pick. */
export const MAX_BUILD_QUESTIONS = 4;

/** Unmeasured until live runs calibrate it: the worst case of a match's tokens and calls. */
export function estimateMatch(players: number, size: SizeId): { tokens: number; calls: number } {
  const { radius, turns } = SIZES[size];
  const hexes = 3 * radius * (radius + 1) + 1;
  // Rules, the player's empire and two one-character-per-hex maps, sent once per call.
  const perCall = (3200 + 1600 + hexes * 3) / 4;
  // Almost every turn has an army decision; players drop out as the match goes on.
  const calls = Math.round(turns * Math.max(2, players * 0.8));
  return { tokens: Math.round(calls * perCall), calls };
}
