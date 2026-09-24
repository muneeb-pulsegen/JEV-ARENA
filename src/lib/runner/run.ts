import { GAMES, gameSeed, type GameDef, type GameId, type GameView } from "../games";
import type { Agent } from "../agents/types";

export const MAX_TURNS_PER_GAME = 320;
const CLIP = 1500;

export type RunEvent =
  | { type: "run_start"; seed: number; games: { id: GameId; name: string; axis: string; blurb: string }[] }
  | { type: "game_start"; game: GameId; view: GameView }
  | {
      type: "turn";
      game: GameId;
      turn: number;
      state: string;
      choice: string;
      confidence: number;
      note?: string;
      progress: string;
      score: number;
      view: GameView;
    }
  | { type: "retry"; attempt: number; message: string; waitMs: number }
  | { type: "game_end"; game: GameId; score: number; progress: string; turns: number; view: GameView }
  | {
      type: "run_end";
      scores: Record<GameId, number>;
      overall: number;
      tokens: { input: number; output: number };
      durationMs: number;
      saved: boolean;
      entryId?: string;
      note?: string;
    }
  | { type: "error"; message: string };

export type RunSummary = {
  seed: number;
  scores: Record<GameId, number>;
  overall: number;
  tokens: { input: number; output: number };
  durationMs: number;
};

const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s);

export async function runGame(
  def: GameDef<any>,
  seed: number,
  agent: Agent,
  emit: (e: RunEvent) => void,
  signal?: AbortSignal,
) {
  const session = def.create(seed);
  const tokens = { input: 0, output: 0 };
  let turn = 0;
  emit({ type: "game_start", game: def.id, view: session.view() });

  while (!session.done() && turn < MAX_TURNS_PER_GAME) {
    signal?.throwIfAborted();
    turn++;
    const state = session.state();
    const choices = session.options();
    const started = performance.now();

    const res = await agent.decide(def.instructions, state, choices, { signal });
    tokens.input += res.inputTokens;
    tokens.output += res.outputTokens;
    const valid = res.choice in choices;
    const note = valid ? undefined : "the provider returned a choice outside the options, counted as a miss";

    signal?.throwIfAborted();
    session.step(valid ? res.choice : null, performance.now() - started - (res.waitedMs ?? 0));
    emit({
      type: "turn",
      game: def.id,
      turn,
      state: clip(state),
      choice: res.choice,
      confidence: res.confidence,
      note,
      progress: session.progress(),
      score: session.score(),
      view: session.view(),
    });
  }

  const result = { score: session.score(), progress: session.progress(), turns: turn, tokens };
  emit({ type: "game_end", game: def.id, score: result.score, progress: result.progress, turns: turn, view: session.view() });
  return result;
}

/** Plays every game at once. If one game fails, the rest are cancelled and the first error is thrown. */
export async function runAll(agent: Agent, seed: number, emit: (e: RunEvent) => void, signal?: AbortSignal): Promise<RunSummary> {
  const started = Date.now();
  const inner = new AbortController();
  const forward = () => inner.abort(signal?.reason);
  if (signal?.aborted) forward();
  signal?.addEventListener("abort", forward, { once: true });

  let firstError: unknown = null;
  const guardedEmit = (e: RunEvent) => {
    if (!inner.signal.aborted) emit(e);
  };
  emit({ type: "run_start", seed, games: GAMES.map(({ id, name, axis, blurb }) => ({ id, name, axis, blurb })) });

  try {
    const results = await Promise.allSettled(
      GAMES.map((def) =>
        runGame(def, gameSeed(seed, def.id), agent, guardedEmit, inner.signal).catch((e) => {
          if (firstError === null && !inner.signal.aborted) firstError = e;
          inner.abort(e);
          throw e;
        }),
      ),
    );
    if (signal?.aborted) throw signal.reason ?? new Error("Run aborted");
    if (firstError !== null) throw firstError;

    const scores = {} as Record<GameId, number>;
    const tokens = { input: 0, output: 0 };
    results.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      scores[GAMES[i].id] = r.value.score;
      tokens.input += r.value.tokens.input;
      tokens.output += r.value.tokens.output;
    });
    const overall = Math.round((Object.values(scores).reduce((a, b) => a + b, 0) / GAMES.length) * 10) / 10;
    return { seed, scores, overall, tokens, durationMs: Date.now() - started };
  } finally {
    signal?.removeEventListener("abort", forward);
  }
}
