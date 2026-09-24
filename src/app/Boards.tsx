"use client";

import type { CrateView, GameView, LadderStep, Lives, SignalView, SorterView, TumblerView } from "@/lib/games";
import { IsoBoard } from "./IsoBoard";

export function Ladder({ steps, label }: { steps: LadderStep[]; label: string }) {
  const reached = steps.filter((s) => s === "passed").length;
  return (
    <div className="ladder" aria-label={`${label}: ${reached} of ${steps.length} passed`}>
      {steps.map((s, i) => (
        <span key={i} className={`rung ${s}`} title={`${label} ${i + 1}: ${s}`}>
          {i + 1}
        </span>
      ))}
    </div>
  );
}

export function Hearts({ lives }: { lives: Lives }) {
  return (
    <span className="hearts" aria-label={`${lives.left} of ${lives.max} lives left`} title={`${lives.left} of ${lives.max} lives left`}>
      {Array.from({ length: lives.max }, (_, i) => (
        <span key={i} className={i < lives.left ? "heart" : "heart lost"}>♥</span>
      ))}
    </span>
  );
}

export function Board({ view }: { view: GameView }) {
  switch (view.kind) {
    case "planning":
      return <CrateBoard view={view} />;
    case "routing":
      return <SignalBoard view={view} />;
    case "mechanism":
      return <TumblerBoard view={view} />;
    case "dispatch":
      return <SorterBoard view={view} />;
  }
}

function CrateBoard({ view }: { view: CrateView }) {
  const onTarget = view.boxes.filter((b) => view.targets.includes(b)).length;
  return (
    <div className="crate">
      <div className="code-head">
        <b>Level {view.level}/{view.levels}</b>
        <span className="hint">{view.boxes.length} box{view.boxes.length > 1 ? "es" : ""} · {onTarget} home</span>
        <span className="hint">pushes {view.moves} · optimal {view.par} · push {view.turn}/{view.turns}</span>
      </div>
      <IsoBoard
        size={view.size}
        walls={view.walls}
        targets={view.targets}
        boxes={view.boxes}
        player={view.player}
        label={`Crate Runner level ${view.level}: ${onTarget} of ${view.boxes.length} boxes on targets`}
      />
      <div className={`crate-note ${/solved/.test(view.note) ? "ok" : /no longer be solved|Out of pushes/.test(view.note) ? "no" : "hint"}`}>
        {view.note || "Push every box onto a target."}
      </div>
    </div>
  );
}

function SignalBoard({ view }: { view: SignalView }) {
  return (
    <div className="crate">
      <div className="code-head">
        <b>Level {view.level}/{view.levels}</b>
        <span className="hint">{view.size}×{view.size} grid</span>
        <span className="hint">moves {view.moves} · optimal {view.par} · move {view.turn}/{view.turns}</span>
      </div>
      <IsoBoard
        size={view.size}
        walls={view.walls}
        holes={view.holes}
        goal={view.goal}
        player={view.player}
        label={`Signal Run level ${view.level}: ${view.size} by ${view.size} maze`}
      />
      <div className={`crate-note ${/reached the goal/.test(view.note) ? "ok" : /hazard|Out of moves/.test(view.note) ? "no" : "hint"}`}>
        {view.note || "Reach the goal, avoid the hazards."}
      </div>
    </div>
  );
}

const DIAL_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#3e63dd", "#8e4ec6"];

function TumblerBoard({ view }: { view: TumblerView }) {
  const solved = view.dials.every((d) => d === 0);
  return (
    <div className="code">
      <div className="code-head">
        <b>Vault {view.level}/{view.levels}</b>
        <span className="hint">{view.dials.length} dials mod {view.modulus} · par {view.par}</span>
        <span className="hint">presses {view.presses}/{view.budget}{view.failedAttempts ? ` · attempt ${view.failedAttempts + 1}` : ""}</span>
      </div>
      <div className="dials">
        {view.dials.map((d, i) => (
          <span key={i} className={`dial${d === 0 ? " zero" : ""}`} style={{ borderColor: DIAL_COLORS[i % DIAL_COLORS.length] }}>
            {d}
          </span>
        ))}
      </div>
      <div className="levers">
        {view.levers.map((l) => (
          <div key={l.id} className="lever">
            <span className="lever-id">{l.id}</span>
            <span className="hint">{l.deltas.map((d, i) => (d ? `dial ${i + 1} +${d}` : null)).filter(Boolean).join(", ")}</span>
          </div>
        ))}
      </div>
      <div className={`crate-note ${solved ? "ok" : view.note ? "no" : "hint"}`}>
        {view.note || (solved ? "Vault open." : "Get every dial to 0.")}
      </div>
    </div>
  );
}

function SorterBoard({ view }: { view: SorterView }) {
  const left = view.timeLeftMs;
  const tiers = Array.from({ length: 5 }, (_, t) => view.history.filter((h) => h.tier === t + 1));

  return (
    <div className="relay">
      <div className="relay-clock">
        <div className="relay-time">{(left / 1000).toFixed(1)}s</div>
        <div className="bar thick"><span style={{ width: `${(left / view.budgetMs) * 100}%` }} /></div>
        <div className="relay-points">{view.points} pts</div>
      </div>
      <div className="sorter-rules">
        <span className="hint">
          {view.rules.map((r) => `${r.color}${r.size ? ` ${r.size}` : ""}→${r.gate}${r.exception ? "*" : ""}`).join("  ")}
          {view.tier >= 5 ? `  (shift +${view.rotation})` : ""}
        </span>
      </div>
      <div className="relay-q" aria-live="polite">
        {view.item ? (
          <>
            <span className="hint">Round {view.round} · tier {view.tier} (worth {view.tier})</span>
            <div className="relay-text">{view.item.color}{view.item.size ? ` ${view.item.size}` : ""}</div>
          </>
        ) : (
          <div className="relay-text">{view.timeLeftMs <= 0 ? "Time!" : `All ${view.maxRounds} routed`}</div>
        )}
      </div>
      <div className={`relay-last ${view.last ? (view.last.correct ? "ok" : "no") : ""}`}>
        {view.last
          ? `${view.last.item.color}${view.last.item.size ? ` ${view.last.item.size}` : ""} → ${view.last.answer ?? "?"} ${view.last.correct ? "✓" : `✗ (${view.last.expected})`}`
          : "Waiting for the first item…"}
      </div>
      <div className="relay-tiers">
        {tiers.map((hits, t) => (
          <div key={t} className="relay-tier">
            <span className="hint">T{t + 1}</span>
            <div className="relay-strip">
              {Array.from({ length: 12 }, (_, i) => (
                <i key={i} className={i < hits.length ? (hits[i].correct ? "ok" : "no") : ""} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
