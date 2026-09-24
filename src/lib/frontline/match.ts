import { withRetries } from "../agents/providers";
import { ProviderError, type Agent, type Decision } from "../agents/types";
import { ANSWER_MS, MAX_FALLBACK_ROUNDS, RATE_LIMIT_HOLD_MS, SIZES, type SizeId } from "./config";
import { generateMap, newState, type State } from "./map";
import {
  alivePlayers,
  describeState,
  disconnect,
  fallbackOrder,
  INSTRUCTIONS,
  options,
  resolveRound,
  standings,
  winnerOf,
  type Order,
  type Report,
  type Standing,
} from "./rules";

export type RevealedOrder = {
  player: number;
  /** The option id played, or null when the fallback was used. */
  option: string | null;
  order: Order;
  choice: string;
  confidence: number;
  note?: string;
};

export type MatchEvent =
  | { type: "start"; t: 0; seed: number; size: SizeId; rounds: number; players: { id: string; name: string }[] }
  /** A player's answer is in. What it chose stays hidden until the reveal. */
  | { type: "locked"; t: number; round: number; player: number }
  | { type: "reveal"; t: number; round: number; orders: RevealedOrder[] }
  | { type: "round"; t: number; round: number; report: Report; disconnected: number[]; owner: number[]; troops: number[] }
  | { type: "out"; t: number; round: number; player: number; reason: string }
  | { type: "retry"; t: number; player: number; attempt: number; message: string; waitMs: number }
  | {
      type: "end";
      t: number;
      winner: number;
      reason: "last" | "limit";
      rounds: number;
      standings: Standing[];
      tokens: { input: number; output: number };
      durationMs: number;
    }
  | { type: "saved"; id: string }
  | { type: "error"; message: string };

export type EndEvent = Extract<MatchEvent, { type: "end" }>;

export type Clock = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(signal.reason);
      }, { once: true });
    }),
};

export type MatchOptions = {
  seed: number;
  size: SizeId;
  /** One agent per player, 2–6. Each is wrapped in `withRetries` here. */
  agents: Agent[];
  emit: (e: MatchEvent) => void;
  signal?: AbortSignal;
  clock?: Clock;
  answerMs?: number;
  rateLimitHoldMs?: number;
};

export type MatchResult = EndEvent & { seed: number; size: SizeId; log: MatchEvent[] };

type Answer = { decision: Decision } | { fallback: "timeout" | "failed" };

const isRateLimit = (e: ProviderError) => e.status === 429 || e.status === 529;

/**
 * Plays one Frontline match. Each round every living player is asked at once;
 * the round resolves when all have answered (or fallen back). Rejects if the
 * caller aborts or a provider error can't be retried.
 */
