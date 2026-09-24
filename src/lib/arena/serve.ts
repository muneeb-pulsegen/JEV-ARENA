import { randomInt } from "node:crypto";
import { createAgent } from "../agents/providers";
import { PROVIDERS, type Agent, type AgentConfig, type ProviderId } from "../agents/types";
import { saveMatch } from "../db";
import { defaultSize, MAX_SEATS, MIN_SEATS, SIZES, type SizeId } from "./config";
import { runMatch, type Clock, type MatchEvent } from "./match";

/** Each match keeps up to six calls in flight on one key. */
export const MAX_CONCURRENT_MATCHES = 2;
let activeMatches = 0;

/** Overridable only by tests. */
export type MatchDeps = { makeAgent?: (cfg: AgentConfig) => Agent; paceMs?: number; clock?: Clock };

type Body = { provider?: string; apiKey?: string; seats?: unknown; size?: string };

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

/** POST /api/match: validates the setup, then streams the live match as server-sent events and saves it when it ends. */
export async function handleMatchRequest(req: Request, deps: MatchDeps = {}): Promise<Response> {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return bad("Request body must be JSON.");
  }

  const provider = body.provider as ProviderId;
  if (!provider || !(provider in PROVIDERS)) return bad("Unknown provider.");
  const seats = body.seats;
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < MIN_SEATS || seats > MAX_SEATS) {
    return bad(`Choose ${MIN_SEATS} to ${MAX_SEATS} players.`);
  }
  const size = (body.size ?? defaultSize(seats)) as SizeId;
  if (!(size in SIZES)) return bad("Unknown map size.");
  const apiKey = (body.apiKey ?? "").trim();
  if (apiKey.length > 1000 || /\s/.test(apiKey)) return bad("Enter a valid API key.");

  let agents: Agent[];
  try {
    agents = Array.from({ length: seats }, () => (deps.makeAgent ?? createAgent)({ provider, apiKey }));
  } catch (e) {
    return bad((e as Error).message);
  }

  if (activeMatches >= MAX_CONCURRENT_MATCHES) return bad("The arena is busy. Try again in a minute.", 429);
  activeMatches++;

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(new Error("The viewer left.")), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          abort.abort(new Error("The viewer left."));
        }
      };
      const emit = (e: MatchEvent) => {
        if (!abort.signal.aborted) send(`data: ${JSON.stringify(e)}\n\n`);
      };
      const keepAlive = setInterval(() => send(": keep-alive\n\n"), 15_000);

      try {
        const result = await runMatch({
          seed: randomInt(0, 2 ** 31 - 1),
          size,
          agents,
          emit,
          signal: abort.signal,
          clock: deps.clock,
          paceMs: deps.paceMs,
        });
        const saved = saveMatch({
          provider,
          seed: result.seed,
          size,
          seats,
          winner: result.winner,
          endReason: result.reason,
          durationMs: result.durationMs,
          tokensIn: result.tokens.input,
          tokensOut: result.tokens.output,
          results: result.standings,
          log: result.log,
        });
        emit({ type: "saved", id: saved.id });
      } catch (e) {
        if (!abort.signal.aborted) emit({ type: "error", message: `Match stopped: ${(e as Error).message}. Nothing was saved.` });
      } finally {
        clearInterval(keepAlive);
        activeMatches--;
        try {
          controller.close();
        } catch {
          /* already closed by a disconnect */
        }
      }
    },
    cancel() {
      abort.abort(new Error("The viewer left."));
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
