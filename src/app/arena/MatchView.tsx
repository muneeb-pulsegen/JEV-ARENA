"use client";

import type { CSSProperties, ReactNode } from "react";
import { SIZES } from "@/lib/frontline/config";
import { regionsOf, troopsOf } from "@/lib/frontline/map";
import { income } from "@/lib/frontline/rules";
import { HexBoard } from "./HexBoard";
import { clock, orderText, type FrontlineModel } from "./model";

const playerStyle = (id: string) => ({ "--sc": `var(--seat-${id})` }) as CSSProperties;

/** The map, player cards, round counter and battle feed, shared by the live match and the replay. */
export function MatchView({ model, status, controls }: { model: FrontlineModel; version: number; status: string; controls?: ReactNode }) {
  const { start, map, state, end, feed } = model;
  const alive = state.players.filter((p) => p.alive).length;

  return (
    <div className="match">
      <div className="panel match-bar">
        <div className="match-clock" aria-label="Round">
          <span className="hint">Round </span>
          <b>{model.round}</b>
          <span className="hint"> / {start.rounds}</span>
        </div>
        <div className="hint">
          {SIZES[start.size].label} map · {alive} of {start.players.length} alive · {status}
        </div>
        <div className="match-controls">{controls}</div>
      </div>

      {end && (
        <section className="panel winner" style={playerStyle(start.players[end.winner].id)} aria-live="polite">
          <div className="winner-head">
            <span className="seat-dot big" />
            <div>
              <div className="winner-name">{start.players[end.winner].name} wins</div>
              <div className="hint">
                {end.reason === "last" ? "Last player standing" : "Most regions at the round limit"} · {end.rounds} rounds · {clock(end.durationMs)} ·{" "}
                {(end.tokens.input + end.tokens.output).toLocaleString()} tokens
              </div>
            </div>
          </div>
          <ol className="standings">
            {end.standings.map((s) => (
              <li key={s.player} style={playerStyle(s.id)}>
                <span className="place">{s.place}</span>
                <span className="seat-dot" />
                <b>{s.name}</b>
                <span className="hint">{s.regions} regions</span>
                <span className="hint out">{s.out ? `round ${s.outRound}: ${s.out}` : s.place === 1 ? "winner" : "still standing"}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="match-grid">
        <section className="panel match-board" aria-label="Map">
          <HexBoard map={map} state={state} reveal={model.reveal} report={model.report} label={`Frontline map, round ${model.round}, ${alive} players alive`} />
          <div className="legend hint">
            <span><i className="lg-capital" /> capital</span>
            <span><i className="lg-city" /> city (defends 1.5×, +2 income)</span>
            <span>height and number = troops</span>
          </div>
        </section>
        <aside className="match-side">
          <div className="seat-cards">
            {state.players.map((pl, p) => {
              const last = model.lastOrder[p];
              const won = end?.winner === p;
              return (
                <article key={pl.id} className={`seat-card${pl.alive ? "" : " out"}${won ? " won" : ""}`} style={playerStyle(pl.id)}>
                  <header>
                    <span className="seat-dot" />
                    <b>{pl.name}</b>
                    <span className={`pill${pl.alive ? " live" : ""}`}>{won ? "winner" : pl.alive ? "alive" : "out"}</span>
                  </header>
                  <dl>
                    <div><dt>Regions</dt><dd>{regionsOf(state, p)}</dd></div>
                    <div><dt>Troops</dt><dd>{troopsOf(state, p)}</dd></div>
                    <div><dt>Income</dt><dd>{pl.alive ? income(map, state, p) : "–"}</dd></div>
                  </dl>
                  <div className="seat-last">
                    {!pl.alive ? (
                      <span className="no">{pl.out}</span>
                    ) : model.waiting[p] ? (
                      <span className="warn-text">{model.waiting[p]}</span>
                    ) : !end && model.locked.has(p) ? (
                      <span className="ok">order locked ✓</span>
                    ) : last && (model.reveal || end || !model.locked.size) ? (
                      <>
                        <span>{orderText(map, last.order)}</span>
                        {last.option && <span className="hint">{last.option} · {Math.round(last.confidence * 100)}%</span>}
                        {last.note && <span className="pill warn">{last.note}</span>}
                      </>
                    ) : (
                      <span className="hint">{end ? "" : "thinking…"}</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <section className="panel feed" aria-label="Battle feed">
            <div className="feed-title">Battles</div>
            {feed.length === 0 ? (
              <div className="hint">Captures, clashes and knockouts will show here.</div>
            ) : (
              <ul>
                {feed.map((f) => (
                  <li key={f.key} className={f.tone} style={f.player !== undefined ? playerStyle(start.players[f.player].id) : undefined}>
                    <span className="feed-t">R{f.round}</span> {f.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
