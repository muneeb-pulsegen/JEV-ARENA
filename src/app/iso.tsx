/** Shared 2:1 isometric projection helpers for the 2.5D boards. */

export const TW = 40;
export const TH = 20;

/** Screen position of a cell's floor centre. */
export function project(size: number, i: number) {
  const x = i % size, y = Math.floor(i / size);
  return { x, y, cx: ((x - y) * TW) / 2, cy: ((x + y) * TH) / 2 + TH / 2 };
}

export function diamond(cx: number, cy: number, k = 1, lift = 0) {
  const w = (TW / 2) * k, h = (TH / 2) * k;
  return `${cx},${cy - h - lift} ${cx + w},${cy - lift} ${cx},${cy + h - lift} ${cx - w},${cy - lift}`;
}

export function Block({ cx, cy, k, h, className }: { cx: number; cy: number; k: number; h: number; className: string }) {
  const w = (TW / 2) * k, d = (TH / 2) * k;
  return (
    <g className={className}>
      <polygon className="side-l" points={`${cx - w},${cy} ${cx},${cy + d} ${cx},${cy + d - h} ${cx - w},${cy - h}`} />
      <polygon className="side-r" points={`${cx},${cy + d} ${cx + w},${cy} ${cx + w},${cy - h} ${cx},${cy + d - h}`} />
      <polygon className="top" points={diamond(cx, cy, k, h)} />
    </g>
  );
}
