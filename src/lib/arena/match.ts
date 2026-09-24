import { withRetries } from "../agents/providers";
import { ProviderError, type Agent } from "../agents/types";
import {
  applyMove,
  describeOptions,
  describeState,
  eliminate,
  generateArena,
  INSTRUCTIONS,
  standings,
  timeWinner,
  winnerOf,
  type Dir,
  type SeatResult,
} from "./board";
import { PACE_MS, SIZES, type SizeId } from "./config";

export type MatchEvent =
  | {
      type: "start";
      t: 0;
      seed: number;
      size: SizeId;
      grid: number;
      timeLimitMs: number;
      seats: { id: string; name: string; pos: number; dir: Dir }[];
    }
  /** `dir` is what was played: straight ahead when the answer was outside the options. */
  | { type: "move"; t: number; seat: number; dir: Dir; choice: string; confidence: number; note?: string }
  | { type: "crash"; t: number; seat: number; reason: string }
  | { type: "retry"; t: number; seat: number; attempt: number; message: string; waitMs: number }
  | {
      type: "end";
      t: number;
      winner: number;
      reason: "last" | "time";
      standings: SeatResult[];
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
  /** One agent per seat, 2–6. Each is wrapped in `withRetries` here. */
  agents: Agent[];
  emit: (e: MatchEvent) => void;
  signal?: AbortSignal;
  clock?: Clock;
  paceMs?: number;
  timeLimitMs?: number;
};

export type MatchResult = EndEvent & { seed: number; size: SizeId; log: MatchEvent[] };

/**
 * Plays one live match. Every seat runs its own loop and moves the moment its
 * answer arrives; moves are applied one at a time to the current board.
 * Rejects if the caller aborts or a provider error can't be retried.
 */
export async function runMatch(opts: MatchOptions): Promise<MatchResult> {
  const { seed, size, agents, clock = realClock, paceMs = PACE_MS } = opts;
  const timeLimitMs = opts.timeLimitMs ?? SIZES[size].timeLimitMs;
  const board = generateArena(seed, size, agents.length);
  const started = clock.now();
  const elapsed = () => Math.round(clock.now() - started);
  const log: MatchEvent[] = [];
  const tokens = { input: 0, output: 0 };
  const record = (e: MatchEvent) => {
    if (ended) return;
    log.push(e);
    opts.emit(e);
  };

  let ended = false;
  const stop = new AbortController();
  const seatCtrls = agents.map(() => new AbortController());
  let settle!: { resolve: (e: EndEvent) => void; reject: (e: unknown) => void };
  const done = new Promise<EndEvent>((resolve, reject) => (settle = { resolve, reject }));

  const halt = () => {
    stop.abort();
    for (const c of seatCtrls) c.abort();
  };
  const finish = (winner: number, reason: EndEvent["reason"]) => {
    if (ended) return;
    const end: EndEvent = { type: "end", t: elapsed(), winner, reason, standings: standings(board, winner), tokens: { ...tokens }, durationMs: elapsed() };
    record(end);
    ended = true;
    halt();
    settle.resolve(end);
  };
  const fail = (e: unknown) => {
    if (ended) return;
    ended = true;
    halt();
    settle.reject(e);
  };
  const checkLast = () => {
    const w = winnerOf(board);
    if (w !== null) finish(w, "last");
  };

  const onAbort = () => fail(opts.signal?.reason ?? new Error("Match aborted"));
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  record({
    type: "start",
    t: 0,
    seed,
    size,
    grid: board.grid,
    timeLimitMs,
    seats: board.seats.map(({ id, name, pos, dir }) => ({ id, name, pos, dir })),
  });

  async function seatLoop(i: number) {
    const signal = seatCtrls[i].signal;
    const agent = withRetries(
      agents[i],
      (err, attempt, waitMs) => record({ type: "retry", t: elapsed(), seat: i, attempt, message: err.message, waitMs }),
      clock.sleep,
    );
    const seat = board.seats[i];
    let lastMove = -Infinity;
    while (!ended && seat.alive) {
      const options = describeOptions(board, i);
      let d;
      try {
        d = await agent.decide(INSTRUCTIONS, describeState(board, i, elapsed(), timeLimitMs), options, { signal });
      } catch (e) {
        if (ended || signal.aborted) return;
        if (e instanceof ProviderError && e.retryable) {
          eliminate(board, i, "disconnected", elapsed());
          record({ type: "crash", t: elapsed(), seat: i, reason: "disconnected" });
          checkLast();
          return;
        }
        fail(e);
        return;
      }
      if (ended) return;
      tokens.input += d.inputTokens;
      tokens.output += d.outputTokens;
      const wait = lastMove + paceMs - clock.now();
      if (wait > 0) {
        try {
          await clock.sleep(wait, signal);
        } catch {
          return;
        }
      }
      if (ended || !seat.alive) return;

      const valid = d.choice in options;
      const dir = valid ? (d.choice as Dir) : seat.dir;
      const t = elapsed();
      const r = applyMove(board, i, dir, t);
      lastMove = clock.now();
      record({
        type: "move",
        t,
        seat: i,
        dir,
        choice: d.choice,
        confidence: d.confidence,
        ...(valid ? {} : { note: "answer outside the options, kept going straight" }),
      });
      if (!r.moved) {
        record({ type: "crash", t, seat: i, reason: r.reason });
        checkLast();
      }
    }
  }

  clock.sleep(timeLimitMs, stop.signal).then(
    () => finish(timeWinner(board), "time"),
    () => {},
  );
  const loops = agents.map((_, i) => seatLoop(i).catch(fail));

  try {
    const end = await done;
    return { ...end, seed, size, log };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    await Promise.allSettled(loops);
  }
}
