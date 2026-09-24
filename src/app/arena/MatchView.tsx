"use client";

import type { CSSProperties, ReactNode } from "react";
import { SIZES } from "@/lib/arena/config";
import { ArenaBoard } from "./ArenaBoard";
import { clock, type MatchModel } from "./model";

const seatStyle = (id: string) => ({ "--sc": `var(--seat-${id})` }) as CSSProperties;

/** The board, seat cards, clock and event feed, shared by the live match and the replay. */
export function MatchView({ model, version, elapsed, status, controls }: {
  model: MatchModel;
  version: number;
  elapsed: number;
  status: string;
  controls?: ReactNode;
}) {
  const { start, board, stats, end, feed } = model;
  const alive = board.seats.filter((s) => s.alive).length;
  const shown = Math.min(elapsed, start.timeLimitMs);

  return (
    <div className="match">
      <div className="panel match-bar">
        <div className="match-clock" aria-label="Match clock">
          <b>{clock(end ? end.t : shown)}</b>
          <span className="hint"> / {clock(start.timeLimitMs)}</span>
        </div>
        <div className="hint">
          {SIZES[start.size].label} {start.grid}×{start.grid} · {alive} of {start.seats.length} alive · {status}
        </div>
        <div className="match-controls">{controls}</div>
      </div>

      {end && (
        <section className="panel winner" style={seatStyle(start.seats[end.winner].id)} aria-live="polite">
          <div className="winner-head">
            <span className="seat-dot big" />
            <div>
              <div className="winner-name">{start.seats[end.winner].name} wins</div>
              <div className="hint">
                {end.reason === "last" ? "Last one standing" : "Most cells claimed when time ran out"} · {clock(end.durationMs)} ·{" "}
                {(end.tokens.input + end.tokens.output).toLocaleString()} tokens
              </div>
            </div>
          </div>
          <ol className="standings">
            {end.standings.map((s) => (
              <li key={s.seat} style={seatStyle(s.id)}>
                <span className="place">{s.place}</span>
                <span className="seat-dot" />
                <b>{s.name}</b>
                <span className="hint">{s.cells} cells</span>
                <span className="hint out">{s.out ?? (s.place === 1 ? "winner" : "still alive")}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="match-grid">
        <section className="panel match-board" aria-label="Arena">
          <ArenaBoard board={board} version={version} label={`Live Arena, ${alive} of ${start.seats.length} players alive`} />
        </section>
        <aside className="match-side">
          <div className="seat-cards">
            {board.seats.map((s, i) => {
              const st = stats[i];
              const rate = st.lastMoveT ? (s.moves / (st.lastMoveT / 1000)).toFixed(1) : "–";
              return (
                <article key={s.id} className={`seat-card${s.alive ? "" : " out"}${end?.winner === i ? " won" : ""}`} style={seatStyle(s.id)}>
                  <header>
                    <span className="seat-dot" />
                    <b>{s.name}</b>
                    <span className={`pill${s.alive ? " live" : ""}`}>{end?.winner === i ? "winner" : s.alive ? "alive" : "out"}</span>
                  </header>
                  <dl>
                    <div><dt>Cells</dt><dd>{s.cells}</dd></div>
                    <div><dt>Moves</dt><dd>{s.moves}</dd></div>
                    <div><dt>Moves/s</dt><dd>{rate}</dd></div>
                  </dl>
                  <div className="seat-last">
                    {!s.alive ? (
                      <span className="no">{s.out}</span>
                    ) : st.waiting ? (
                      <span className="warn-text">{st.waiting}</span>
                    ) : st.choice !== undefined ? (
                      <>
                        <span className="hint">Chose</span> <code>{st.choice || "(none)"}</code>{" "}
                        <span className="hint">{Math.round((st.confidence ?? 0) * 100)}%</span>
                        {st.note && <span className="pill warn">{st.note}</span>}
                      </>
                    ) : (
                      <span className="hint">thinking…</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <section className="panel feed" aria-label="Event feed">
            <div className="feed-title">Events</div>
            {feed.length === 0 ? (
              <div className="hint">Crashes and retries will show here.</div>
            ) : (
              <ul>
                {feed.map((f) => (
                  <li key={f.key} className={f.tone} style={f.seat !== undefined ? seatStyle(start.seats[f.seat].id) : undefined}>
                    <span className="feed-t">{clock(f.t)}</span> {f.text}
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
