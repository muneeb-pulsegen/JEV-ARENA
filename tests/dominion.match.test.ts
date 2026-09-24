import { beforeAll, describe, expect, it } from "vitest";
import { jevAgent } from "@/lib/agents/providers";
import { ProviderError, type Agent, type ManyDecision, type QuestionSpec } from "@/lib/agents/types";
import { runMatch, type Clock, type MatchEvent, type Standing } from "@/lib/dominion/match";
import { replayTo } from "@/lib/dominion/replay";
import { handleMatchRequest } from "@/lib/dominion/serve";
import { getMatch, listMatches } from "@/lib/db";
import { createFakeClock } from "./fakeClock";
import { startFakeProvider } from "./fakeProvider";

beforeAll(() => {
  process.env.ARENA_DB_PATH = ":memory:";
});

const auto = (slip = 0.08) => ({ auto: { delayMs: 0, slip } });
const of = <T extends MatchEvent["type"]>(events: MatchEvent[], type: T) => events.filter((e): e is Extract<MatchEvent, { type: T }> => e.type === type);

/** A multi-question agent: answers every question with `pick`, after `latency` virtual ms. */
function manyAgent(clock: Clock, pick: (key: string, q: QuestionSpec) => string, latency = 500, calls = { n: 0, questions: 0 }): Agent & { calls: typeof calls } {
  return {
    calls,
    decide: async () => {
      throw new Error("single-question calls are not expected");
    },
    async decideMany(_state, questions, { signal }): Promise<ManyDecision> {
      calls.n++;
      calls.questions += Object.keys(questions).length;
      await clock.sleep(latency, signal);
      const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { choice: pick(k, q), confidence: 0.7 }]));
      return { answers, inputTokens: 1000, outputTokens: 10 };
    },
  };
}
const first = (_k: string, q: QuestionSpec) => Object.keys(q.choices)[0];

describe("dominion match", () => {
  it("plays to a victory with one call per player per turn that carries all its questions", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    const agent = manyAgent(fc.clock, first);
    const r = await fc.run(runMatch({ seed: 4, size: "small", seats: [agent, auto()], emit: (e) => events.push(e), clock: fc.clock }));
    expect(["domination", "science", "wonders", "score"]).toContain(r.victory);
    expect(r.standings[0]).toMatchObject({ player: r.winner, place: 1 });
    const asked = of(events, "orders").flatMap((e) => e.decisions.filter((d) => d.player === 0));
    const turnsAsked = new Set(of(events, "orders").filter((e) => e.decisions.some((d) => d.player === 0)).map((e) => e.turn)).size;
    expect(agent.calls.n).toBe(turnsAsked);
    expect(agent.calls.questions).toBe(asked.length);
    expect(asked.every((d) => d.option === d.choice && !d.note)).toBe(true);
    expect(r.tokens.input).toBe(1000 * agent.calls.n);
  }, 60_000);

  it("uses the recommended option for an answer outside the options", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    await fc.run(runMatch({ seed: 5, size: "small", seats: [manyAgent(fc.clock, () => "nonsense"), auto()], emit: (e) => events.push(e), clock: fc.clock }));
    const red = of(events, "orders").flatMap((e) => e.decisions.filter((d) => d.player === 0));
    expect(red.length).toBeGreaterThan(0);
    expect(red.every((d) => d.choice === "nonsense" && d.note === "answer outside the options, used the default")).toBe(true);
    expect(of(events, "out").some((e) => e.reason === "disconnected")).toBe(false);
  }, 60_000);

  it("falls back after a minute without an answer, and drops a player after three such turns", async () => {
    const fc = createFakeClock();
    const events: MatchEvent[] = [];
    await fc.run(runMatch({ seed: 6, size: "small", seats: [auto(), auto(), manyAgent(fc.clock, first, 90_000)], emit: (e) => events.push(e), clock: fc.clock }));
    const firstOrders = of(events, "orders")[0];
    expect(firstOrders.t).toBe(60_000);
    expect(firstOrders.decisions.filter((d) => d.player === 2).every((d) => d.note === "no answer in time, used the default")).toBe(true);
    expect(of(events, "out").find((e) => e.player === 2)).toMatchObject({ turn: 3, reason: "disconnected" });
    const after = of(events, "turn").find((e) => e.turn === 3)!;
    expect(after.snapshot.cities.some((c) => c.owner === 2)).toBe(false);
  }, 60_000);

  it("stops everything on an invalid key", async () => {
    const fc = createFakeClock();
    const calls = { n: 0, questions: 0 };
    let n = 0;
    const good = manyAgent(fc.clock, first, 500, calls);
    const bad: Agent = {
      decide: good.decide,
      decideMany: async (...args) => {
        if (++n === 3) throw new ProviderError("HTTP 401: bad key", 401, false);
        return good.decideMany!(...args);
      },
    };
    await expect(fc.run(runMatch({ seed: 7, size: "small", seats: [good, bad], emit: () => {}, clock: fc.clock }))).rejects.toThrow("401");
    const after = calls.n;
    await fc.run(fc.clock.sleep(300_000));
    expect(calls.n).toBe(after);
  });

  it("replays the log to the same state, turn by turn", async () => {
    for (const [seed, players, size] of [[11, 2, "small"], [12, 4, "medium"]] as const) {
      const events: MatchEvent[] = [];
      const r = await runMatch({ seed, size, seats: Array.from({ length: players }, () => auto(0.1)), emit: (e) => events.push(e) });
      const log = JSON.parse(JSON.stringify(r.log)) as MatchEvent[];
      const last = of(log, "turn").at(-1)!;
      expect(replayTo(log).state).toEqual(last.snapshot);
      const t10 = of(log, "turn").find((e) => e.turn === 10)!;
      expect(replayTo(log, 10).state).toEqual(t10.snapshot);
    }
  }, 120_000);
});

