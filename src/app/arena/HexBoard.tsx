"use client";

import { useMemo, type CSSProperties } from "react";
import { capitalOf, NEUTRAL, type GameMap, type State } from "@/lib/frontline/map";
import type { RevealedOrder } from "@/lib/frontline/match";
import { reinforcement, type Report } from "@/lib/frontline/rules";

const S = 24;
/** Vertical squash that tilts the flat hex map into 2.5D. */
const TILT = 0.62;
const SQRT3 = Math.sqrt(3);

const centre = (m: GameMap, i: number) => ({ x: S * SQRT3 * (m.q[i] + m.r[i] / 2), y: S * 1.5 * m.r[i] * TILT });
const corner = (x: number, y: number, k: number) => {
  const a = ((60 * k - 30) * Math.PI) / 180;
  return [x + S * 0.94 * Math.cos(a), y + S * 0.94 * Math.sin(a) * TILT] as const;
};
/** Prism height grows with troops but is capped low, so big stacks don't hide the hexes behind them. */
const height = (troops: number) => 4 + Math.min(troops, 40) * 0.45;
const pts = (p: (readonly [number, number])[]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const playerStyle = (id: string) => ({ "--sc": `var(--seat-${id})` }) as CSSProperties;

/** The near-facing sides of a raised hex, by corner pairs, from left to right. */
const SIDES: [number, number, string][] = [[3, 4, "s-l"], [2, 3, "s-bl"], [1, 2, "s-br"], [0, 1, "s-r"]];

function Hex({ m, s, i, flash }: { m: GameMap; s: State; i: number; flash?: "took" | "held" }) {
  const { x, y } = centre(m, i);
  if (m.lake[i]) {
    const c = Array.from({ length: 6 }, (_, k) => corner(x, y + 2, k));
    return <polygon className="hx-lake" points={pts(c)} />;
  }
  const o = s.owner[i];
  const h = height(s.troops[i]);
  const base = Array.from({ length: 6 }, (_, k) => corner(x, y, k));
  const top = base.map(([cx, cy]) => [cx, cy - h] as const);
  const cap = capitalOf(m, i);
  const isCapital = cap >= 0 && o === cap && s.players[cap]?.alive;
  const id = o === NEUTRAL ? null : s.players[o].id;
  const label = `${m.name[i]} · ${id ? s.players[o].name : "neutral"} · ${s.troops[i]} troops${isCapital ? " · capital" : m.city[i] ? " · city" : ""}`;
  return (
    <g className={`hx${id ? "" : " neutral"}${flash ? ` flash-${flash}` : ""}`} style={id ? playerStyle(id) : undefined}>
      <title>{label}</title>
      {SIDES.map(([a, b, cls]) => (
        <polygon key={cls} className={cls} points={pts([top[a], top[b], base[b], base[a]])} />
      ))}
      <polygon className="hx-top" points={pts(top)} />
      {m.city[i] && !isCapital && (
        <g className="hx-city">
          <rect x={x - 11} y={y - h - 13} width={6} height={9} />
          <polygon points={pts([[x - 12, y - h - 13], [x - 8, y - h - 17], [x - 4, y - h - 13]])} />
        </g>
      )}
      {isCapital && (
        <g className="hx-capital">
          <line x1={x - 9} y1={y - h - 2} x2={x - 9} y2={y - h - 20} />
          <polygon points={pts([[x - 9, y - h - 20], [x + 1, y - h - 16.5], [x - 9, y - h - 13]])} />
        </g>
      )}
      <text className="hx-n" x={x + (isCapital || m.city[i] ? 3 : 0)} y={y - h + 4}>{s.troops[i]}</text>
      {flash === "took" && <polygon className="hx-ring" points={pts(top)} />}
    </g>
  );
}

/**
 * The Frontline map in 2.5D: hex prisms coloured by owner and raised by troop count,
 * with this round's orders drawn as arrows and its battles marked.
 */
export function HexBoard({ map: m, state: s, reveal, report, label }: {
  map: GameMap;
  state: State;
  reveal: RevealedOrder[] | null;
  report: Report | null;
  label: string;
}) {
  const order = useMemo(
    () => m.q.map((_, i) => i).sort((a, b) => centre(m, a).y - centre(m, b).y || centre(m, a).x - centre(m, b).x),
    [m],
  );
  const box = useMemo(() => {
    const cs = m.q.map((_, i) => centre(m, i));
    const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
    const pad = S * 1.2;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad - height(40) - 8, maxY = Math.max(...ys) + pad;
    return { viewBox: `${minX.toFixed(0)} ${minY.toFixed(0)} ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}`, width: maxX - minX };
  }, [m]);

  const flash = new Map<number, "took" | "held">();
  for (const b of report?.battles ?? []) flash.set(b.target, b.captured !== null ? "took" : "held");

  const topOf = (i: number) => {
    const c = centre(m, i);
    return { x: c.x, y: c.y - height(s.troops[i]) };
  };

  return (
    // On narrow screens the map keeps a readable minimum width and scrolls sideways inside its panel.
    <div className="hx-scroll">
    <svg className="hx-board" viewBox={box.viewBox} style={{ maxWidth: box.width * 1.6, minWidth: Math.min(box.width * 1.25, 560) }} role="img" aria-label={label}>
      <defs>
        {s.players.map((pl) => (
          <marker key={pl.id} id={`hx-arrow-${pl.id}`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: `var(--seat-${pl.id})` }} />
          </marker>
        ))}
      </defs>
      <g>{order.map((i) => <Hex key={i} m={m} s={s} i={i} flash={flash.get(i)} />)}</g>
      <g className="hx-orders">
        {reveal?.map((o) => {
          const id = s.players[o.player].id;
          if (o.order.kind === "reinforce") {
            const t = topOf(o.order.at);
            const inc = report?.income[o.player];
            return (
              <text key={o.player} className="hx-plus" style={playerStyle(id)} x={t.x} y={t.y - 12}>
                {inc !== undefined ? `+${reinforcement(inc)}` : "+"}
              </text>
            );
          }
          const a = topOf(o.order.from), b = topOf(o.order.to);
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 14;
          return (
            <path
              key={o.player}
              className="hx-arrow"
              style={playerStyle(id)}
              d={`M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${(a.x + (b.x - a.x) * 0.88).toFixed(1)},${(a.y + (b.y - a.y) * 0.88).toFixed(1)}`}
              markerEnd={`url(#hx-arrow-${id})`}
            />
          );
        })}
        {report?.clashes.map((c, k) => {
          const a = topOf(c.from), b = topOf(c.to);
          const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2 - 10;
          const star = Array.from({ length: 12 }, (_, j) => {
            const r = j % 2 ? 3.5 : 8;
            const t = (j * Math.PI) / 6;
            return [x + r * Math.cos(t), y + r * Math.sin(t)] as const;
          });
          return <polygon key={`c${k}`} className="hx-clash" points={pts(star)} />;
        })}
      </g>
    </svg>
    </div>
  );
}
