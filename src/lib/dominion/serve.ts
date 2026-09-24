import { randomInt } from "node:crypto";
import { createAgent } from "../agents/providers";
import { PROVIDERS, type AgentConfig, type ProviderId } from "../agents/types";
import { saveMatch } from "../db";
import { defaultSize, MAX_PLAYERS, MIN_PLAYERS, SIZES, type SizeId } from "./config";
import { runMatch, type Clock, type MatchEvent, type Seat } from "./match";

/** Each turn keeps up to six calls in flight on one key. */
export const MAX_CONCURRENT_MATCHES = 2;
let activeMatches = 0;

/** Overridable only by tests. */
/** Overridable only by tests. `demoDelayMs` paces demo seats so a match can be watched. */
export type MatchDeps = { makeSeat?: (cfg: AgentConfig) => Seat; clock?: Clock; demoDelayMs?: number };

type Body = { provider?: string; apiKey?: string; seats?: unknown; size?: string };

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

/** POST /api/dominion: validates the setup, then streams a Dominion match as server-sent events and saves it when it ends. */
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
  if (typeof seats !== "number" || !Number.isInteger(seats) || seats < MIN_PLAYERS || seats > MAX_PLAYERS) {
    return bad(`Choose ${MIN_PLAYERS} to ${MAX_PLAYERS} players.`);
  }
  const size = (body.size ?? defaultSize(seats)) as SizeId;
  if (!(size in SIZES)) return bad("Unknown map size.");
  const apiKey = (body.apiKey ?? "").trim();
  if (apiKey.length > 1000 || /\s/.test(apiKey)) return bad("Enter a valid API key.");

  // Demo seats play the built-in policy, which reads the game directly instead of parsing option text.
  const demoSeat = (): Seat => ({ auto: { delayMs: deps.demoDelayMs ?? 350, slip: 0.08 } });
  let agents: Seat[];
  try {
    agents = Array.from({ length: seats }, () => (deps.makeSeat ?? ((cfg: AgentConfig) => (cfg.provider === "demo" ? demoSeat() : createAgent(cfg))))({ provider, apiKey }));
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
          seats: agents,
          emit,
          signal: abort.signal,
          clock: deps.clock,
        });
        const saved = saveMatch({
          game: "dominion",
          provider,
          seed: result.seed,
          size,
          seats,
          winner: result.winner,
          endReason: result.victory,
          rounds: result.turns,
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