export async function runMatch(opts: MatchOptions): Promise<MatchResult> {
  const { seed, size, agents, clock = realClock, answerMs = ANSWER_MS, rateLimitHoldMs = RATE_LIMIT_HOLD_MS } = opts;
  const map = generateMap(seed, size, agents.length);
  let state: State = newState(map);
  let last: Report | undefined;
  const started = clock.now();
  const elapsed = () => Math.round(clock.now() - started);
  const log: MatchEvent[] = [];
  const tokens = { input: 0, output: 0 };
  const record = (e: MatchEvent) => {
    log.push(e);
    opts.emit(e);
  };

  const stop = new AbortController();
  const onAbort = () => stop.abort(opts.signal?.reason ?? new Error("Match aborted"));
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  // Rate-limit retries tell the waiting `ask` for that player, so the round holds longer for it.
  const rateWatchers = new Map<number, () => void>();
  const wrapped = agents.map((a, p) =>
    withRetries(
      a,
      (err, attempt, waitMs) => {
        if (isRateLimit(err)) rateWatchers.get(p)?.();
        record({ type: "retry", t: elapsed(), player: p, attempt, message: err.message, waitMs });
      },
      clock.sleep,
    ),
  );

  async function ask(p: number, round: number, state: State, choices: Record<string, string>): Promise<Answer> {
    const call = new AbortController();
    const cancel = () => call.abort(stop.signal.reason);
    stop.signal.addEventListener("abort", cancel, { once: true });
    let rateLimited = false;
    const answer = wrapped[p]
      .decide(INSTRUCTIONS, describeState(map, state, p, size, last), choices, { signal: call.signal })
      .then(
        (decision) => ({ decision }),
        (error: unknown) => ({ error }),
      );
    rateWatchers.set(p, () => (rateLimited = true));
    const wait = async (ms: number) => {
      const timer = new AbortController();
      const res = await Promise.race([answer, clock.sleep(ms, timer.signal).then(() => null, () => null)]);
      timer.abort();
      return res;
    };
    try {
      let res = await wait(answerMs);
      if (res === null && rateLimited && !stop.signal.aborted) res = await wait(rateLimitHoldMs - answerMs);
      if (stop.signal.aborted) throw stop.signal.reason;
      if (res === null) {
        call.abort(new Error("No answer in time"));
        return { fallback: "timeout" };
      }
      if ("error" in res) {
        const e = res.error;
        if (e instanceof ProviderError && e.retryable) return { fallback: "failed" };
        throw e;
      }
      record({ type: "locked", t: elapsed(), round, player: p });
      return res;
    } finally {
      rateWatchers.delete(p);
      stop.signal.removeEventListener("abort", cancel);
    }
  }

  try {
    record({ type: "start", t: 0, seed, size, rounds: SIZES[size].rounds, players: state.players.map(({ id, name }) => ({ id, name })) });

    for (;;) {
      if (stop.signal.aborted) throw stop.signal.reason;
      const round = state.round + 1;
      const alive = alivePlayers(state);
      const offered = new Map(alive.map((p) => [p, options(map, state, p)]));
      const pending = alive.map((p) => ask(p, round, state, offered.get(p)!.choices));
      const settled = await Promise.allSettled(pending);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) {
        stop.abort(failed.reason);
        throw failed.reason;
      }

      const orders: (Order | null)[] = state.players.map(() => null);
      const revealed: RevealedOrder[] = [];
      const dropped: number[] = [];
      alive.forEach((p, k) => {
        const res = (settled[k] as PromiseFulfilledResult<Answer>).value;
        const { orders: menu } = offered.get(p)!;
        const pl = state.players[p];
        if ("decision" in res) {
          const d = res.decision;
          tokens.input += d.inputTokens;
          tokens.output += d.outputTokens;
          pl.fallbacks = 0;
          const valid = d.choice in menu;
          orders[p] = valid ? menu[d.choice] : fallbackOrder(map, state, p);
          revealed.push({
            player: p,
            option: valid ? d.choice : null,
            order: orders[p]!,
            choice: d.choice,
            confidence: d.confidence,
            ...(valid ? {} : { note: "answer outside the options, reinforced instead" }),
          });
        } else {
          pl.fallbacks++;
          orders[p] = fallbackOrder(map, state, p);
          revealed.push({
            player: p,
            option: null,
            order: orders[p]!,
            choice: "",
            confidence: 0,
            note: res.fallback === "timeout" ? "no answer in time, reinforced instead" : "provider error, reinforced instead",
          });
          if (pl.fallbacks >= MAX_FALLBACK_ROUNDS) dropped.push(p);
        }
      });
      record({ type: "reveal", t: elapsed(), round, orders: revealed });

      const { state: next, report } = resolveRound(map, state, orders);
      const disconnected: number[] = [];
      for (const p of dropped) {
        // Never disconnect the last player standing; the match needs a winner.
        if (next.players[p].alive && alivePlayers(next).length > 1) {
          disconnect(next, p);
          disconnected.push(p);
        }
      }
      state = next;
      last = report;
      record({ type: "round", t: elapsed(), round, report, disconnected, owner: [...state.owner], troops: [...state.troops] });
      for (const e of report.eliminated) record({ type: "out", t: elapsed(), round, player: e.player, reason: state.players[e.player].out! });
      for (const p of disconnected) record({ type: "out", t: elapsed(), round, player: p, reason: "disconnected" });

      const w = winnerOf(state, size);
      if (w) {
        const end: EndEvent = {
          type: "end",
          t: elapsed(),
          winner: w.winner,
          reason: w.reason,
          rounds: state.round,
          standings: standings(state, w.winner),
          tokens: { ...tokens },
          durationMs: elapsed(),
        };
        record(end);
        return { ...end, seed, size, log };
      }
    }
  } finally {
    stop.abort(new Error("Match over"));
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
