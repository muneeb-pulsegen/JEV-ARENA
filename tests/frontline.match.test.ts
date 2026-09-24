import { describe, expect, it } from "vitest";
import { frontlineOrder } from "@/lib/agents/demo";
import { ProviderError, type Agent, type Choices } from "@/lib/agents/types";
import { runMatch, type Clock, type MatchEvent } from "@/lib/frontline/match";
import { replayTo } from "@/lib/frontline/replay";
import { standings } from "@/lib/frontline/rules";
import { createFakeClock } from "./fakeClock";

type Script = (call: number, choices: Choices) => string;

function fakeAgent(clock: Clock, script: Script, latency = 800, calls = { n: 0 }): Agent & { calls: { n: number } } {
  return {
    calls,
    async decide(_i, _s, choices, { signal }) {
      const call = calls.n++;
      await clock.sleep(latency, signal);
      return { choice: script(call, choices), confidence: 0.8, inputTokens: 100, outputTokens: 2 };
    },
  };
}

const smart: Script = (_c, ch) => frontlineOrder(ch);
const sloppy = (k: number): Script => (c, ch) => frontlineOrder(ch, (c + k) % 5 === 0);
const of = <T extends MatchEvent["type"]>(events: MatchEvent[], type: T) => events.filter((e): e is Extract<MatchEvent, { type: T }> => e.type === type);

describe("demo bot", () => {
  it("takes the roomiest safe capture, and reinforces when nothing is worth it", () => {
    const choices = {
      A1: "Attack neutral F4 (2 troops) from E4 with 9. Takes it with 7 left if nobody else moves. E4 keeps 1 + 3 income. Red's D4 could attack it with 12.",
      A2: "Attack neutral city E5 (4 troops, defends as 6) from E4 with 9. Takes it with 3 left if nobody else moves. E4 keeps 1 + 3 income. No rival borders it.",
      A3: "Attack Red's D4 (13 troops) from E4 with 9. Falls short: D4 holds with 4 if nobody else moves. E4 keeps 1 + 3 income. No rival borders it.",
      R1: "Reinforce E4 (10) with 6 → 16. No attack this round. Red's D4 could attack it with 12.",
    };
    expect(frontlineOrder(choices)).toBe("A2");
    expect(frontlineOrder({ A3: choices.A3, R1: choices.R1 })).toBe("R1");
  });
});

