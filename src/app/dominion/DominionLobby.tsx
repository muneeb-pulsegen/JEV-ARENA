"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { defaultSize, estimateMatch, MAX_PLAYERS, MIN_PLAYERS, PLAYERS, SIZE_IDS, SIZES, type SizeId } from "@/lib/dominion/config";
import type { MatchEvent } from "@/lib/dominion/match";
import { DominionView } from "./DominionView";
import { beatMs, DominionModel } from "./model";

type ProviderMeta = { id: string; label: string; serverKey: boolean };

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.max(1, Math.round(n / 1000))}k`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function DominionLobby({ providers }: { providers: ProviderMeta[] }) {
  const router = useRouter();
  const jevReady = providers.some((p) => p.id === "jev" && p.serverKey);
  const [provider, setProvider] = useState(jevReady ? "jev" : "demo");
  const [apiKey, setApiKey] = useState("");
  const [players, setPlayers] = useState(4);
  const [size, setSize] = useState<SizeId>(defaultSize(4));
  const [sizeTouched, setSizeTouched] = useState(false);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [model, setModel] = useState<DominionModel | null>(null);
  const [, setVersion] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const queue = useRef<MatchEvent[]>([]);
  const pumping = useRef<Promise<void> | null>(null);
  const modelRef = useRef<DominionModel | null>(null);

  const meta = providers.find((p) => p.id === provider)!;
  const running = phase === "running";
  const canStart = !running && (provider === "demo" || apiKey.trim() || meta.serverKey);
  const est = estimateMatch(players, size);

  const changePlayers = (n: number) => {
    const next = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, n));
    setPlayers(next);
    if (!sizeTouched) setSize(defaultSize(next));
  };

  /** Shows queued events one at a time, holding reveals and results on screen as beats; catches up when behind. */
  const pump = () => {
    if (pumping.current) return pumping.current;
    const run = (async () => {
      while (queue.current.length) {
        const e = queue.current.shift()!;
        modelRef.current?.apply(e);
        setVersion((v) => v + 1);
        const hold = beatMs(e);
        if (hold) await sleep(hold / (1 + queue.current.length / 4));
      }
    })();
    // Cleared asynchronously, so it can't be cleared before it has been set.
    pumping.current = run.finally(() => (pumping.current = null));
    return pumping.current;
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
      const res = await fetch("/api/dominion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey, seats: players, size }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let saved: string | null = null;
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
            const m = new DominionModel(e);
            modelRef.current = m;
            setModel(m);
          } else if (e.type === "saved") saved = e.id;
          else if (e.type === "error") throw new Error(e.message);
          else {
            queue.current.push(e);
            pump();
          }
        }
      }
      if (!saved) throw new Error("The connection closed before the match finished.");
      await pump();
      setSavedId(saved);
      setPhase("done");
      router.refresh();
    } catch (e) {
      queue.current = [];
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
            <span className="field-label" id="players-label">Players</span>
            <div className="stepper" role="group" aria-labelledby="players-label">
              <button onClick={() => changePlayers(players - 1)} disabled={running || players <= MIN_PLAYERS} aria-label="Fewer players">−</button>
              <output aria-live="polite">{players}</output>
              <button onClick={() => changePlayers(players + 1)} disabled={running || players >= MAX_PLAYERS} aria-label="More players">+</button>
              <span className="stepper-dots" aria-hidden>
                {PLAYERS.slice(0, players).map((p) => <i key={p.id} style={{ background: `var(--seat-${p.id})` }} />)}
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
                  {SIZES[id].label} · {SIZES[id].turns} turns
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
            ? `Built-in AI in every seat, free · up to ${SIZES[size].turns} turns`
            : `${players} JEV agents on one key · one call per player per turn, about ${est.calls} calls · about ${tokens(est.tokens)} tokens at most`}
        </div>
        {error && <div className={`alert ${phase === "error" ? "error" : "info"}`} role="alert">{error}</div>}
        {savedId && (
          <div className="alert info">
            Saved to the match history. <Link href={`/dominion/${savedId}`}>Watch the replay →</Link>
          </div>
        )}
      </section>

      {model && <DominionView model={model} version={model.applied} status={status} />}
    </>
  );
}
