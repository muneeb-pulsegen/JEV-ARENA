import { randomInt } from "node:crypto";
import { createAgent, JEV_MODEL, withRetries } from "@/lib/agents/providers";
import { PROVIDERS, type ProviderId } from "@/lib/agents/types";
import { saveRun } from "@/lib/db";
import { runAll, type RunEvent } from "@/lib/runner/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONCURRENT_RUNS = 4;
let activeRuns = 0;

type Body = { provider?: string; apiKey?: string; displayName?: string };

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return bad("Request body must be JSON.");
  }

  const provider = body.provider as ProviderId;
  if (!provider || !(provider in PROVIDERS)) return bad("Unknown provider.");
  const meta = PROVIDERS[provider];
  const apiKey = (body.apiKey ?? "").trim();
  if (apiKey.length > 1000 || /\s/.test(apiKey)) return bad("Enter a valid API key.");
  const model = provider === "demo" ? "demo-solver" : JEV_MODEL;
  const displayName = (body.displayName ?? "").trim().slice(0, 40) || model;

  let agent;
  try {
    agent = createAgent({ provider, apiKey });
  } catch (e) {
    return bad((e as Error).message);
  }

  if (activeRuns >= MAX_CONCURRENT_RUNS) return bad("The arena is busy. Try again in a minute.", 429);
  activeRuns++;

  const route = provider === "demo" ? "demo" : "TypeSafe JEV";
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: RunEvent) => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          abort.abort();
        }
      };
      const retrying = withRetries(agent, (err, attempt, waitMs) => emit({ type: "retry", attempt, message: err.message, waitMs }));
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          abort.abort();
        }
      }, 15_000);

      try {
        const summary = await runAll(retrying, randomInt(0, 2 ** 31 - 1), emit, abort.signal);
        let saved = false;
        let entryId: string | undefined;
        let note: string | undefined;
        if (provider === "demo") {
          note = "Demo runs are not added to the leaderboard.";
        } else {
          const entry = saveRun({
            displayName,
            provider,
            model,
            route,
            verified: meta.verified,
            seed: summary.seed,
            overall: summary.overall,
            scores: summary.scores,
            tokensIn: summary.tokens.input,
            tokensOut: summary.tokens.output,
            durationMs: summary.durationMs,
          });
          saved = true;
          entryId = entry.id;
        }
        emit({ type: "run_end", ...summary, saved, entryId, note });
      } catch (e) {
        if (!abort.signal.aborted) emit({ type: "error", message: `Run stopped: ${(e as Error).message}. Incomplete runs are not ranked.` });
      } finally {
        clearInterval(keepAlive);
        activeRuns--;
        try {
          controller.close();
        } catch {
          /* already closed by a disconnect */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