describe("frontline match", () => {
  it("asks everyone each round, reveals all orders together, and ends with exactly one winner", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    const agents = [0, 1, 2].map((k) => fakeAgent(fc.clock, sloppy(k), 700 + k * 150));
    const r = await fc.run(runMatch({ seed: 12, size: "small", agents, emit: (e) => events.push(e), clock: fc.clock }));
    expect(events[0]).toMatchObject({ type: "start", rounds: 30, players: [{ name: "Red" }, { name: "Blue" }, { name: "Green" }] });
    const reveals = of(events, "reveal");
    expect(reveals.length).toBe(r.rounds);
    for (const rv of reveals) {
      const locks = events.filter((e) => e.type === "locked" && e.round === rv.round);
      expect(locks.length).toBe(rv.orders.length);
      // Every lock comes before its round's reveal.
      expect(Math.max(...locks.map((l) => events.indexOf(l)))).toBeLessThan(events.indexOf(rv));
    }
    expect(r.standings.filter((s) => s.place === 1)).toHaveLength(1);
    expect(r.standings[0].player).toBe(r.winner);
    if (r.reason === "last") expect(r.standings.slice(1).every((s) => s.out)).toBe(true);
    expect(r.tokens.input).toBe(100 * reveals.reduce((n, rv) => n + rv.orders.length, 0));
  });

  it("plays the fallback for an answer outside the options", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    const agents = [fakeAgent(fc.clock, () => "nope"), fakeAgent(fc.clock, smart)];
    await fc.run(runMatch({ seed: 4, size: "small", agents, emit: (e) => events.push(e), clock: fc.clock }));
    const red = of(events, "reveal").map((rv) => rv.orders.find((o) => o.player === 0)!).filter(Boolean);
    expect(red.length).toBeGreaterThan(0);
    expect(red.every((o) => o.option === null && o.order.kind === "reinforce" && o.note?.includes("outside the options"))).toBe(true);
    expect(of(events, "out").some((e) => e.reason === "disconnected")).toBe(false);
  });

  it("uses the fallback for a player that takes longer than a minute, then drops it after three rounds", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    const agents = [fakeAgent(fc.clock, smart, 500), fakeAgent(fc.clock, smart, 500), fakeAgent(fc.clock, smart, 90_000)];
    await fc.run(runMatch({ seed: 5, size: "small", agents, emit: (e) => events.push(e), clock: fc.clock }));
    const reveals = of(events, "reveal");
    expect(reveals[0].t).toBe(60_000);
    expect(reveals[0].orders.find((o) => o.player === 2)).toMatchObject({ option: null, note: "no answer in time, reinforced instead" });
    expect(of(events, "out").find((e) => e.player === 2)).toMatchObject({ round: 3, reason: "disconnected" });
    expect(reveals[3].orders.map((o) => o.player)).not.toContain(2);
  });

  it("holds the round for a rate-limited player instead of dropping its order", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    let limited = 3;
    const inner = fakeAgent(fc.clock, smart, 500);
    const flaky: Agent = {
      async decide(i, s, c, o) {
        if (limited-- > 0) throw new ProviderError("HTTP 429: slow down", 429, true, 30_000);
        return inner.decide(i, s, c, o);
      },
    };
    const agents = [fakeAgent(fc.clock, smart, 500), flaky];
    await fc.run(runMatch({ seed: 6, size: "small", agents, emit: (e) => events.push(e), clock: fc.clock }));
    expect(of(events, "retry")).toHaveLength(3);
    const first = of(events, "reveal")[0];
    expect(first.t).toBeGreaterThan(60_000);
    expect(first.orders.find((o) => o.player === 1)!.option).not.toBeNull();
  });

  it("stops the whole match on an invalid key and makes no calls afterwards", async () => {
    const fc = createFakeClock();
    const calls = { n: 0 };
    let n = 0;
    const agents = [0, 1, 2].map((k) => {
      const inner = fakeAgent(fc.clock, smart, 500, calls);
      return {
        async decide(...args: Parameters<Agent["decide"]>) {
          if (k === 1 && ++n === 3) throw new ProviderError("HTTP 401: bad key", 401, false);
          return inner.decide(...args);
        },
      } satisfies Agent;
    });
    await expect(fc.run(runMatch({ seed: 9, size: "small", agents, emit: () => {}, clock: fc.clock }))).rejects.toThrow("401");
    const after = calls.n;
    await fc.run(fc.clock.sleep(300_000));
    expect(calls.n).toBe(after);
  });

  it("stops every call when the viewer leaves", async () => {
    const fc = createFakeClock();
    const ctrl = new AbortController();
    const calls = { n: 0 };
    const agents = [0, 1, 2, 3].map(() => fakeAgent(fc.clock, smart, 900, calls));
    const p = runMatch({
      seed: 2,
      size: "medium",
      agents,
      clock: fc.clock,
      signal: ctrl.signal,
      emit: (e) => e.type === "round" && e.round === 3 && ctrl.abort(new Error("viewer left")),
    });
    await expect(fc.run(p)).rejects.toThrow("viewer left");
    const after = calls.n;
    await fc.run(fc.clock.sleep(300_000));
    expect(calls.n).toBe(after);
  });

  it("replays the saved log to the exact final state and standings", async () => {
    for (const [seed, players, size] of [[21, 2, "small"], [22, 4, "medium"], [23, 6, "large"]] as const) {
      const fc = createFakeClock();
      const agents = Array.from({ length: players }, (_, k) => fakeAgent(fc.clock, sloppy(k), 600 + k * 50));
      const r = await fc.run(runMatch({ seed, size, agents, emit: () => {}, clock: fc.clock }));
      const log = JSON.parse(JSON.stringify(r.log)) as MatchEvent[];
      const { state } = replayTo(log);
      const lastRound = of(log, "round").at(-1)!;
      expect(state.owner).toEqual(lastRound.owner);
      expect(state.troops).toEqual(lastRound.troops);
      expect(standings(state, r.winner)).toEqual(r.standings);
      const mid = replayTo(log, 3).state;
      expect(mid.round).toBe(3);
    }
  });
});
