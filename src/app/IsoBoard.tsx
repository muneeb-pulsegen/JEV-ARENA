"use client";

import { useId, type ReactNode } from "react";
import { Block, diamond, project, TH, TW } from "./iso";

const FAR_WALL = 14;
const INNER_WALL = 9;
const NEAR_WALL = 4;
const BOX_H = 11;

type Props = {
  size: number;
  walls: boolean[];
  player: number;
  targets?: number[];
  boxes?: number[];
  holes?: boolean[];
  goal?: number;
  label: string;
};

/** Isometric (2.5D) rendering of a square grid board: floor, raised walls, boxes, and the player. */
export function IsoBoard({ size, walls, player, targets = [], boxes = [], holes, goal, label }: Props) {
  const gid = useId().replace(/:/g, "");
  const floor: ReactNode[] = [];
  const objects: { depth: number; node: ReactNode }[] = [];
  const add = (x: number, y: number, order: number, node: ReactNode) => objects.push({ depth: (x + y) * 10 + order, node });

  for (let i = 0; i < size * size; i++) {
    const { x, y, cx, cy } = project(size, i);
    if (walls[i]) {
      const far = x === 0 || y === 0, near = x === size - 1 || y === size - 1;
      const h = far ? FAR_WALL : near ? NEAR_WALL : INNER_WALL;
      add(x, y, 0, <Block key={`w${i}`} cx={cx} cy={cy} k={1} h={h} className="iso-wall" />);
      continue;
    }
    const hole = holes?.[i];
    floor.push(<polygon key={`f${i}`} className={hole ? "iso-floor hazard" : "iso-floor"} points={diamond(cx, cy)} />);
    if (hole) floor.push(<polygon key={`p${i}`} className="iso-pit" points={diamond(cx, cy, 0.58)} />);
    if (targets.includes(i)) floor.push(<polygon key={`t${i}`} className="iso-target" points={diamond(cx, cy, 0.58)} />);
    if (goal === i) {
      floor.push(<polygon key={`g${i}`} className="iso-goal-ring" points={diamond(cx, cy, 0.62)} />);
      add(x, y, 1, (
        <g key={`gb${i}`} className="iso-goal">
          <rect x={cx - 2.5} y={cy - 34} width={5} height={34} rx={2.5} />
          <polygon points={diamond(cx, cy, 0.28, 36)} />
        </g>
      ));
    }
  }

  boxes.forEach((b, n) => {
    const { x, y, cx, cy } = project(size, b);
    const home = targets.includes(b);
    add(x, y, 2, <Block key={`b${n}`} cx={cx} cy={cy + 1} k={0.66} h={BOX_H} className={home ? "iso-box home" : "iso-box"} />);
  });

  {
    const { x, y, cx, cy } = project(size, player);
    add(x, y, 3, (
      <g key="player" className="iso-player">
        <ellipse className="shadow" cx={cx} cy={cy} rx={9} ry={4.5} />
        <circle cx={cx} cy={cy - 9} r={7.5} fill={`url(#${gid})`} />
      </g>
    ));
  }

  objects.sort((a, b) => a.depth - b.depth);
  const pad = 4;
  const viewBox = `${-(size * TW) / 2 - pad} ${-FAR_WALL - pad} ${size * TW + pad * 2} ${size * TH + FAR_WALL + pad * 2}`;

  return (
    <svg className="iso-board" viewBox={viewBox} style={{ maxWidth: size * 52 }} role="img" aria-label={label}>
      <defs>
        <radialGradient id={gid} cx="35%" cy="30%" r="75%">
          <stop offset="0" className="iso-player-hi" />
          <stop offset="1" className="iso-player-lo" />
        </radialGradient>
      </defs>
      <g>{floor}</g>
      <g>{objects.map((o) => o.node)}</g>
    </svg>
  );
}
