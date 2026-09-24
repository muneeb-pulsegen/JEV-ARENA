import { createRng, type Rng } from "./rng";
import type { GameDef, GameSession } from "./types";
import type { Gate, LadderStep, SorterItem, SorterRule, SorterView } from "./views";
import type { Choices } from "../agents/types";

export const SORTER_ROUNDS_PER_TIER = 12;
export const SORTER_TIERS = 5;
export const SORTER_MAX_ROUNDS = SORTER_ROUNDS_PER_TIER * SORTER_TIERS;
export const SORTER_BUDGET_MS = 60_000;
export const SORTER_TARGET_POINTS = 150;

export const GATES: Gate[] = ["X", "Y", "Z"];
const rotate = (g: Gate, by: number): Gate => GATES[(GATES.indexOf(g) + by) % GATES.length];

export const tierOf = (round: number) => Math.min(SORTER_TIERS, Math.ceil(round / SORTER_ROUNDS_PER_TIER));

/** The fixed rule table for a tier. Tiers only add complexity; nothing is ever hidden. */
export function rulesFor(tier: number): SorterRule[] {
  if (tier === 1) {
    return [
      { color: "RED", size: null, gate: "X" },
      { color: "BLUE", size: null, gate: "Y" },
      { color: "GREEN", size: null, gate: "Z" },
    ];
  }
  if (tier === 2) {
    return [
      { color: "RED", size: null, gate: "X" },
      { color: "GOLD", size: null, gate: "X" },
      { color: "BLUE", size: null, gate: "Y" },
      { color: "GREEN", size: null, gate: "Z" },
    ];
  }
  const base: SorterRule[] = [
    { color: "RED", size: "BIG", gate: "X" }, { color: "RED", size: "SMALL", gate: "Y" },
    { color: "BLUE", size: "BIG", gate: "Y" }, { color: "BLUE", size: "SMALL", gate: "Z" },
    { color: "GREEN", size: "BIG", gate: "Z" }, { color: "GREEN", size: "SMALL", gate: "X" },
    { color: "GOLD", size: "BIG", gate: "X" }, { color: "GOLD", size: "SMALL", gate: "Y" },
  ];
  if (tier === 3) return base;
  const withException = base.map((r) => (r.color === "GOLD" && r.size === "BIG" ? { ...r, gate: "Z" as Gate, exception: true } : r));
  return withException;
}

export function gateFor(item: SorterItem, tier: number, rotation: number): Gate {
  const rules = rulesFor(tier);
  const rule = rules.find((r) => r.color === item.color && r.size === item.size)!;
  return tier >= 5 ? rotate(rule.gate, rotation) : rule.gate;
}

function makeItem(rng: Rng, tier: number): SorterItem {
  if (tier <= 2) return { color: rng.pick(tier === 1 ? ["RED", "BLUE", "GREEN"] : ["RED", "BLUE", "GREEN", "GOLD"]), size: null };
  return { color: rng.pick(["RED", "BLUE", "GREEN", "GOLD"]), size: rng.pick(["BIG", "SMALL"]) };
}

const GATE_CHOICES: Choices = { X: "Route to gate X.", Y: "Route to gate Y.", Z: "Route to gate Z." };

class RelaySorterSession implements GameSession<Gate> {
  private rng: Rng;
  private round = 0;
  private correct = 0;
  private wrong = 0;
  private points = 0;
  private timeLeftMs: number;
  private item: SorterItem;
  private rotation = 0;
  private last: SorterView["last"] = null;
  private history: { correct: boolean; tier: number }[] = [];
  private failedTier: number | null = null;

  constructor(seed: number, budgetMs = SORTER_BUDGET_MS) {
    this.rng = createRng(seed);
    this.timeLeftMs = budgetMs;
    this.round = 1;
    this.item = makeItem(this.rng, tierOf(1));
  }

