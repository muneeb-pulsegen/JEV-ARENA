import { describe, expect, it } from "vitest";
import { arenaMove, createDemoAgent } from "@/lib/agents/demo";
import { ProviderError, type Agent, type Choices } from "@/lib/agents/types";
import { DIRS, renderMap, standings } from "@/lib/arena/board";
import { runMatch, type Clock, type MatchEvent } from "@/lib/arena/match";
import { replayTo } from "@/lib/arena/replay";
import { createFakeClock } from "./fakeClock";

type Script = (call: number, choices: Choices, state: string) => string;

/** An agent that answers after `latency` virtual ms, honouring its abort signal. */
function fakeAgent(clock: Clock, script: Script, latency = 500, calls: { n: number } = { n: 0 }): Agent & { calls: { n: number } } {
  return {
    calls,
    async decide(_i, state, choices, { signal }) {
      const call = calls.n++;
      await clock.sleep(typeof latency === "number" ? latency : 500, signal);
      return { choice: script(call, choices, state), confidence: 0.9, inputTokens: 10, outputTokens: 1 };
    },
  };
}

const smart: Script = (_c, choices) => arenaMove(choices);
const straight: Script = () => "nope";

describe("arena demo bot", () => {
  it("takes the safe option with the most room, and only goes into a wall when every option is fatal", () => {
    const choices = {
      U: "Move up to row 2 col 8. FATAL: Blue's trail is there.",
      D: "Move down to row 4 col 8. Open. Room after this move: 12 cells, sealed off, only you.",
      L: "Move left to row 3 col 7. Open. Room after this move: 212 cells, shared with Blue.",
      R: "Move right to row 3 col 9. Open. Room after this move: 212 cells, shared with Blue.",
    };
    expect(arenaMove(choices)).toBe("L");
    expect(arenaMove(choices, true)).toBe("R");
    const doomed = Object.fromEntries(DIRS.map((d) => [d, `Move. FATAL: a wall is there.`]));
    expect(arenaMove(doomed)).toBe("U");
  });

  it("is what the general demo agent plays in the arena", async () => {
    const demo = createDemoAgent({ delayMs: 0 });
    const choices = { U: "x FATAL: y", D: "Open. Room after this move: 3 cells", L: "Open. Room after this move: 9 cells", R: "FATAL" };
    expect((await demo.decide("You are playing Live Arena", "", choices, {})).choice).toBe("L");
  });
});

describe("live match", () => {
  it("ends the moment one seat is left, with exactly one winner", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    const agents = [fakeAgent(fc.clock, smart, 400), fakeAgent(fc.clock, straight, 400), fakeAgent(fc.clock, smart, 700)];
    const r = await fc.run(runMatch({ seed: 5, size: "small", agents, emit: (e) => events.push(e), clock: fc.clock }));
    expect(r.reason).toBe("last");
    const alive = r.standings.filter((s) => !s.out);
    expect(alive).toHaveLength(1);
    expect(alive[0].seat).toBe(r.winner);
    expect(r.standings[0].seat).toBe(r.winner);
    expect(events.at(-1)).toMatchObject({ type: "end", winner: r.winner });
    const lastCrash = events.filter((e) => e.type === "crash").at(-1)!;
    expect(r.durationMs).toBe(lastCrash.t);
    expect(r.tokens.input).toBe(10 * events.filter((e) => e.type === "move").length);
    expect(r.tokens.output).toBe(r.tokens.input / 10);
  });

  it("goes straight on an answer outside the options, and crashes if straight is fatal", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    const agents = [fakeAgent(fc.clock, straight, 300), fakeAgent(fc.clock, smart, 300)];
    const r = await fc.run(runMatch({ seed: 11, size: "small", agents, emit: (e) => events.push(e), clock: fc.clock }));
    const start = events[0] as Extract<MatchEvent, { type: "start" }>;
    const redMoves = events.filter((e): e is Extract<MatchEvent, { type: "move" }> => e.type === "move" && e.seat === 0);
    expect(redMoves.length).toBeGreaterThan(0);
    expect(redMoves.every((m) => m.dir === start.seats[0].dir && m.note?.includes("outside the options"))).toBe(true);
    expect(events.find((e) => e.type === "crash" && e.seat === 0)).toMatchObject({ reason: expect.stringMatching(/^crashed into/) });
    expect(r.winner).toBe(1);
  });

  it("ends at the time limit with the most cells winning, ties going to whoever got there first", async () => {
    const fc = createFakeClock();
    // Both seats play the same strategy at the same speed, so they tie on cells; Blue answers 1 ms later every time.
    const agents = [fakeAgent(fc.clock, smart, 400), fakeAgent(fc.clock, smart, 401)];
    const r = await fc.run(runMatch({ seed: 3, size: "huge", agents, emit: () => {}, clock: fc.clock, timeLimitMs: 20_000 }));
    expect(r.reason).toBe("time");
    expect(r.durationMs).toBe(20_000);
    const [first, second] = r.standings;
    expect(first.cells).toBe(second.cells);
    expect(first.seat).toBe(0);
    expect(r.winner).toBe(0);
  });

  it("never moves a seat faster than the pace", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    const agents = [fakeAgent(fc.clock, smart, 10), fakeAgent(fc.clock, smart, 10)];
    await fc.run(runMatch({ seed: 8, size: "medium", agents, emit: (e) => events.push(e), clock: fc.clock, timeLimitMs: 10_000 }));
    for (const seat of [0, 1]) {
      const times = events.filter((e) => e.type === "move" && e.seat === seat).map((e) => (e as { t: number }).t);
      expect(times.length).toBeGreaterThan(10);
      for (let k = 1; k < times.length; k++) expect(times[k] - times[k - 1]).toBeGreaterThanOrEqual(300);
    }
  });

  it("stops every call when aborted and makes none afterwards", async () => {
    const fc = createFakeClock();
    const ctrl = new AbortController();
    const calls = { n: 0 };
    const agents = [0, 1, 2, 3].map(() => fakeAgent(fc.clock, smart, 500, calls));
    let moves = 0;
    const p = runMatch({
      seed: 2,
      size: "medium",
      agents,
      clock: fc.clock,
      signal: ctrl.signal,
      emit: (e) => e.type === "move" && ++moves === 12 && ctrl.abort(new Error("viewer left")),
    });
    await expect(fc.run(p)).rejects.toThrow("viewer left");
    const after = calls.n;
    await fc.run(fc.clock.sleep(60_000));
    expect(calls.n).toBe(after);
  });

  it("discards an answer that arrives after its seat is out or the match is over", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    // Blue thinks for a very long time; Red drives straight into a wall, so the match ends while Blue is still waiting.
    const agents = [fakeAgent(fc.clock, straight, 100), fakeAgent(fc.clock, smart, 90_000)];
    const straightIntoWall = runMatch({ seed: 11, size: "small", agents, emit: (e) => events.push(e), clock: fc.clock, paceMs: 0 });
    const r = await fc.run(straightIntoWall);
    expect(r.winner).toBe(1);
    expect(events.filter((e) => e.type === "move" && e.seat === 1)).toHaveLength(0);
    expect(events.at(-1)?.type).toBe("end");
  });
});

