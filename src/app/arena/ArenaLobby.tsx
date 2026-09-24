"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { defaultSize, estimateMatch, MAX_SEATS, MIN_SEATS, SEATS, SIZE_IDS, SIZES, type SizeId } from "@/lib/arena/config";
import type { MatchEvent } from "@/lib/arena/match";
import { MatchView } from "./MatchView";
import { MatchModel } from "./model";

type ProviderMeta = { id: string; label: string; serverKey: boolean };

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1000))}k`);

export default function ArenaLobby({ providers }: { providers: ProviderMeta[] }) {
  const router = useRouter();
  const jevReady = providers.some((p) => p.id === "jev" && p.serverKey);
  const [provider, setProvider] = useState(jevReady ? "jev" : "demo");
  const [apiKey, setApiKey] = useState("");
  const [seats, setSeats] = useState(4);
  const [size, setSize] = useState<SizeId>(defaultSize(4));
  const [sizeTouched, setSizeTouched] = useState(false);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [model, setModel] = useState<MatchModel | null>(null);
  const [version, setVersion] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const queue = useRef<MatchEvent[]>([]);
  const modelRef = useRef<MatchModel | null>(null);
  const startedAt = useRef(0);

  const meta = providers.find((p) => p.id === provider)!;
  const running = phase === "running";
  const canStart = !running && (provider === "demo" || apiKey.trim() || meta.serverKey);
  const est = estimateMatch(seats, size);

  const changeSeats = (n: number) => {
    const next = Math.min(MAX_SEATS, Math.max(MIN_SEATS, n));
    setSeats(next);
    if (!sizeTouched) setSize(defaultSize(next));
  };

  // Apply streamed events once per animation frame, and tick the clock.
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const frame = () => {
      const m = modelRef.current;
      if (m && queue.current.length) {
        for (const e of queue.current.splice(0)) m.apply(e);
        setVersion((v) => v + 1);
      }
      if (m && !m.end) setElapsed(performance.now() - startedAt.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const flush = () => {
    const m = modelRef.current;
    if (!m) return;
    for (const e of queue.current.splice(0)) m.apply(e);
    setVersion((v) => v + 1);
  };

  async function start() {
    setError("");
    setSavedId(null);
    setModel(null);
    modelRef.current = null;
    queue.current = [];
    setPhase("running");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey, seats, size }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!chunk.startsWith("data: ")) continue;
          const e = JSON.parse(chunk.slice(6)) as MatchEvent;
          if (e.type === "start") {
            const m = new MatchModel(e);
            modelRef.current = m;
            startedAt.current = performance.now();
            setModel(m);
          } else if (e.type === "saved") {
            setSavedId(e.id);
            finished = true;
          } else if (e.type === "error") {
            throw new Error(e.message);
          } else queue.current.push(e);
        }
      }
      if (!finished) throw new Error("The connection closed before the match finished.");
      flush();
      setPhase("done");
      router.refresh();
    } catch (e) {
      flush();
      if (ctrl.signal.aborted) {
        setPhase("idle");
        setError("Match stopped. Nothing was saved.");
      } else {
        setError((e as Error).message);
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  }

  const status = running ? (model ? "live" : "setting up…") : phase === "done" ? "finished" : "stopped";

  return (
    <>
      <section className="panel setup" aria-label="Match setup">
        <div className="setup-grid">
          <div className="field">
            <span className="field-label" id="seats-label">Players</span>
            <div className="stepper" role="group" aria-labelledby="seats-label">
              <button onClick={() => changeSeats(seats - 1)} disabled={running || seats <= MIN_SEATS} aria-label="Fewer players">−</button>
              <output aria-live="polite">{seats}</output>
              <button onClick={() => changeSeats(seats + 1)} disabled={running || seats >= MAX_SEATS} aria-label="More players">+</button>
              <span className="stepper-dots" aria-hidden>
                {SEATS.slice(0, seats).map((s) => <i key={s.id} style={{ background: `var(--seat-${s.id})` }} />)}
              </span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="size">Map size</label>
            <select
              id="size"
              value={size}
              disabled={running}
              onChange={(e) => {
                setSize(e.target.value as SizeId);
                setSizeTouched(true);
              }}
            >
              {SIZE_IDS.map((id) => (
                <option key={id} value={id}>
                  {SIZES[id].label} · {SIZES[id].grid}×{SIZES[id].grid} · {SIZES[id].timeLimitMs / 60_000} min
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="provider">Provider</label>
            <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={running}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          {provider !== "demo" && (
            <div className="field">
              <label htmlFor="apiKey">API key (optional)</label>
              <input
                id="apiKey"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={meta.serverKey ? "Blank uses the server's key" : "apikey_…"}
                disabled={running}
              />
            </div>
          )}
          <div className="field action">
            {running ? (
              <button className="btn secondary" onClick={() => abortRef.current?.abort()}>Stop match</button>
            ) : (
              <button className="btn" onClick={start} disabled={!canStart}>{phase === "idle" ? "Start match" : "New match"}</button>
            )}
          </div>
        </div>
        <div className="estimate">
          {provider === "demo"
            ? `Scripted bots in every seat, free · up to ${est.minutes} min`
            : `${seats} JEV agents on one key · about ${tokens(est.tokens)} tokens · up to ${est.minutes} min`}
        </div>
        {error && <div className={`alert ${phase === "error" ? "error" : "info"}`} role="alert">{error}</div>}
        {savedId && (
          <div className="alert info">
            Saved to the match history. <Link href={`/arena/${savedId}`}>Watch the replay →</Link>
          </div>
        )}
      </section>

      {model && <MatchView model={model} version={version} elapsed={elapsed} status={status} />}
    </>
  );
}
