import { fetch } from "undici";
import { createDemoAgent } from "./demo";
import { ProviderError, type Agent, type AgentConfig, type Choices, type Decision, type ManyDecision, type QuestionSpec } from "./types";

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

/**
 * TypeSafe's System One API. `decide` asks one Choice question; `decideMany` sends
 * several named Choice questions about one state in a single request, which the
 * API evaluates independently. `base` is overridable only for tests.
 */
export function jevAgent(apiKey: string, base: string = JEV_BASE): Agent {
  async function call(state: string, questions: Record<string, QuestionSpec>, signal?: AbortSignal): Promise<ManyDecision> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          state,
          model: JEV_MODEL,
          questions: Object.fromEntries(
            Object.entries(questions).map(([key, q]) => [key, { type: "choice", instructions: q.instructions, criteria: q.choices }]),
          ),
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
    const answers: ManyDecision["answers"] = {};
    for (const key of Object.keys(questions)) {
      const a = json.answers?.[key];
      if (a) answers[key] = { choice: a.choice ?? "", confidence: a.confidence ?? 0 };
    }
    return { answers, inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 };
  }
  return {
    async decide(instructions, state, choices, { signal }) {
      const r = await call(state, { move: { instructions, choices } }, signal);
      const answer = r.answers.move ?? { choice: "", confidence: 0 };
      return { ...answer, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    },
    decideMany: (state, questions, { signal }) => call(state, questions, signal),
  };
}

/** Asks several questions at once: in one call if the agent supports it, otherwise one at a time. */
export async function askMany(
  agent: Agent,
  state: string,
  questions: Record<string, QuestionSpec>,
  opts: { signal?: AbortSignal },
): Promise<ManyDecision> {
  if (agent.decideMany) return agent.decideMany(state, questions, opts);
  const out: ManyDecision = { answers: {}, inputTokens: 0, outputTokens: 0, waitedMs: 0 };
  for (const [key, q] of Object.entries(questions)) {
    const d = await agent.decide(q.instructions, state, q.choices, opts);
    out.answers[key] = { choice: d.choice, confidence: d.confidence };
    out.inputTokens += d.inputTokens;
    out.outputTokens += d.outputTokens;
    out.waitedMs! += d.waitedMs ?? 0;
  }
  return out;
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

export function withRetries(
  agent: Agent,
  onRetry?: (err: ProviderError, attempt: number, waitMs: number) => void,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
): Agent {
  async function retrying<T extends { waitedMs?: number }>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let waitedMs = 0;
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      try {
        const res = await run();
        return { ...res, waitedMs: (res.waitedMs ?? 0) + waitedMs };
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable) throw e;
        const rateLimited = e.status === 429 || e.status === 529;
        if (attempt >= (rateLimited ? RATE_LIMIT_RETRIES : RETRY_DELAYS_MS.length)) throw e;
        const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] * (rateLimited ? 2 : 1);
        const waitMs = Math.min(MAX_WAIT_MS, e.retryAfterMs !== undefined ? e.retryAfterMs + 250 + Math.random() * 1000 : base);
        onRetry?.(e, attempt + 1, waitMs);
        await wait(waitMs, signal);
        waitedMs += performance.now() - started;
      }
    }
  }
  const wrapped: Agent = {
    decide: (instructions: string, state: string, choices: Choices, opts): Promise<Decision> =>
      retrying(() => agent.decide(instructions, state, choices, opts), opts.signal),
  };
  if (agent.decideMany) wrapped.decideMany = (state, questions, opts) => retrying(() => agent.decideMany!(state, questions, opts), opts.signal);
  return wrapped;
}
