/** Live Arena settings shared by the server and the browser. No Node imports. */

export type SizeId = "small" | "medium" | "large" | "huge";

export const SIZES: Record<SizeId, { grid: number; timeLimitMs: number; label: string }> = {
  small: { grid: 16, timeLimitMs: 3 * 60_000, label: "Small" },
  medium: { grid: 24, timeLimitMs: 5 * 60_000, label: "Medium" },
  large: { grid: 32, timeLimitMs: 8 * 60_000, label: "Large" },
  huge: { grid: 48, timeLimitMs: 12 * 60_000, label: "Huge" },
};

export const SIZE_IDS = Object.keys(SIZES) as SizeId[];

export const SEATS = [
  { id: "R", name: "Red" },
  { id: "B", name: "Blue" },
  { id: "G", name: "Green" },
  { id: "Y", name: "Gold" },
  { id: "V", name: "Violet" },
  { id: "T", name: "Teal" },
] as const;

export const MIN_SEATS = 2;
export const MAX_SEATS = SEATS.length;

/** At most one move per seat this often. */
export const PACE_MS = 300;

export function defaultSize(seats: number): SizeId {
  return seats <= 2 ? "small" : seats <= 4 ? "medium" : "large";
}

/** Characters of fixed text per call: the instructions, the state's prose lines, and the four options. */
const FIXED_CHARS = 1600 + 400 + 520;
/** A seat rarely fills more than this share of its part of the board before the match ends. */
const FILL = 0.55;
/** A JEV answer takes roughly this long, which caps moves on big boards. */
const CALL_MS = 1200;

/** Unmeasured until live runs calibrate it: the worst case of a match's tokens and length. */
export function estimateMatch(seats: number, size: SizeId): { tokens: number; minutes: number } {
  const { grid, timeLimitMs } = SIZES[size];
  const open = (grid - 2) ** 2 * 0.96;
  const moves = Math.min((open * FILL) / seats, timeLimitMs / CALL_MS);
  const perCall = (FIXED_CHARS + grid * (grid + 1)) / 4;
  return { tokens: Math.round(seats * moves * perCall), minutes: timeLimitMs / 60_000 };
}
