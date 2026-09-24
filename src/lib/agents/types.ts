/** One turn's fixed set of choices: option id -> description shown to the model. */
export type Choices = Record<string, string>;

/** `waitedMs` is time spent backing off between retries, which no game's clock counts. */
export type Decision = { choice: string; confidence: number; inputTokens: number; outputTokens: number; waitedMs?: number };

/** One named Choice question in a multi-question call. */
export type QuestionSpec = { instructions: string; choices: Choices };

/** Answers to a multi-question call, keyed like the questions. A question can be missing from `answers`. */
export type ManyDecision = {
  answers: Record<string, { choice: string; confidence: number }>;
  inputTokens: number;
  outputTokens: number;
  waitedMs?: number;
};

export interface Agent {
  /** `instructions` is the fixed game-rules text; `state` is the current turn's context. */
  decide(instructions: string, state: string, choices: Choices, opts: { signal?: AbortSignal }): Promise<Decision>;
  /** Several independent questions about one shared state, answered in a single call. Optional; see `askMany`. */
  decideMany?(state: string, questions: Record<string, QuestionSpec>, opts: { signal?: AbortSignal }): Promise<ManyDecision>;
}

export const PROVIDERS = {
  demo: { label: "Demo bot (free, no key)", needsKey: false, verified: false },
  jev: { label: "TypeSafe JEV", needsKey: false, verified: true },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export type AgentConfig = { provider: ProviderId; apiKey?: string };

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    /** How long the provider asked us to wait before retrying, if it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
