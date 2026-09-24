"use client";

import { memo, useMemo, type CSSProperties } from "react";
import type { Terrain } from "@/lib/dominion/config";
import { describeStack, stackStrength } from "@/lib/dominion/combat";
import type { GameMap } from "@/lib/dominion/map";
import type { Snapshot } from "@/lib/dominion/match";
import { unitCount } from "@/lib/dominion/state";
import type { TurnReport } from "@/lib/dominion/turn";

const S = 22;
const TILT = 0.62;
const SQRT3 = Math.sqrt(3);
/** How far each terrain rises above the base, in screen pixels. */
const RISE: Record<Terrain, number> = { lake: 0, grassland: 3, plains: 3, desert: 3, forest: 4, hills: 8, mountain: 8 };
const RES_LETTER = { wheat: "W", horses: "H", iron: "I", gold: "G", marble: "M" } as const;

const centre = (m: GameMap, i: number) => ({ x: S * SQRT3 * (m.q[i] + m.r[i] / 2), y: S * 1.5 * m.r[i] * TILT });
const corner = (x: number, y: number, k: number, scale = 1) => {
  const a = ((60 * k - 30) * Math.PI) / 180;
  return [x + S * scale * Math.cos(a), y + S * scale * Math.sin(a) * TILT] as const;
};
const pts = (p: (readonly [number, number])[]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const seat = (id: string) => ({ "--sc": `var(--seat-${id})` }) as CSSProperties;
/** The axial neighbour across the edge between corner k and corner k + 1 (pointy-top, y down). */
const EDGE_DIR: [number, number][] = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const SIDES: [number, number, string][] = [[3, 4, "s-l"], [2, 3, "s-bl"], [1, 2, "s-br"], [0, 1, "s-r"]];

/** The terrain never changes during a match, so it renders once. */
const Terrain = memo(function Terrain({ m }: { m: GameMap }) {
  const order = m.q.map((_, i) => i).sort((a, b) => centre(m, a).y - centre(m, b).y || centre(m, a).x - centre(m, b).x);
  return (
    <g>
      {order.map((i) => {
        const { x, y } = centre(m, i);
        const t = m.terrain[i];
        const h = RISE[t];
        const base = Array.from({ length: 6 }, (_, k) => corner(x, y, k, 0.97));
        const top = base.map(([cx, cy]) => [cx, cy - h] as const);
        const res = m.resource[i];
        return (
          <g key={i} className={`dm-hex t-${t}`}>
            <title>{`${m.name[i]} · ${t}${res ? ` · ${res}` : ""}`}</title>
            {h > 0 && SIDES.map(([a, b, cls]) => <polygon key={cls} className={cls} points={pts([top[a], top[b], base[b], base[a]])} />)}
            <polygon className="top" points={pts(top)} />
            {t === "mountain" && <polygon className="dm-peak" points={pts([[x - 9, y - h + 3], [x, y - h - 13], [x + 9, y - h + 3]])} />}
            {t === "forest" && (
              <g className="dm-trees">
                <polygon points={pts([[x - 9, y - h + 2], [x - 5, y - h - 8], [x - 1, y - h + 2]])} />
                <polygon points={pts([[x + 1, y - h + 1], [x + 5, y - h - 9], [x + 9, y - h + 1]])} />
              </g>
            )}
            {res && <text className={`dm-res r-${res}`} x={x + 9} y={y - h + 6}>{RES_LETTER[res]}</text>}
          </g>
        );
      })}
    </g>
  );
});

/**
 * The Dominion world in 2.5D: terrain, each player's land tinted and outlined in
 * its colour, cities with population and walls, armies with their size, settlers,
 * and this turn's battles.
 */
export function DominionMap({ map: m, state: s, report, label }: { map: GameMap; state: Snapshot; report: TurnReport | null; label: string }) {
  const box = useMemo(() => {
    const cs = m.q.map((_, i) => centre(m, i));
    const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
    const pad = S * 1.3;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad - 24, maxY = Math.max(...ys) + pad;
    return { viewBox: `${minX.toFixed(0)} ${minY.toFixed(0)} ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}`, width: maxX - minX };
  }, [m]);
  const lift = (i: number) => {
    const c = centre(m, i);
    return { x: c.x, y: c.y - RISE[m.terrain[i]] };
  };

  // Territory: a tinted top on every owned hex, and an outline only on edges that face another owner.
  const at = useMemo(() => new Map(m.q.map((q, i) => [`${q},${m.r[i]}`, i])), [m]);
  const land = s.owner.flatMap((o, i) => {
    if (o < 0) return [];
    const { x, y } = lift(i);
    const top = Array.from({ length: 6 }, (_, k) => corner(x, y, k, 0.97));
    const edges: string[] = [];
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = EDGE_DIR[k];
      const nb = at.get(`${m.q[i] + dq},${m.r[i] + dr}`);
      if (nb !== undefined && s.owner[nb] === o) continue;
      const a = top[k], b = top[(k + 1) % 6];
      edges.push(`M${a[0].toFixed(1)},${a[1].toFixed(1)}L${b[0].toFixed(1)},${b[1].toFixed(1)}`);
    }
    return [
      <g key={`o${i}`} style={seat(s.players[o].id)}>
        <polygon className="dm-land" points={pts(top)} />
        {edges.length > 0 && <path className="dm-border" d={edges.join("")} />}
      </g>,
    ];
  });

  const fights = new Map<number, boolean>();
  for (const e of report?.events ?? []) if (e.kind === "battle") fights.set(e.hex, true);

  const things = [
    ...s.cities.map((c) => ({ hex: c.hex, order: 0, node: (() => {
      const { x, y } = lift(c.hex);
      const walls = c.buildings.includes("castle") ? "castle" : c.buildings.includes("walls") ? "walls" : "";
      const capital = c.capitalOf === c.owner;
      return (
        <g key={`c${c.id}`} className="dm-city" style={seat(s.players[c.owner].id)}>
          <title>{`${c.name} · ${s.players[c.owner].name} · population ${c.pop}${walls ? ` · ${walls}` : ""} · garrison ${describeStack(c.garrison)}`}</title>
          {walls && <ellipse className={`dm-walls ${walls}`} cx={x} cy={y - 1} rx={15} ry={9} />}
          <rect className="dm-house" x={x - 9} y={y - 13} width={8} height={10} />
          <rect className="dm-house" x={x - 1} y={y - 17} width={9} height={14} />
          {capital && <polygon className="dm-crown" points={pts([[x - 1, y - 22], [x + 2, y - 26], [x + 3.5, y - 22], [x + 5, y - 26], [x + 8, y - 22]])} />}
          <circle className="dm-pop" cx={x + 11} cy={y - 13} r={6} />
          <text className="dm-pop-n" x={x + 11} y={y - 10.5}>{c.pop}</text>
          <text className="dm-name" x={x} y={y + 11}>{c.name}</text>
        </g>
      );
    })() })),
    ...s.settlers.map((st) => ({ hex: st.hex, order: 1, node: (() => {
      const { x, y } = lift(st.hex);
      return (
        <g key={`s${st.id}`} className="dm-settler" style={seat(s.players[st.owner].id)}>
          <title>{`${s.players[st.owner].name}'s settler`}</title>
          <circle cx={x - 8} cy={y - 6} r={4.5} />
          <text x={x - 8} y={y - 4}>S</text>
        </g>
      );
    })() })),
    ...s.armies.flatMap((a, p) => {
      if (!a || !unitCount(a.units)) return [];
      const { x, y } = lift(a.hex);
      const dx = s.cities.some((c) => c.hex === a.hex) ? 12 : 0;
      return [{ hex: a.hex, order: 2, node: (
        <g key={`a${p}`} className={`dm-army${a.fortified ? " fortified" : ""}`} style={seat(s.players[p].id)}>
          <title>{`${s.players[p].name}'s army: ${describeStack(a.units)} · strength ${stackStrength(a.units, {}).toFixed(1)}${a.fortified ? " · fortified" : ""}`}</title>
          <line x1={x - 4 + dx} y1={y - 2} x2={x - 4 + dx} y2={y - 24} />
          <polygon points={pts([[x - 4 + dx, y - 24], [x + 9 + dx, y - 20], [x - 4 + dx, y - 15]])} />
          <circle className="dm-army-n-bg" cx={x + 4 + dx} cy={y - 6} r={6.5} />
          <text className="dm-army-n" x={x + 4 + dx} y={y - 3.5}>{unitCount(a.units)}</text>
        </g>
      ) }];
    }),
  ].sort((a, b) => centre(m, a.hex).y - centre(m, b.hex).y || a.order - b.order);

  return (
    <div className="hx-scroll">
      <svg className="dm-board" viewBox={box.viewBox} style={{ maxWidth: box.width * 1.6, minWidth: Math.min(box.width * 1.3, 620) }} role="img" aria-label={label}>
        <Terrain m={m} />
        <g>{land}</g>
        <g>{things.map((t) => t.node)}</g>
        <g>
          {[...fights.keys()].map((hex) => {
            const { x, y } = lift(hex);
            const star = Array.from({ length: 12 }, (_, j) => {
              const r = j % 2 ? 3.5 : 8.5;
              const t = (j * Math.PI) / 6;
              return [x + r * Math.cos(t), y - 30 + r * Math.sin(t)] as const;
            });
            return <polygon key={`f${hex}`} className="hx-clash" points={pts(star)} />;
          })}
        </g>
      </svg>
    </div>
  );
}
