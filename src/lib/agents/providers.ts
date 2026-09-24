import { fetch } from "undici";
import { createDemoAgent } from "./demo";
import { ProviderError, type Agent, type AgentConfig, type Choices, type Decision } from "./types";

const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1000, 3000, 8000];
/** Rate limits (429) and overload (529) both ask for backoff, so they get a bigger retry budget. */
const RATE_LIMIT_RETRIES = 40;
const MAX_WAIT_MS = 90_000;

export function parseRetryAfter(header: string | null, message: string): number | undefined {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  const m = message.match(/retry (?:after|in) (\d+(?:\.\d+)?)\s*s/i);
  return m ? Number(m[1]) * 1000 : undefined;
}

export const JEV_BASE = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

type Json = Record<string, any>;

function redact(text: string, secret?: string) {
  let out = text.slice(0, 500);
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/\bapikey_[-_A-Za-z0-9]{8,}/g, "[redacted]");
}

/** A single Choice-question call to TypeSafe's System One API. `base` is overridable only for tests. */
export function jevAgent(apiKey: string, base: string = JEV_BASE): Agent {
  return {
    async decide(instructions, state, choices, { signal }) {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            state,
            model: JEV_MODEL,
            questions: { move: { type: "choice", instructions, criteria: choices } },
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        const msg = timeout.aborted ? "Request timed out" : `Network error: ${(e as Error).message}`;
        throw new ProviderError(redact(msg, apiKey), null, true);
      }
      const text = await res.text();
      let json: Json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        /* non-JSON error bodies are reported as text below */
      }
      if (!res.ok) {
        const detail = json?.detail?.message ?? json?.detail?.error_type ?? json?.message ?? text;
        const retryable = res.status === 408 || res.status === 429 || res.status === 529 || res.status >= 500;
        const message = `HTTP ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
        throw new ProviderError(redact(message, apiKey), res.status, retryable, parseRetryAfter(res.headers.get("retry-after"), message));
      }
      const answer = json.answers?.move ?? {};
      return {
        choice: answer.choice ?? "",
        confidence: answer.confidence ?? 0,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      };
    },
  };
}

/** Keys the server holds itself, used when a visitor leaves the key field blank. */
export function serverKey(provider: AgentConfig["provider"]): string | undefined {
  if (provider === "jev") return process.env.JEV_API_KEY || undefined;
  return undefined;
}

export function createAgent(cfg: AgentConfig): Agent {
  if (cfg.provider === "demo") return createDemoAgent({ sloppy: true });
  const key = cfg.apiKey || serverKey("jev");
  if (!key) throw new Error("An API key is required: paste one, or ask the server owner to set JEV_API_KEY.");
  return jevAgent(key);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export function withRetries(agent: Agent, onRetry?: (err: ProviderError, attempt: number, waitMs: number) => void): Agent {
  return {
    async decide(instructions: string, state: string, choices: Choices, opts): Promise<Decision> {
      let waitedMs = 0;
      for (let attempt = 0; ; attempt++) {
        const started = performance.now();
        try {
          const res = await agent.decide(instructions, state, choices, opts);
          return { ...res, waitedMs: (res.waitedMs ?? 0) + waitedMs };
        } catch (e) {
          if (!(e instanceof ProviderError) || !e.retryable) throw e;
          const rateLimited = e.status === 429 || e.status === 529;
          if (attempt >= (rateLimited ? RATE_LIMIT_RETRIES : RETRY_DELAYS_MS.length)) throw e;
          const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] * (rateLimited ? 2 : 1);
          const waitMs = Math.min(MAX_WAIT_MS, e.retryAfterMs !== undefined ? e.retryAfterMs + 250 + Math.random() * 1000 : base);
          onRetry?.(e, attempt + 1, waitMs);
          await sleep(waitMs, opts.signal);
          waitedMs += performance.now() - started;
        }
      }
    },
  };
}
