import { afterEach, describe, expect, it } from "vitest";
import { jevAgent, parseRetryAfter, withRetries } from "@/lib/agents/providers";
import { ProviderError } from "@/lib/agents/types";
import { runAll } from "@/lib/runner/run";
import { startFakeProvider } from "./fakeProvider";

const KEY = "apikey_test_SECRET1234567890";
const INSTRUCTIONS = "You are playing Relay Sorter";
const STATE = "Round 1 of 60 · tier 1 (worth 1) · 60.0s left · 0 pts.\nRules: RED → X, BLUE → Y, GREEN → Z.\nItem: RED\nWhich gate does it go to?";
const CHOICES = { X: "Route to gate X.", Y: "Route to gate Y.", Z: "Route to gate Z." };

describe("retry-after parsing", () => {
  it("reads the header in seconds or as a date, or falls back to the message", () => {
    expect(parseRetryAfter("7", "")).toBe(7000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString(), "")).toBeGreaterThan(3000);
    expect(parseRetryAfter(null, "limit of 5 requests per minute was reached. Retry after 22s.")).toBe(22000);
    expect(parseRetryAfter(null, "nothing here")).toBeUndefined();
  });
});

describe("jev provider (against a local fake server)", () => {
  let fake: Awaited<ReturnType<typeof startFakeProvider>>;
  const url = () => `http://127.0.0.1:${fake.port}/v1/systemone`;
  afterEach(async () => {
    await fake?.close();
  });

  it("sends bearer auth and the state/model/questions body, and parses the choice back", async () => {
    fake = await startFakeProvider();
    const agent = jevAgent(KEY, url());
    const r = await agent.decide(INSTRUCTIONS, STATE, CHOICES, {});
    expect(r.choice).toBe("X");
    expect(r.confidence).toBe(1);
    expect(r.inputTokens).toBe(11);
    expect(r.outputTokens).toBe(3);
    const req = fake.requests[0];
    expect(req.path).toBe("/v1/systemone");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toMatchObject({
      state: STATE,
      model: "jev-latest",
      questions: { move: { type: "choice", instructions: INSTRUCTIONS, criteria: CHOICES } },
    });
  });

  it("does not retry auth errors and redacts the key", async () => {
    fake = await startFakeProvider({ failFirst: 5, failStatus: 401 });
    const agent = withRetries(jevAgent(KEY, url()));
    const err = await agent.decide(INSTRUCTIONS, STATE, CHOICES, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("[redacted]");
    expect(fake.requests).toHaveLength(1);
  });

  it("retries rate limits and then succeeds", async () => {
    fake = await startFakeProvider({ failFirst: 1, failStatus: 429 });
    const seen: number[] = [];
    const agent = withRetries(jevAgent(KEY, url()), (_e, attempt) => seen.push(attempt));
    expect((await agent.decide(INSTRUCTIONS, STATE, CHOICES, {})).choice).toBe("X");
    expect(seen).toEqual([1]);
    expect(fake.requests).toHaveLength(2);
  });

  it("retries an overloaded (529) response the same as a rate limit", async () => {
    fake = await startFakeProvider({ failFirst: 1, failStatus: 529 });
    const agent = withRetries(jevAgent(KEY, url()));
    expect((await agent.decide(INSTRUCTIONS, STATE, CHOICES, {})).choice).toBe("X");
    expect(fake.requests).toHaveLength(2);
  });

  it("waits as long as a rate-limited provider asks, and keeps retrying past the normal budget", async () => {
    fake = await startFakeProvider({ failFirst: 5, failStatus: 429, retryAfter: "0" });
    const waits: number[] = [];
    const agent = withRetries(jevAgent(KEY, url()), (_e, _attempt, waitMs) => waits.push(waitMs));
    const r = await agent.decide(INSTRUCTIONS, STATE, CHOICES, {});
    expect(r.choice).toBe("X");
    expect(waits).toHaveLength(5);
    expect(waits.every((w) => w >= 250 && w < 1300)).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(waits.reduce((a, b) => a + b, 0) - 50);
  }, 30_000);

  it("plays a full four-game run over HTTP", async () => {
    fake = await startFakeProvider();
    const agent = jevAgent(KEY, url());
    const events: string[] = [];
    const summary = await runAll(agent, 12345, (e) => events.push(e.type));
    expect(Object.keys(summary.scores).sort()).toEqual(["dispatch", "mechanism", "planning", "routing"]);
    expect(summary.scores.planning).toBe(100);
    expect(summary.scores.routing).toBe(100);
    expect(summary.scores.mechanism).toBe(100);
    expect(summary.scores.dispatch).toBe(100);
    expect(summary.tokens.input).toBeGreaterThan(0);
    expect(events.filter((t) => t === "game_end")).toHaveLength(4);
    const vaultReqs = fake.requests.filter((r) => r.body.questions?.move?.instructions?.includes("Tumbler Vault"));
    expect(vaultReqs.length).toBeGreaterThan(0);
    expect(vaultReqs[vaultReqs.length - 1].body.state).toContain("Vault 5 of 5");
  }, 60_000);
});
