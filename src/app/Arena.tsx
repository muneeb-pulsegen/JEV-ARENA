"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { GameView } from "@/lib/games";
import type { RunEvent } from "@/lib/runner/run";
import { Board, Hearts, Ladder } from "./Boards";

type GameMeta = { id: string; name: string; axis: string; blurb: string; view: GameView };
type ProviderMeta = { id: string; label: string; needsKey: boolean; verified: boolean; serverKey: boolean };

type Turn = Extract<RunEvent, { type: "turn" }>;
type GameState = { status: "pending" | "live" | "done" | "stopped"; score: number; progress: string; view: GameView; turns: Turn[] };
type RunEnd = Extract<RunEvent, { type: "run_end" }>;

const MAX_TURNS_KEPT = 60;

const freshGames = (games: GameMeta[]) =>
  Object.fromEntries(games.map((g) => [g.id, { status: "pending", score: 0, progress: "waiting to start", view: g.view, turns: [] } as GameState]));

export default function Arena({ games, providers, estTokens }: { games: GameMeta[]; providers: ProviderMeta[]; estTokens: number }) {
  const jevReady = providers.some((p) => p.id === "jev" && p.serverKey);
  const [provider, setProvider] = useState(jevReady ? "jev" : "demo");
  const [apiKey, setApiKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [state, setState] = useState<Record<string, GameState>>(() => freshGames(games));
  const [runKey, setRunKey] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<RunEnd | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const meta = providers.find((p) => p.id === provider)!;
  const running = phase === "running";
  const canStart = !running && (provider === "demo" || apiKey.trim() || meta.serverKey);

  const haltLive = () =>
    setState((s) => Object.fromEntries(Object.entries(s).map(([id, g]) => [id, g.status === "live" ? { ...g, status: "stopped" } : g])));

  const apply = (e: RunEvent) => {
    switch (e.type) {
      case "game_start":
        setState((s) => ({ ...s, [e.game]: { ...s[e.game], status: "live", progress: "thinking…", view: e.view } }));
        break;
      case "turn":
        setState((s) => ({
          ...s,
          [e.game]: {
            ...s[e.game],
            score: e.score,
            progress: e.progress,
            view: e.view,
            turns: [...s[e.game].turns, e].slice(-MAX_TURNS_KEPT),
          },
        }));
        break;
      case "game_end":
        setState((s) => ({ ...s, [e.game]: { ...s[e.game], status: "done", score: e.score, progress: e.progress, view: e.view } }));
        break;
      case "retry":
        setNotice(
          e.message.includes("HTTP 429") || e.message.includes("HTTP 529")
            ? `Rate limited, waiting ${Math.round(e.waitMs / 1000)}s before retrying. Waiting doesn't count against any game's clock. (${e.message})`
            : `Provider hiccup, retrying in ${Math.round(e.waitMs / 1000)}s (attempt ${e.attempt}): ${e.message}`,
        );
        break;
      case "run_end":
        setResult(e);
        setNotice("");
        setPhase("done");
        break;
      case "error":
        haltLive();
        setError(e.message);
        setPhase("error");
        break;
    }
  };

  async function start() {
    setError("");
    setNotice("");
    setResult(null);
    setState(freshGames(games));
    setRunKey((k) => k + 1);
    setPhase("running");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey, displayName }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let ended = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!chunk.startsWith("data: ")) continue;
          const ev = JSON.parse(chunk.slice(6)) as RunEvent;
          if (ev.type === "run_end" || ev.type === "error") ended = true;
          apply(ev);
        }
      }
      if (!ended) throw new Error("The connection closed before the run finished.");
    } catch (e) {
      haltLive();
      if (ctrl.signal.aborted) {
        setPhase("idle");
        setNotice("Run stopped. Nothing was ranked.");
      } else {
        setError((e as Error).message);
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <>
      <section className="panel setup" aria-label="Run setup">
        <div className="setup-grid">
          <div className="field">
            <label htmlFor="provider">Provider</label>
            <select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={running}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          {provider !== "demo" && (
            <>
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
              <div className="field">
                <label htmlFor="displayName">Leaderboard name</label>
                <input id="displayName" value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" disabled={running} />
              </div>
            </>
          )}
          <div className="field action">
            {running ? (
              <button className="btn secondary" onClick={() => abortRef.current?.abort()}>Stop run</button>
            ) : (
              <button className="btn" onClick={start} disabled={!canStart}>{phase === "idle" ? "Start the games" : "Run again"}</button>
            )}
          </div>
        </div>
        <div className="estimate">
          {provider === "demo"
            ? "The demo bot is a scripted solver, paced so you can watch. It's free and isn't ranked."
            : (meta.serverKey && !apiKey.trim() ? "Runs on the server's TypeSafe JEV key. " : "Your key is used only for this run and is never stored. ") +
              `A run uses roughly ${Math.round(estTokens / 1000)}k tokens.`}
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert info">{notice}</div>}
      </section>

      {result && (
        <section className="panel result">
          <div>
            <div className="hint">Overall</div>
            <div className="big">{result.overall.toFixed(1)}</div>
          </div>
          <div className="result-scores">
            {games.map((g) => (
              <span key={g.id} style={{ color: `var(--${g.id})` }}>{g.axis} <b>{result.scores[g.id as keyof typeof result.scores]}</b></span>
            ))}
          </div>
          <div className="hint">
            {Math.round(result.durationMs / 1000)}s · {result.tokens.input.toLocaleString()} in / {result.tokens.output.toLocaleString()} out tokens ·{" "}
            {result.saved ? <Link href="/leaderboard">Ranked, see the leaderboard →</Link> : result.note}
          </div>
        </section>
      )}

      <div className="boards">
        {games.map((g) => {
          const s = state[g.id];
          const last = s.turns[s.turns.length - 1];
          return (
            <section key={g.id} className={`board-card ${s.status}`} style={{ ["--c" as string]: `var(--${g.id})` }} aria-label={g.name}>
              <header className="board-head">
                <div>
                  <div className="axis">{g.axis}</div>
                  <div className="name">{g.name}</div>
                  <div className="board-sub">
                    <Ladder steps={s.view.ladder} label={g.id === "dispatch" ? "Tier" : g.id === "mechanism" ? "Vault" : "Level"} />
                    {"lives" in s.view && <Hearts lives={s.view.lives} />}
                  </div>
                </div>
                <div className="board-score">
                  <span className={`pill${s.status === "live" ? " live" : ""}`}>
                    {s.status === "live" ? "playing" : s.status === "pending" ? "ready" : s.status}
                  </span>
                  <span className="score">{s.status === "pending" ? "–" : s.score}</span>
                </div>
              </header>
              <div className="stage">
                <Board key={runKey} view={s.view} />
              </div>
              <footer className="board-foot">
                <div className="said">
                  {last ? (
                    <>
                      <span className="hint">Chose:</span> <code>{last.choice || "(no choice)"}</code>
                      <span className="hint">{Math.round(last.confidence * 100)}% confidence</span>
                      {last.note && <span className="pill warn">{last.note}</span>}
                    </>
                  ) : (
                    <span className="hint">{g.blurb}</span>
                  )}
                </div>
                {s.turns.length > 0 && (
                  <details>
                    <summary>Transcript · {s.progress}</summary>
                    <div className="log">
                      {[...s.turns].reverse().map((t) => (
                        <article className="turn" key={t.turn}>
                          <header>
                            <span>Turn {t.turn}</span>
                            {t.note && <span className="pill warn">{t.note}</span>}
                          </header>
                          <pre>{t.state}</pre>
                          <pre className="reply">{t.choice || "(no choice)"} · {Math.round(t.confidence * 100)}% confidence</pre>
                        </article>
                      ))}
                    </div>
                  </details>
                )}
              </footer>
            </section>
          );
        })}
      </div>
    </>
  );
}
