import type { Grid } from '../data/types';

export function makeGrid(width: number, height: number, originE: number, originN: number, cell: number, units: string): Grid {
  return { width, height, originE, originN, cell, units, data: new Float32Array(width * height) };
}

/** Bilinear sample at (e, n). Clamped to edges. */
export function sample(g: Grid, e: number, n: number): number {
  const fx = (e - g.originE) / g.cell;
  const fy = (g.originN - n) / g.cell;
  const x0 = Math.max(0, Math.min(g.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(g.height - 1, Math.floor(fy)));
  const x1 = Math.min(g.width - 1, x0 + 1);
  const y1 = Math.min(g.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const d = g.data;
  const w = g.width;
  const a = d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx;
  const b = d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Terrain slope in degrees at (e, n) from an elevation grid (central differences). */
export function slopeDeg(elev: Grid, e: number, n: number): number {
  const h = elev.cell * 0.5;
  const dzdx = (sample(elev, e + h, n) - sample(elev, e - h, n)) / (2 * h);
  const dzdy = (sample(elev, e, n + h) - sample(elev, e, n - h)) / (2 * h);
  return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
}

export function gridExtent(g: Grid) {
  const half = g.cell / 2;
  return {
    minE: g.originE - half,
    maxE: g.originE + (g.width - 1) * g.cell + half,
    maxN: g.originN + half,
    minN: g.originN - (g.height - 1) * g.cell - half,
  };
}

export function gridStats(g: Grid) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of g.data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Derive a slope grid (degrees) from elevation. */
export function slopeGrid(elev: Grid): Grid {
  const out = makeGrid(elev.width, elev.height, elev.originE, elev.originN, elev.cell, 'deg');
  for (let y = 0; y < elev.height; y++) {
    for (let x = 0; x < elev.width; x++) {
      const e = elev.originE + x * elev.cell;
      const n = elev.originN - y * elev.cell;
      out.data[y * elev.width + x] = slopeDeg(elev, e, n);
    }
  }
  return out;
}
