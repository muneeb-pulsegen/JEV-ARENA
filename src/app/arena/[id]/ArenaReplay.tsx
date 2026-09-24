"use client";

import { useEffect, useRef, useState } from "react";
import type { MatchEvent } from "@/lib/arena/match";
import { MatchView } from "../MatchView";
import { clock, MatchModel, type EndEvent, type StartEvent } from "../model";

const SPEEDS = [1, 2, 4] as const;

/** Plays a saved match log back through the same view as a live match. */
export default function ArenaReplay({ log }: { log: MatchEvent[] }) {
  const start = log.find((e): e is StartEvent => e.type === "start")!;
  const end = log.find((e): e is EndEvent => e.type === "end");
  const duration = end?.t ?? Math.max(0, ...log.map((e) => ("t" in e ? e.t : 0)));

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [model, setModel] = useState(() => new MatchModel(start));
  const [version, setVersion] = useState(0);
  const cursor = useRef(0);
  const shown = useRef({ model, t: 0 });

  // Move the model to time `t`: forwards by applying new events, backwards by rebuilding.
  useEffect(() => {
    let m = shown.current.model;
    if (t < shown.current.t) {
      m = new MatchModel(start);
      cursor.current = 0;
      setModel(m);
    }
    const events = log.filter((e) => e.type !== "start");
    let changed = false;
    while (cursor.current < events.length) {
      const e = events[cursor.current];
      if ("t" in e && e.t > t) break;
      m.apply(e);
      cursor.current++;
      changed = true;
    }
    shown.current = { model: m, t };
    if (changed || m !== model) setVersion((v) => v + 1);
  }, [t, log, start, model]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setT((cur) => {
        const next = Math.min(duration, cur + dt);
        if (next >= duration) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, duration]);

  const toggle = () => {
    if (!playing && t >= duration) setT(0);
    setPlaying((p) => !p);
  };

  const controls = (
    <div className="replay-controls">
      <button className="btn secondary small" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "Pause" : t >= duration ? "Replay" : "Play"}
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
          max={Math.max(1, Math.round(duration))}
          step={50}
          value={Math.round(t)}
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
          aria-label="Timeline"
        />
        <span className="hint">{clock(t)} / {clock(duration)}</span>
      </div>
      <MatchView
        model={model}
        version={version}
        elapsed={t}
        status={playing ? `replaying at ${speed}×` : t >= duration ? "replay finished" : "paused"}
        controls={controls}
      />
    </>
  );
}
