import type { Clock } from "@/lib/arena/match";

/**
 * Virtual time for match tests. Whenever nothing else is pending, the clock
 * jumps to the next timer, so a 5-minute match runs in milliseconds.
 */
export function createFakeClock() {
  let now = 0;
  let timers: { at: number; seq: number; resolve: () => void }[] = [];
  let seq = 0;
  let running = false;

  const clock: Clock = {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = { at: now + Math.max(0, ms), seq: seq++, resolve };
        timers.push(timer);
        signal?.addEventListener("abort", () => {
          timers = timers.filter((t) => t !== timer);
          reject(signal.reason);
        }, { once: true });
      }),
  };

  const idle = () => new Promise((r) => setImmediate(r));

  /** Runs `p` to completion, advancing virtual time whenever everything else is waiting. */
  async function run<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    const tracked = p.finally(() => (settled = true));
    tracked.catch(() => {});
    running = true;
    try {
      while (!settled) {
        await idle();
        await idle();
        if (settled || !timers.length) continue;
        timers.sort((a, z) => a.at - z.at || a.seq - z.seq);
        const next = timers.shift()!;
        now = next.at;
        next.resolve();
      }
    } finally {
      running = false;
    }
    return tracked;
  }

  return { clock, run, get now() { return now; }, get running() { return running; } };
}
