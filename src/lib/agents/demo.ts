import { gateFor, tierOf } from "../games/relaySorter";
import { solve as solveTumbler } from "../games/tumblerVault";
import { labelBoxes, pushId, solvePushes, type Level as CrateLevel } from "../games/crateRunner";
import type { Dir as SignalDir } from "../games/signalRun";
import type { Agent, Choices } from "./types";

function cratePush(state: string, choices: Choices): string {
  const rows = state.split("\n").filter((l) => l.length >= 5 && /^[#\-.$*@+]+$/.test(l));
  const level: CrateLevel = { size: rows.length, walls: [], targets: [], boxes: [], player: 0 };
  rows.join("").split("").forEach((ch, i) => {
    level.walls.push(ch === "#");
    if (ch === "." || ch === "*" || ch === "+") level.targets.push(i);
    if (ch === "$" || ch === "*") level.boxes.push(i);
    if (ch === "@" || ch === "+") level.player = i;
  });
  const first = solvePushes(level, { boxes: level.boxes, player: level.player }, 2_000_000)?.[0];
  const label = first && labelBoxes(level.boxes).find((b) => b.cell === first.box)?.label;
  return first && label ? pushId(label, first.dir) : Object.keys(choices)[0] ?? "";
}

function signalMove(state: string): string {
  const rows = state.split("\n").filter((l) => l.length >= 4 && /^[#\-XG@]+$/.test(l));
  const size = rows.length;
  const walls: boolean[] = [];
  const holes: boolean[] = [];
  let player = 0, goal = 0;
  rows.join("").split("").forEach((ch, i) => {
    walls.push(ch === "#");
    holes.push(ch === "X");
    if (ch === "@") player = i;
    if (ch === "G") goal = i;
  });

  const DIRS: SignalDir[] = ["U", "D", "L", "R"];
  const delta = (d: SignalDir) => (d === "U" ? -size : d === "D" ? size : d === "L" ? -1 : 1);
  const prev = new Map<number, SignalDir>();
  const seen = new Set([player]);
  let frontier = [player];
  while (frontier.length && !frontier.includes(goal)) {
    const next: number[] = [];
    for (const p of frontier) {
      for (const d of DIRS) {
        const n = p + delta(d);
        if (walls[n] || holes[n] || seen.has(n)) continue;
        seen.add(n);
        prev.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  if (!seen.has(goal)) return "U";
  const path: SignalDir[] = [];
  let node = goal;
  while (node !== player) {
    const d = prev.get(node)!;
    path.push(d);
    node -= delta(d);
  }
  return path.reverse()[0] ?? "U";
}

function tumblerPress(state: string, choices: Choices): string {
  const dials = (state.match(/^Current dials.*: (.+)$/m)?.[1] ?? "").trim().split(/\s+/).map(Number);
  const modulus = Number(state.match(/dials mod (\d+)/)?.[1] ?? 0);
  const levers = [...state.matchAll(/^([A-H]): (.+)$/gm)].map(([, id, effects]) => {
    const deltas = Array(dials.length).fill(0);
    for (const m of effects.matchAll(/dial (\d+) \+(\d+)/g)) deltas[Number(m[1]) - 1] = Number(m[2]);
    return { id, deltas };
  });
  const plan = solveTumbler(dials, levers, modulus, 2_000_000);
  return plan?.[0] ?? Object.keys(choices)[0] ?? "A";
}

function sorterGate(state: string): string {
  const round = Number(state.match(/Round (\d+) of/)?.[1] ?? 1);
  const tier = tierOf(round);
  const rotation = Number(state.match(/Rotation offset: (\d+)/)?.[1] ?? 0);
  const itemLine = state.match(/^Item: (.+)$/m)?.[1] ?? "";
  const [color, size] = itemLine.split(" ");
  return gateFor({ color, size: size ?? null }, tier, rotation);
}

/**
 * A scripted player for free demo runs. With `sloppy`, it slips now and then
 * so demos show failures too.
 */
export function createDemoAgent(opts: { delayMs?: number; sloppy?: boolean; random?: () => number } = {}): Agent {
  const { delayMs = 450, sloppy = false, random = Math.random } = opts;
  return {
    async decide(instructions, state, choices, { signal }) {
      await new Promise((r) => setTimeout(r, delayMs));
      signal?.throwIfAborted();
      let choice: string;
      if (instructions.includes("Crate Runner")) choice = cratePush(state, choices);
      else if (instructions.includes("Signal Run")) choice = signalMove(state);
      else if (instructions.includes("Tumbler Vault")) choice = tumblerPress(state, choices);
      else if (instructions.includes("Relay Sorter")) {
        const gate = sorterGate(state);
        choice = sloppy && random() < 0.04 ? "XYZ".replace(gate, "")[0] : gate;
      } else choice = Object.keys(choices)[0] ?? "";
      return { choice, confidence: 1, inputTokens: 0, outputTokens: 0 };
    },
  };
}
