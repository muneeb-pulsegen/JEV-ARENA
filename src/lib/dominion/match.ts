import { askMany, withRetries } from "../agents/providers";
import { ProviderError, type Agent, type ManyDecision } from "../agents/types";
import { createRng, deriveSeed } from "../games/rng";
import { ANSWER_MS, MAX_FALLBACK_TURNS, RATE_LIMIT_HOLD_MS, SIZES, type SizeId } from "./config";
import { generateMap } from "./map";
import { mergeOrders, questionsFor, type Question, type QuestionKind } from "./questions";
import { newState, type State, type Victory } from "./state";
import { resolveTurn, type Orders, type TurnReport } from "./turn";
import { describeState } from "./view";
import { checkVictory, score } from "./victory";

/** A seat played by the built-in policy (the demo bot), which picks each question's recommended option. */
export type AutoSeat = { auto: { delayMs: number; slip: number } };
export type Seat = Agent | AutoSeat;
const isAuto = (s: Seat): s is AutoSeat => "auto" in s;

export type Decision = {
  player: number;
  key: string;
  kind: QuestionKind;
  /** What the player answered ("" if nothing). */
  choice: string;
  /** The option applied: the answer if it was valid, otherwise the recommended fallback. */
  option: string;
  confidence: number;
  note?: string;
};

/** The state everyone may see in the log: the full state without each player's memory of the map. */
export type Snapshot = Omit<State, "players" | "names"> & { players: Omit<State["players"][number], "seen">[] };

export type Standing = {
  player: number;
  id: string;
  name: string;
  place: number;
  score: number;
  cities: number;
  population: number;
  techs: number;
  wonders: number;
  out?: string;
  outTurn?: number;
};

