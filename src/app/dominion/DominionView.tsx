"use client";

import type { CSSProperties, ReactNode } from "react";
import { SIZES, TECHS, WONDERS } from "@/lib/dominion/config";
import { stackStrength } from "@/lib/dominion/combat";
import { economy } from "@/lib/dominion/economy";
import { unitCount, type State } from "@/lib/dominion/state";
import { score } from "@/lib/dominion/victory";
import { DominionMap } from "./DominionMap";
import { clock, decisionText, VICTORY, type DominionModel } from "./model";

const seat = (id: string) => ({ "--sc": `var(--seat-${id})` }) as CSSProperties;

/** The map, civilization cards, turn counter and event feed, shared by the live match and the replay. */
export function DominionView({ model, status, controls }: { model: DominionModel; version: number; status: string; controls?: ReactNode }) {
  const { start, map, end, feed } = model;
  // Snapshots leave out each player's map memory, which none of these read.
  const s = model.state as unknown as State;
  const alive = s.players.filter((p) => p.alive).length;

  return (
    <div className="match">
      <div className="panel match-bar">
        <div className="match-clock" aria-label="Turn">
          <span className="hint">Turn </span>
          <b>{model.turn}</b>
          <span className="hint"> / {start.turns}</span>
        </div>
        <div className="hint">
          {SIZES[start.size].label} world · {alive} of {start.players.length} civilizations · {status}
        </div>
        <div className="match-controls">{controls}</div>
      </div>

      {end && (
        <section className="panel winner" style={seat(start.players[end.winner].id)} aria-live="polite">
          <div className="winner-head">
            <span className="seat-dot big" />
            <div>
              <div className="winner-name">{start.players[end.winner].name} wins</div>
              <div className="hint">
                {VICTORY[end.victory]} · turn {end.turns} · {clock(end.durationMs)} · {(end.tokens.input + end.tokens.output).toLocaleString()} tokens
              </div>
            </div>
          </div>
          <ol className="standings dm-standings">
            {end.standings.map((r) => (
              <li key={r.player} style={seat(r.id)}>
                <span className="place">{r.place}</span>
                <span className="seat-dot" />
                <b>{r.name}</b>
                <span className="hint">score {r.score}</span>
                <span className="hint out">
                  {r.out ? `turn ${r.outTurn}: ${r.out}` : `${r.cities} cities · pop ${r.population} · ${r.techs} techs · ${r.wonders} wonders`}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="match-grid dm-grid">
        <section className="panel match-board" aria-label="World map">
          <DominionMap map={map} state={model.state} report={model.report} label={`Dominion world, turn ${model.turn}`} />
          <div className="legend hint">
            <span>W wheat · H horses · I iron · G gold · M marble</span>
            <span>flag = army (number of units)</span>
            <span>ring = walls, double ring = castle</span>
          </div>
        </section>
        <aside className="match-side">
          <div className="civ-cards">
            {s.players.map((pl, p) => {
              const cities = s.cities.filter((c) => c.owner === p);
              const won = end?.winner === p;
              const econ = pl.alive ? economy(map, s, p) : null;
              const army = s.armies[p];
              const recent = model.decisions[p] ?? [];
              return (
                <article key={pl.id} className={`seat-card civ-card${pl.alive ? "" : " out"}${won ? " won" : ""}`} style={seat(pl.id)}>
                  <header>
                    <span className="seat-dot" />
                    <b>{pl.name}</b>
                    <span className="hint">score {score(s, p)}</span>
                    <span className={`pill${pl.alive ? " live" : ""}`}>{won ? "winner" : pl.alive ? (!end && model.answered.has(p) ? "ready ✓" : "alive") : "out"}</span>
                  </header>
                  {pl.alive ? (
                    <>
                      <dl>
                        <div><dt>Cities</dt><dd>{cities.length}</dd></div>
                        <div><dt>Pop</dt><dd>{cities.reduce((n, c) => n + c.pop, 0)}</dd></div>
                        <div><dt>Gold</dt><dd>{Math.floor(pl.gold)}<small>{econ && `${econ.net >= 0 ? "+" : ""}${econ.net}`}</small></dd></div>
                        <div><dt>Science</dt><dd>{econ?.science ?? 0}</dd></div>
                        <div><dt>Army</dt><dd>{army && unitCount(army.units) ? stackStrength(army.units, {}).toFixed(0) : "–"}</dd></div>
                      </dl>
                      <div className="civ-line">
                        <span className="hint">Tech {pl.techs.length}/12</span>{" "}
                        {pl.research ? (
                          <span>
                            {TECHS[pl.research].name} <span className="hint">{pl.progress}/{TECHS[pl.research].cost}</span>
                          </span>
                        ) : (
                          <span className="hint">{pl.techs.length === 12 ? "every tech known" : "choosing…"}</span>
                        )}
                      </div>
                      {pl.wonders.length > 0 && <div className="civ-line wonders">{pl.wonders.map((w) => WONDERS[w].name).join(" · ")}</div>}
                      {model.waiting[p] ? (
                        <div className="civ-line warn-text">{model.waiting[p]}</div>
                      ) : (
                        <ul className="civ-decisions">
                          {recent.slice(0, 3).map((d) => (
                            <li key={d.key} title={d.note ?? `${Math.round(d.confidence * 100)}% confidence`} className={d.note ? "fallback" : ""}>
                              {decisionText(d)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <div className="seat-last"><span className="no">{pl.out}</span></div>
                  )}
                </article>
              );
            })}
          </div>
          <section className="panel feed" aria-label="Chronicle">
            <div className="feed-title">Chronicle</div>
            {feed.length === 0 ? (
              <div className="hint">Cities founded, techs, battles and wonders will show here.</div>
            ) : (
              <ul>
                {feed.map((f) => (
                  <li key={f.key} className={f.tone} style={f.player !== undefined ? seat(start.players[f.player].id) : undefined}>
                    <span className="feed-t">T{f.turn}</span> {f.text}
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
