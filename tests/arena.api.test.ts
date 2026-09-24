import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDemoAgent } from "@/lib/agents/demo";
import { jevAgent } from "@/lib/agents/providers";
import type { Agent } from "@/lib/agents/types";
import { standings } from "@/lib/arena/board";
import { runMatch, type MatchEvent } from "@/lib/arena/match";
import { replayTo } from "@/lib/arena/replay";
import { handleMatchRequest } from "@/lib/arena/serve";
import { getMatch, listMatches } from "@/lib/db";
import { startFakeProvider } from "./fakeProvider";

beforeAll(() => {
  process.env.ARENA_DB_PATH = ":memory:";
});

const fast = { makeAgent: () => createDemoAgent({ delayMs: 0 }), paceMs: 0 };

const post = (body: unknown, signal?: AbortSignal) =>
  new Request("http://arena.test/api/match", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal });

async function readEvents(res: Response, onEvent?: (e: MatchEvent) => void): Promise<MatchEvent[]> {
  const events: MatchEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!chunk.startsWith("data: ")) continue;
      const e = JSON.parse(chunk.slice(6)) as MatchEvent;
      events.push(e);
      onEvent?.(e);
    }
  }
  return events;
}

describe("POST /api/match", () => {
  it("rejects a bad setup", async () => {
    const cases: [unknown, RegExp][] = [
      [{ provider: "nope", seats: 2 }, /provider/],
      [{ provider: "demo", seats: 1 }, /2 to 6/],
      [{ provider: "demo", seats: 7 }, /2 to 6/],
      [{ provider: "demo", seats: "3" }, /2 to 6/],
      [{ provider: "demo", seats: 3, size: "giant" }, /map size/],
      [{ provider: "demo", seats: 3, apiKey: "has space" }, /API key/],
    ];
    for (const [body, msg] of cases) {
      const res = await handleMatchRequest(post(body), fast);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(msg);
    }
  });

  it("streams a full demo match and saves it with a log that replays exactly", async () => {
    const res = await handleMatchRequest(post({ provider: "demo", seats: 3, size: "small" }), fast);
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ type: "start", size: "small", grid: 16 });
    const end = events.find((e) => e.type === "end") as Extract<MatchEvent, { type: "end" }>;
    const saved = events.at(-1) as Extract<MatchEvent, { type: "saved" }>;
    expect(saved.type).toBe("saved");

    const match = getMatch(saved.id)!;
    expect(match).toMatchObject({ provider: "demo", size: "small", seats: 3, winner: end.winner, endReason: end.reason });
    expect(match.results).toEqual(end.standings);
    expect(standings(replayTo(match.log), match.winner)).toEqual(match.results);
    expect(listMatches().map((m) => m.id)).toContain(saved.id);
    expect(getMatch("missing")).toBeNull();
  });

  it("discards a match the viewer abandons", async () => {
    const before = listMatches().length;
    const ctrl = new AbortController();
    const slow = { makeAgent: () => createDemoAgent({ delayMs: 20 }), paceMs: 0 };
    const res = await handleMatchRequest(post({ provider: "demo", seats: 2 }, ctrl.signal), slow);
    let moves = 0;
    await readEvents(res, (e) => e.type === "move" && ++moves === 3 && ctrl.abort());
    await new Promise((r) => setTimeout(r, 100));
    expect(listMatches()).toHaveLength(before);
  });

  it("turns away a third match while two are running", async () => {
    const stuck: Agent = { decide: (_i, _s, _c, { signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))) };
    const deps = { makeAgent: () => stuck, paceMs: 0 };
    const ctrls = [new AbortController(), new AbortController()];
    const running = await Promise.all(ctrls.map((c) => handleMatchRequest(post({ provider: "demo", seats: 2 }, c.signal), deps)));
    const third = await handleMatchRequest(post({ provider: "demo", seats: 2 }), deps);
    expect(third.status).toBe(429);
    expect((await third.json()).error).toMatch(/busy/);
    ctrls.forEach((c) => c.abort());
    await Promise.all(running.map((r) => readEvents(r)));
    const again = await handleMatchRequest(post({ provider: "demo", seats: 2, size: "small" }), fast);
    expect(again.status).toBe(200);
    await readEvents(again);
  });
});

describe("a JEV-format match", () => {
  let fake: Awaited<ReturnType<typeof startFakeProvider>>;
  afterEach(async () => {
    await fake?.close();
  });

  it("plays through TypeSafe's wire format with one call per move", async () => {
    fake = await startFakeProvider();
    const url = `http://127.0.0.1:${fake.port}/v1/systemone`;
    const agents = [0, 1, 2].map(() => jevAgent("apikey_test_arena_123456", url));
    const r = await runMatch({ seed: 17, size: "small", agents, emit: () => {}, paceMs: 0 });
    const moves = r.log.filter((e) => e.type === "move");
    expect(moves.length).toBeGreaterThan(10);
    expect(fake.requests.length).toBeGreaterThanOrEqual(moves.length);
    const q = fake.requests[0].body.questions.move;
    expect(Object.keys(q.criteria)).toEqual(["U", "D", "L", "R"]);
    expect(q.instructions).toContain("Live Arena");
    expect(fake.requests[0].body.state).toContain("Map (row 1 top)");
    expect(r.tokens.input).toBe(11 * moves.length);
  }, 30_000);
});
