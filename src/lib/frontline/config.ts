/** Frontline settings shared by the server and the browser. No Node imports. */

export type SizeId = "small" | "medium" | "large";

export const SIZES: Record<SizeId, { radius: number; cities: number; rounds: number; label: string }> = {
  small: { radius: 3, cities: 3, rounds: 30, label: "Small" },
  medium: { radius: 4, cities: 5, rounds: 40, label: "Medium" },
  large: { radius: 5, cities: 7, rounds: 50, label: "Large" },
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

export const START_TROOPS = 6;
export const NEUTRAL_TROOPS = 2;
export const CITY_TROOPS = 4;
/** Reinforcing places this multiple of the round's income, rounded down. */
export const REINFORCE = 2;
/** Cities and capitals defend at this multiple. */
export const CITY_DEFENCE = 1.5;

/** A player gets this long to answer each round before its fallback order is used. */
export const ANSWER_MS = 60_000;
/** A rate-limited player can hold the round up to this long. */
export const RATE_LIMIT_HOLD_MS = 180_000;
/** Consecutive rounds on the fallback (errors or timeouts) before a player is out as disconnected. */
export const MAX_FALLBACK_ROUNDS = 3;

export function defaultSize(players: number): SizeId {
  return players <= 3 ? "small" : players <= 5 ? "medium" : "large";
}

export const hexCount = (radius: number) => 3 * radius * (radius + 1) + 1;

/**
 * Unmeasured until live runs calibrate it: the worst case of a match's tokens.
 * Instructions and options are fixed text; the map is one short line per region.
 */
export function estimateMatch(players: number, size: SizeId): { tokens: number; calls: number } {
  const { radius, rounds } = SIZES[size];
  const regions = hexCount(radius) * 0.9;
  const perCall = (1600 + 8 * 180 + regions * 40 + 300) / 4;
  // Players drop out as the match goes on; on average about two thirds are still playing.
  const calls = Math.round(rounds * Math.max(2, players * 0.66));
  return { tokens: Math.round(calls * perCall), calls };
}
