"use client";

import { memo, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { EMPTY, WALL, type Board } from "@/lib/arena/board";
import { Block, diamond, project, TH, TW } from "../iso";

const FAR_WALL = 14;
const INNER_WALL = 9;
const NEAR_WALL = 4;
const TRAIL_H = 5;

type Zoom = "fit" | 1 | 2;

const seatStyle = (id: string) => ({ "--sc": `var(--seat-${id})` }) as CSSProperties;

/** Floor tiles never change during a match, so they render once. */
const Floor = memo(function Floor({ grid, walls }: { grid: number; walls: string }) {
  const tiles = [];
  for (let i = 0; i < grid * grid; i++) {
    if (walls[i] === "1") continue;
    const { cx, cy } = project(grid, i);
    tiles.push(<polygon key={i} points={diamond(cx, cy)} />);
  }
  return <g className="ab-floor">{tiles}</g>;
});

type CellKind = "wall" | "trail" | "head" | "dead";

/** One raised cell. Memoized so only cells whose contents changed re-render. */
const Cell = memo(function Cell({ grid, i, kind, seatId }: { grid: number; i: number; kind: CellKind; seatId?: string }) {
  const { x, y, cx, cy } = project(grid, i);
  if (kind === "wall") {
    const h = x === 0 || y === 0 ? FAR_WALL : x === grid - 1 || y === grid - 1 ? NEAR_WALL : INNER_WALL;
    return <Block cx={cx} cy={cy} k={1} h={h} className="iso-wall" />;
  }
  const trail = <Block cx={cx} cy={cy} k={0.86} h={TRAIL_H} className="ab-trail" />;
  if (kind === "trail") return <g style={seatStyle(seatId!)}>{trail}</g>;
  if (kind === "dead") {
    return (
      <g style={seatStyle(seatId!)} className="ab-dead">
        {trail}
        <polygon className="ab-burst" points={burst(cx, cy - TRAIL_H - 4)} />
      </g>
    );
  }
  return (
    <g style={seatStyle(seatId!)} className="ab-head">
      {trail}
      <ellipse className="shadow" cx={cx} cy={cy - TRAIL_H} rx={8} ry={4} />
      <circle cx={cx} cy={cy - TRAIL_H - 8} r={7.5} />
      <circle className="ab-shine" cx={cx - 2.5} cy={cy - TRAIL_H - 10.5} r={2.4} />
    </g>
  );
});

function burst(cx: number, cy: number) {
  const pts = [];
  for (let k = 0; k < 16; k++) {
    const r = k % 2 ? 4 : 10;
    const a = (k * Math.PI) / 8;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a) * 0.7).toFixed(1)}`);
  }
  return pts.join(" ");
}

/**
 * The shared 2.5D arena. `version` changes whenever the (mutable) board does.
 * Cells are drawn back to front so nearer blocks overlap farther ones.
 */
export function ArenaBoard({ board, version, label }: { board: Board; version: number; label: string }) {
  const { grid } = board;
  const [zoom, setZoom] = useState<Zoom>("fit");
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const walls = useMemo(() => Array.from(board.occ, (v) => (v === WALL ? "1" : "0")).join(""), [board]);
  const order = useMemo(() => {
    const idx = Array.from({ length: grid * grid }, (_, i) => i);
    return idx.sort((a, b) => (a % grid) + Math.floor(a / grid) - ((b % grid) + Math.floor(b / grid)) || a - b);
  }, [grid]);

  const cells = useMemo(() => {
    const heads = new Map(board.seats.map((s) => [s.pos, s]));
    const out = [];
    for (const i of order) {
      const o = board.occ[i];
      if (o === EMPTY) continue;
      if (o === WALL) {
        out.push(<Cell key={i} grid={grid} i={i} kind="wall" />);
        continue;
      }
      const head = heads.get(i);
      const kind: CellKind = head ? (head.alive ? "head" : "dead") : "trail";
      out.push(<Cell key={i} grid={grid} i={i} kind={kind} seatId={board.seats[o].id} />);
    }
    return out;
    // `version` stands in for the board's contents, which mutate in place.
  }, [board, order, version]);

  const pad = 6;
  const width = grid * TW + pad * 2;
  const viewBox = `${-(grid * TW) / 2 - pad} ${-FAR_WALL - pad} ${width} ${grid * TH + FAR_WALL + pad * 2}`;
  const svgStyle: CSSProperties = zoom === "fit" ? { width: "100%" } : { width: width * zoom, maxWidth: "none" };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (zoom === "fit" || !scroller.current) return;
    drag.current = { x: e.clientX, y: e.clientY, left: scroller.current.scrollLeft, top: scroller.current.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !scroller.current) return;
    scroller.current.scrollLeft = d.left - (e.clientX - d.x);
    scroller.current.scrollTop = d.top - (e.clientY - d.y);
  };

  return (
    <div className="ab">
      <div className="ab-zoom" role="group" aria-label="Zoom">
        {(["fit", 1, 2] as Zoom[]).map((z) => (
          <button key={z} className={zoom === z ? "on" : ""} aria-pressed={zoom === z} onClick={() => setZoom(z)}>
            {z === "fit" ? "Fit" : `${z}×`}
          </button>
        ))}
      </div>
      <div
        ref={scroller}
        className={`ab-scroll${zoom === "fit" ? "" : " pannable"}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <svg className="ab-svg" viewBox={viewBox} style={svgStyle} role="img" aria-label={label}>
          <Floor grid={grid} walls={walls} />
          <g>{cells}</g>
        </svg>
      </div>
    </div>
  );
}