export type MatchEvent =
  | { type: "start"; t: 0; seed: number; size: SizeId; turns: number; players: { id: string; name: string }[]; snapshot: Snapshot }
  | { type: "answered"; t: number; turn: number; player: number; questions: number }
  | { type: "orders"; t: number; turn: number; decisions: Decision[]; orders: (Orders | null)[] }
  | { type: "turn"; t: number; turn: number; report: TurnReport; disconnected: number[]; snapshot: Snapshot }
  | { type: "out"; t: number; turn: number; player: number; reason: string }
  | { type: "retry"; t: number; player: number; attempt: number; message: string; waitMs: number }
  | {
      type: "end";
      t: number;
      winner: number;
      victory: Victory["kind"];
      turns: number;
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

export function snapshot(s: State): Snapshot {
  const { names: _names, players, ...rest } = structuredClone(s);
  return { ...rest, players: players.map(({ seen: _seen, ...p }) => p) };
}

export function standingsOf(s: State, winner: number): Standing[] {
  const row = (p: number) => {
    const cs = s.cities.filter((c) => c.owner === p);
    const pl = s.players[p];
    return {
      player: p,
      id: pl.id,
      name: pl.name,
      score: score(s, p),
      cities: cs.length,
      population: cs.reduce((n, c) => n + c.pop, 0),
      techs: pl.techs.length,
      wonders: pl.wonders.length,
      ...(pl.out ? { out: pl.out, outTurn: pl.outTurn } : {}),
    };
  };
  const rest = s.players
    .map((_, p) => p)
    .filter((p) => p !== winner)
    .sort((a, b) => {
      const pa = s.players[a], pb = s.players[b];
      if (pa.alive !== pb.alive) return pa.alive ? -1 : 1;
      if (pa.alive) return score(s, b) - score(s, a) || a - b;
      return (pb.outTurn ?? 0) - (pa.outTurn ?? 0) || a - b;
    });
  return [winner, ...rest].map((p, k) => ({ ...row(p), place: k + 1 }));
}

/** Takes a player that stopped answering out of the game: its cities, army and settlers are removed. */
export function disconnect(s: State, p: number) {
  const pl = s.players[p];
  pl.alive = false;
  pl.out = "disconnected";
  pl.outTurn = s.turn;
  s.cities = s.cities.filter((c) => c.owner !== p);
  s.armies[p] = null;
  s.settlers = s.settlers.filter((st) => st.owner !== p);
  s.owner.forEach((o, i) => o === p && (s.owner[i] = -1));
}

export type MatchOptions = {
  seed: number;
  size: SizeId;
  seats: Seat[];
  emit: (e: MatchEvent) => void;
  signal?: AbortSignal;
  clock?: Clock;
  answerMs?: number;
  rateLimitHoldMs?: number;
};

export type MatchResult = EndEvent & { seed: number; size: SizeId; log: MatchEvent[] };

type Answer = { decision: ManyDecision } | { fallback: "timeout" | "failed" };

const isRateLimit = (e: ProviderError) => e.status === 429 || e.status === 529;

/**
 * Plays one Dominion match. Each turn every living player with a decision to make
 * gets one multi-question call; calls run in parallel and the turn resolves when
 * all have answered or fallen back. Rejects on abort or a non-retryable error.
 */
export async function runMatch(opts: MatchOptions): Promise<MatchResult> {
  const { seed, size, seats, clock = realClock, answerMs = ANSWER_MS, rateLimitHoldMs = RATE_LIMIT_HOLD_MS } = opts;
  const map = generateMap(seed, size, seats.length);
  let state = newState(map, seed);
  let last: TurnReport | undefined;
  const started = clock.now();
  const elapsed = () => Math.round(clock.now() - started);
  const log: MatchEvent[] = [];
  const tokens = { input: 0, output: 0 };
  const record = (e: MatchEvent) => {
    log.push(e);
    opts.emit(e);
  };
  const slipRng = seats.map((_, p) => createRng(deriveSeed(seed, 1000 + p)));

  const stop = new AbortController();
  const onAbort = () => stop.abort(opts.signal?.reason ?? new Error("Match aborted"));
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const rateWatchers = new Map<number, () => void>();
  const agents = seats.map((seat, p) =>
    isAuto(seat)
      ? null
      : withRetries(
          seat,
          (err, attempt, waitMs) => {
            if (isRateLimit(err)) rateWatchers.get(p)?.();
            record({ type: "retry", t: elapsed(), player: p, attempt, message: err.message, waitMs });
          },
          clock.sleep,
        ),
  );

  /** The built-in policy: the recommended option, now and then (per `slip`) a different one. */
  function autoAnswer(p: number, questions: Question[]): ManyDecision {
    const { slip } = (seats[p] as AutoSeat).auto;
    const rng = slipRng[p];
    const answers: ManyDecision["answers"] = {};
    for (const q of questions) {
      const ids = Object.keys(q.choices);
      const pick = rng.next() < slip && ids.length > 1 ? rng.pick(ids.filter((id) => id !== q.recommended)) : q.recommended;
      answers[q.key] = { choice: pick, confidence: 1 };
    }
    return { answers, inputTokens: 0, outputTokens: 0 };
  }

  async function ask(p: number, turn: number, questions: Question[]): Promise<Answer> {
    const seat = seats[p];
    if (isAuto(seat)) {
      await clock.sleep(seat.auto.delayMs, stop.signal);
      record({ type: "answered", t: elapsed(), turn, player: p, questions: questions.length });
      return { decision: autoAnswer(p, questions) };
    }
    const call = new AbortController();
    const cancel = () => call.abort(stop.signal.reason);
    stop.signal.addEventListener("abort", cancel, { once: true });
    let rateLimited = false;
    rateWatchers.set(p, () => (rateLimited = true));
    const specs = Object.fromEntries(questions.map((q) => [q.key, { instructions: q.instructions, choices: q.choices }]));
    const answer = askMany(agents[p]!, describeState(map, state, p, size, last), specs, { signal: call.signal }).then(
      (decision) => ({ decision }),
      (error: unknown) => ({ error }),
    );
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
      record({ type: "answered", t: elapsed(), turn, player: p, questions: questions.length });
      return res;
    } finally {
      rateWatchers.delete(p);
      stop.signal.removeEventListener("abort", cancel);
    }
  }

  try {
    record({ type: "start", t: 0, seed, size, turns: SIZES[size].turns, players: state.players.map(({ id, name }) => ({ id, name })), snapshot: snapshot(state) });

    for (;;) {
      if (stop.signal.aborted) throw stop.signal.reason;
      const turn = state.turn + 1;
      const alive = state.players.flatMap((pl, p) => (pl.alive ? [p] : []));
      const asked = new Map(alive.map((p) => [p, questionsFor(map, state, p, size)]));
      const callers = alive.filter((p) => asked.get(p)!.questions.length > 0);
      const settled = await Promise.allSettled(callers.map((p) => ask(p, turn, asked.get(p)!.questions)));
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) {
        stop.abort(failed.reason);
        throw failed.reason;
      }

      const orders: (Orders | null)[] = state.players.map(() => null);
      const decisions: Decision[] = [];
      const dropped: number[] = [];
      for (const p of alive) {
        const { questions, auto } = asked.get(p)!;
        const k = callers.indexOf(p);
        const res = k >= 0 ? (settled[k] as PromiseFulfilledResult<Answer>).value : null;
        const pl = state.players[p];
        const parts: Orders[] = [auto];
        if (res && "decision" in res) {
          pl.fallbacks = 0;
          tokens.input += res.decision.inputTokens;
          tokens.output += res.decision.outputTokens;
        } else if (res) {
          pl.fallbacks++;
          if (pl.fallbacks >= MAX_FALLBACK_TURNS) dropped.push(p);
        }
        for (const q of questions) {
          const a = res && "decision" in res ? res.decision.answers[q.key] : undefined;
          const valid = !!a && a.choice in q.orders;
          const option = valid ? a!.choice : q.recommended;
          parts.push(q.orders[option]);
          decisions.push({
            player: p,
            key: q.key,
            kind: q.kind,
            choice: a?.choice ?? "",
            option,
            confidence: a?.confidence ?? 0,
            ...(valid
              ? {}
              : { note: !res || "fallback" in res ? (res && "fallback" in res && res.fallback === "timeout" ? "no answer in time" : "provider error") + ", used the default" : "answer outside the options, used the default" }),
          });
        }
        orders[p] = mergeOrders(parts);
      }
      record({ type: "orders", t: elapsed(), turn, decisions, orders });

      const { state: next, report } = resolveTurn(map, state, orders);
      const disconnected: number[] = [];
      for (const p of dropped) {
        if (next.players[p].alive && next.players.filter((pl) => pl.alive).length > 1) {
          disconnect(next, p);
          disconnected.push(p);
        }
      }
      state = next;
      last = report;
      record({ type: "turn", t: elapsed(), turn, report, disconnected, snapshot: snapshot(state) });
      for (const e of report.events) if (e.kind === "eliminated") record({ type: "out", t: elapsed(), turn, player: e.player, reason: state.players[e.player].out! });
      for (const p of disconnected) record({ type: "out", t: elapsed(), turn, player: p, reason: "disconnected" });

      const v = checkVictory(map, state, size);
      if (v) {
        const end: EndEvent = {
          type: "end",
          t: elapsed(),
          winner: v.winner,
          victory: v.kind,
          turns: state.turn,
          standings: standingsOf(state, v.winner),
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
