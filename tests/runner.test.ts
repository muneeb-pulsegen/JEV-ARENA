import { describe, expect, it } from "vitest";
import { createDemoAgent } from "@/lib/agents/demo";
import { ProviderError, type Agent } from "@/lib/agents/types";
import { relaySorter } from "@/lib/games/relaySorter";
import { createRng } from "@/lib/games/rng";
import { runAll, runGame, type RunEvent } from "@/lib/runner/run";

describe("runner", () => {
  it("counts a choice outside the offered options as a miss", async () => {
    const junk: Agent = { decide: async () => ({ choice: "NOT_AN_OPTION", confidence: 0, inputTokens: 0, outputTokens: 0 }) };
    const events: RunEvent[] = [];
    const r = await runGame(relaySorter, 1, junk, (e) => events.push(e));
    expect(r.score).toBe(0);
    const t = events.find((e) => e.type === "turn") as Extract<RunEvent, { type: "turn" }>;
    expect(t.note).toMatch(/outside the options/);
  });

  it("is reproducible from the seed and stops when aborted", async () => {
    const a = await runAll(createDemoAgent({ delayMs: 0, random: createRng(1).next }), 777, () => {});
    const b = await runAll(createDemoAgent({ delayMs: 0, random: createRng(1).next }), 777, () => {});
    expect(b.scores.mechanism).toBe(a.scores.mechanism);
    expect(b.scores.planning).toBe(a.scores.planning);

    const ctrl = new AbortController();
    const p = runAll(createDemoAgent({ delayMs: 5 }), 1, (e) => e.type === "turn" && ctrl.abort(), ctrl.signal);
    await expect(p).rejects.toThrow();
  }, 60_000);

  it("plays all games at once and cancels the rest when one fails", async () => {
    const demo = createDemoAgent({ delayMs: 20 });
    const calls: Record<string, number> = {};
    const agent: Agent = {
      async decide(instructions, state, choices, opts) {
        const game = instructions.split(",")[0];
        calls[game] = (calls[game] ?? 0) + 1;
        if (instructions.includes("Tumbler Vault") && calls[game] === 3) throw new ProviderError("HTTP 401: bad key", 401, false);
        return demo.decide(instructions, state, choices, opts);
      },
    };
    const events: RunEvent[] = [];
    await expect(runAll(agent, 3, (e) => events.push(e))).rejects.toThrow(/401/);
    const starts = events.filter((e) => e.type === "game_start").length;
    expect(starts).toBe(4);
    expect(events.some((e) => e.type === "game_end")).toBe(false);
    const snapshot = JSON.stringify(calls);
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.stringify(calls)).toBe(snapshot);
  });

  it("doesn't count retry backoff against a game's clock", async () => {
    const demo = createDemoAgent({ delayMs: 0 });
    const slowRetries: Agent = {
      async decide(instructions, state, choices, opts) {
        return { ...(await demo.decide(instructions, state, choices, opts)), waitedMs: 120_000 };
      },
    };
    const r = await runGame(relaySorter, 9, slowRetries, () => {});
    expect(r.score).toBe(100);
  });
});