describe("POST /api/dominion", () => {
  const post = (body: unknown, signal?: AbortSignal) =>
    new Request("http://arena.test/api/dominion", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal });

  async function readEvents(res: Response): Promise<MatchEvent[]> {
    const out: MatchEvent[] = [];
    const text = await res.text();
    for (const chunk of text.split("\n\n")) if (chunk.startsWith("data: ")) out.push(JSON.parse(chunk.slice(6)));
    return out;
  }

  it("rejects a bad setup and streams and saves a full demo match", async () => {
    for (const body of [{ provider: "x", seats: 2 }, { provider: "demo", seats: 7 }, { provider: "demo", seats: 2, size: "huge" }]) {
      expect((await handleMatchRequest(post(body), { demoDelayMs: 0 })).status).toBe(400);
    }
    const res = await handleMatchRequest(post({ provider: "demo", seats: 3 }), { demoDelayMs: 0 });
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ type: "start", size: "small", turns: 60 });
    const end = of(events, "end")[0];
    const saved = of(events, "saved")[0];
    const match = getMatch<Standing, MatchEvent>(saved.id)!;
    expect(match).toMatchObject({ game: "dominion", provider: "demo", seats: 3, winner: end.winner, endReason: end.victory, rounds: end.turns });
    expect(match.results).toEqual(end.standings);
    expect(listMatches("dominion").map((m) => m.id)).toContain(saved.id);
    expect(listMatches("frontline").map((m) => m.id)).not.toContain(saved.id);
  }, 60_000);

  it("sends each player's questions to TypeSafe in one request", async () => {
    const fake = await startFakeProvider();
    try {
      const url = `http://127.0.0.1:${fake.port}/v1/systemone`;
      const events: MatchEvent[] = [];
      const r = await runMatch({ seed: 21, size: "small", seats: [jevAgent("apikey_test_dominion_123456", url), auto()], emit: (e) => events.push(e) });
      const turnsAsked = of(events, "orders").filter((e) => e.decisions.some((d) => d.player === 0));
      expect(fake.requests).toHaveLength(turnsAsked.length);
      const firstBody = fake.requests[0].body;
      expect(Object.keys(firstBody.questions).sort()).toEqual(expect.arrayContaining(["army", "research"]));
      expect(Object.values(firstBody.questions).every((q: any) => q.type === "choice" && Object.keys(q.criteria).length > 0)).toBe(true);
      expect(firstBody.state).toContain("You are playing Dominion");
      expect(r.tokens.input).toBe(11 * fake.requests.length);
    } finally {
      await fake.close();
    }
  }, 60_000);
});