describe("match errors", () => {
  it("pauses a rate-limited seat without eliminating it while the others play on", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    let limited = 2;
    const blue = fakeAgent(fc.clock, smart, 400);
    const flaky: Agent = {
      async decide(i, s, c, o) {
        if (limited-- > 0) throw new ProviderError("HTTP 429: slow down", 429, true, 5000);
        return blue.decide(i, s, c, o);
      },
    };
    const agents = [fakeAgent(fc.clock, smart, 400), flaky];
    await fc.run(runMatch({ seed: 4, size: "medium", agents, emit: (e) => events.push(e), clock: fc.clock, timeLimitMs: 30_000 }));
    const retries = events.filter((e) => e.type === "retry");
    expect(retries).toHaveLength(2);
    expect(retries.every((e) => e.type === "retry" && e.seat === 1)).toBe(true);
    const firstBlue = events.find((e) => e.type === "move" && e.seat === 1) as { t: number };
    const redBefore = events.filter((e) => e.type === "move" && e.seat === 0 && e.t < firstBlue.t);
    expect(firstBlue.t).toBeGreaterThan(10_000);
    expect(redBefore.length).toBeGreaterThan(10);
    expect(events.find((e) => e.type === "crash" && e.seat === 1 && e.reason === "disconnected")).toBeUndefined();
  });

  it("knocks a seat out as disconnected after 3 failed retries", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    let calls = 0;
    const broken: Agent = {
      async decide() {
        calls++;
        throw new ProviderError("HTTP 503: down", 503, true);
      },
    };
    const agents = [fakeAgent(fc.clock, smart, 400), broken, fakeAgent(fc.clock, smart, 400)];
    await fc.run(runMatch({ seed: 6, size: "medium", agents, emit: (e) => events.push(e), clock: fc.clock, timeLimitMs: 60_000 }));
    expect(calls).toBe(4);
    expect(events.find((e) => e.type === "crash" && e.seat === 1)).toMatchObject({ reason: "disconnected" });
  });

  it("stops the whole match on an invalid key", async () => {
    const fc = createFakeClock();
    const calls = { n: 0 };
    let n = 0;
    const agents = [0, 1, 2].map((k) => {
      const inner = fakeAgent(fc.clock, smart, 400, calls);
      return {
        async decide(...args: Parameters<Agent["decide"]>) {
          if (k === 2 && ++n === 5) throw new ProviderError("HTTP 401: bad key", 401, false);
          return inner.decide(...args);
        },
      } satisfies Agent;
    });
    await expect(fc.run(runMatch({ seed: 9, size: "medium", agents, emit: () => {}, clock: fc.clock }))).rejects.toThrow("401");
    const after = calls.n;
    await fc.run(fc.clock.sleep(60_000));
    expect(calls.n).toBe(after);
  });
});

describe("replay", () => {
  it("rebuilds the exact final board and standings from the saved log", async () => {
    for (const [seed, seats] of [[21, 2], [22, 4], [23, 6]] as const) {
      const fc = createFakeClock();
      const agents = Array.from({ length: seats }, (_, k) => fakeAgent(fc.clock, (c, ch) => arenaMove(ch, (c + k) % 9 === 0), 300 + k * 37));
      const r = await fc.run(runMatch({ seed, size: seats > 4 ? "large" : "medium", agents, emit: () => {}, clock: fc.clock }));
      const log = JSON.parse(JSON.stringify(r.log)) as MatchEvent[];
      const board = replayTo(log);
      expect(standings(board, r.winner)).toEqual(r.standings);
      const live = replayTo(r.log);
      expect(renderMap(board)).toBe(renderMap(live));
      const mid = replayTo(log, r.durationMs / 2);
      expect(mid.seats.reduce((n, s) => n + s.moves, 0)).toBeLessThan(board.seats.reduce((n, s) => n + s.moves, 0));
    }
  });
});
