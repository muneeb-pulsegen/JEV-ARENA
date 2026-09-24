"use client";

import { useEffect, useRef, useState } from "react";
import type { MatchEvent } from "@/lib/frontline/match";
import { MatchView } from "../MatchView";
import { beatMs, FrontlineModel, type StartEvent } from "../model";

const SPEEDS = [1, 2, 4] as const;

/** Model after applying the first `n` events of the log (after the start event). */
function modelAt(start: StartEvent, events: MatchEvent[], n: number) {
  const m = new FrontlineModel(start);
  for (let k = 0; k < n; k++) m.apply(events[k]);
  return m;
}

/** Plays a saved match back through the same view as a live match, round by round. */
export default function FrontlineReplay({ log }: { log: MatchEvent[] }) {
  const start = log.find((e): e is StartEvent => e.type === "start")!;
  const events = log.filter((e) => e.type !== "start" && e.type !== "retry");
  // Index just past each round's last event, so the slider can jump to the end of any round.
  const roundEnds = events.flatMap((e, k) => (e.type === "round" ? [k + 1] : []));
  const total = roundEnds.length;

  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [model, setModel] = useState(() => new FrontlineModel(start));
  const [version, setVersion] = useState(0);
  const shown = useRef(0);

  useEffect(() => {
    // Forwards applies the new events to the live model; backwards rebuilds it from the start.
    if (cursor < shown.current) setModel(modelAt(start, events, cursor));
    else for (let k = shown.current; k < cursor; k++) model.apply(events[k]);
    shown.current = cursor;
    setVersion((v) => v + 1);
    // `start` and `events` come from the saved log, which never changes.
  }, [cursor]);

  useEffect(() => {
    if (!playing) return;
    if (cursor >= events.length) {
      setPlaying(false);
      return;
    }
    const hold = cursor === 0 ? 400 : Math.max(60, beatMs(events[cursor - 1]) || 80);
    const t = setTimeout(() => setCursor((c) => c + 1), hold / speed);
    return () => clearTimeout(t);
  }, [playing, cursor, speed, events]);

  const round = roundEnds.filter((k) => k <= cursor).length;
  const done = cursor >= events.length;

  const controls = (
    <div className="replay-controls">
      <button
        className="btn secondary small"
        onClick={() => {
          if (!playing && done) setCursor(0);
          setPlaying((p) => !p);
        }}
      >
        {playing ? "Pause" : done ? "Replay" : "Play"}
      </button>
      <div className="seg" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button key={s} className={speed === s ? "on" : ""} aria-pressed={speed === s} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div className="panel timeline">
        <input
          type="range"
          min={0}
          max={total}
          step={1}
          value={round}
          onChange={(e) => {
            setPlaying(false);
            const r = Number(e.target.value);
            setCursor(r === 0 ? 0 : r === total ? events.length : roundEnds[r - 1]);
          }}
          aria-label="Round"
        />
        <span className="hint">round {round} / {total}</span>
      </div>
      <MatchView
        model={model}
        version={version}
        status={playing ? `replaying at ${speed}×` : done ? "replay finished" : "paused"}
        controls={controls}
      />
    </>
  );
}