  state() {
    const tier = tierOf(this.round);
    const rules = rulesFor(tier);
    const table =
      tier <= 2
        ? rules.map((r) => `${r.color} → ${r.gate}`).join(", ")
        : rules.map((r) => `${r.color} ${r.size} → ${r.gate}${r.exception ? " (exception)" : ""}`).join(", ");
    const item = tier <= 2 ? this.item.color : `${this.item.color} ${this.item.size}`;
    return [
      `Round ${this.round} of ${SORTER_MAX_ROUNDS} · tier ${tier} (worth ${tier}) · ${(this.timeLeftMs / 1000).toFixed(1)}s left · ${this.points} pts.`,
      `Rules: ${table}.`,
      tier >= 5 ? `Rotation offset: ${this.rotation} (shift every rule's gate forward by this many steps, X→Y→Z→X).` : "",
      `Item: ${item}`,
      `Which gate does it go to?`,
    ].filter(Boolean).join("\n");
  }

  options(): Choices {
    return GATE_CHOICES;
  }

  step(action: Gate | null, elapsedMs: number) {
    this.timeLeftMs -= elapsedMs;
    if (this.timeLeftMs <= 0) {
      this.failedTier = tierOf(this.round);
      return;
    }
    const tier = tierOf(this.round);
    const expected = gateFor(this.item, tier, this.rotation);
    const correct = action === expected;
    this.last = { item: this.item, answer: action, expected, correct, tier };
    this.history.push({ correct, tier });
    if (correct) {
      this.correct++;
      this.points += tier;
    } else {
      this.wrong++;
      this.points -= tier / 2;
    }
    if (this.round >= SORTER_MAX_ROUNDS) return;
    this.round++;
    const nextTier = tierOf(this.round);
    this.rotation = nextTier >= 5 ? this.rng.int(0, 2) : 0;
    this.item = makeItem(this.rng, nextTier);
  }

  done() {
    return this.timeLeftMs <= 0 || (this.round >= SORTER_MAX_ROUNDS && this.history.length >= SORTER_MAX_ROUNDS);
  }

  score() {
    return Math.max(0, Math.min(100, Math.round((this.points / SORTER_TARGET_POINTS) * 100)));
  }

  view(): SorterView {
    const tier = tierOf(this.round);
    const ladder: LadderStep[] = Array.from({ length: SORTER_TIERS }, (_, i) => {
      const t = i + 1;
      if (this.failedTier !== null) return t < this.failedTier ? "passed" : t === this.failedTier ? "failed" : "locked";
      if (t < tier || this.done()) return "passed";
      return t === tier ? "active" : "locked";
    });
    return {
      kind: "dispatch",
      ladder,
      tier,
      round: this.round,
      maxRounds: SORTER_MAX_ROUNDS,
      rules: rulesFor(tier),
      rotation: this.rotation,
      item: this.done() ? null : this.item,
      last: this.last,
      history: this.history,
      correct: this.correct,
      wrong: this.wrong,
      points: Math.round(this.points * 10) / 10,
      timeLeftMs: Math.max(0, this.timeLeftMs),
      budgetMs: SORTER_BUDGET_MS,
    };
  }

  progress() {
    return `round ${this.round}/${SORTER_MAX_ROUNDS} · ${this.correct} correct, ${this.wrong} wrong · ${this.points.toFixed(1)} pts · ${(Math.max(0, this.timeLeftMs) / 1000).toFixed(1)}s left`;
  }
}

export const relaySorter: GameDef<Gate> = {
  id: "dispatch",
  name: "Relay Sorter",
  axis: "Dispatch",
  blurb: `${SORTER_MAX_ROUNDS} rounds against a 60s clock: route each item to the gate its rule table names. Rules grow from a single lookup to a compound table with an exception and a rotating offset.`,
  instructions:
    "You are playing Relay Sorter, a timed dispatch game. Every round shows you a complete, explicit rule table (never hidden or guessed) " +
    "mapping item attributes to one of three gates (X, Y, Z), and an item to route. Apply the rule exactly. Later rounds add a second " +
    "attribute, an explicit exception row, and a stated rotation offset that shifts every gate forward (X→Y→Z→X) by that many steps. " +
    "You have a shared time budget for all rounds; work quickly and accurately. Choose exactly one gate for this item.",
  estTokens: SORTER_MAX_ROUNDS * 400,
  create: (seed) => new RelaySorterSession(seed),
};

export function createRelaySorter(seed: number, budgetMs?: number) {
  return new RelaySorterSession(seed, budgetMs);
}
