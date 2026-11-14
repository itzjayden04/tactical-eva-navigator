/**
 * LOCAL TERRAIN: what makes the ground real.
 *  - boulders that physically block the astronaut (shared by the sim and the renderer)
 *  - a traversability grid (slope, rock abundance, hazards, boulders, rubble)
 *  - an A* guide path from the astronaut's feet to the route, used for the AR ground arrows
 *
 * Everything is seeded: the same data always gives the same boulders and the same path.
 */
import type { DataBundle, Poi } from '../data/types';
import { sample, slopeDeg } from './grid';
import type { TrackWorld } from './route';

export interface Obstacle {
  e: number;
  n: number;
  /** footprint radius, m */
  r: number;
  /** height, m (jumps clear anything lower than ~0.7 m) */
  h: number;
  kind: 'boulder' | 'rubble';
}

export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

/** Deterministic boulder field: clusters where rock abundance is high, and a few right on the traverses. */
export function makeObstacles(data: DataBundle, world: TrackWorld): Obstacle[] {
  const r = seeded(20261114);
  const out: Obstacle[] = [];
  const nodes = [...world.nodes.values()];
  const clearOfNodes = (e: number, n: number) => nodes.every((nd) => Math.hypot(nd.e - e, nd.n - n) > 28);
  // on / beside the traverses: these are what the guide arrows have to bend around
  for (const g of world.edges.values()) {
    for (let s = 70 + r() * 60; s < g.length - 60; s += 110 + r() * 120) {
      const p = world.pointOnLeg({ edgeId: g.edge.id, forward: true }, s);
      const rock = data.rocks ? sample(data.rocks, p.e, p.n) : 0.2;
      const k = 1 + Math.floor(r() * (1.5 + rock * 3));
      for (let i = 0; i < k; i++) {
        const a = r() * Math.PI * 2;
        const d = i === 0 ? r() * 2.5 : 2 + r() * 9;
        const e = p.e + Math.cos(a) * d;
        const n = p.n + Math.sin(a) * d;
        if (!clearOfNodes(e, n)) continue;
        const rad = 1.1 + r() * 1.9;
        out.push({ e, n, r: rad, h: rad * (0.7 + r() * 0.7), kind: 'boulder' });
      }
    }
  }
  // scattered across the map, weighted by rock abundance
  const g = data.elevation;
  const size = g.cell * (g.width - 1);
  let tries = 0;
  while (out.length < 520 && tries++ < 20000) {
    const e = g.originE + r() * size;
    const n = g.originN - r() * size;
    const rock = data.rocks ? sample(data.rocks, e, n) : 0.2;
    if (r() > rock * 0.9 + 0.04 || !clearOfNodes(e, n)) continue;
    const rad = 0.9 + Math.pow(r(), 2) * 3.2;
    out.push({ e, n, r: rad, h: rad * (0.6 + r() * 0.8), kind: 'boulder' });
  }
  // a few low rocks you can jump over
  for (let i = 0; i < 160; i++) {
    const e = g.originE + r() * size;
    const n = g.originN - r() * size;
    if (!clearOfNodes(e, n)) continue;
    out.push({ e, n, r: 0.5 + r() * 0.4, h: 0.3 + r() * 0.3, kind: 'boulder' });
  }
  return out;
}

/** Spatial hash for fast "what is near me" lookups. */
export class ObstacleIndex {
  private cells = new Map<number, Obstacle[]>();
  private static C = 16;
  constructor(public all: Obstacle[]) {
    for (const o of all) this.insert(o);
  }
  private key(e: number, n: number) {
    return Math.floor(e / ObstacleIndex.C) * 100003 + Math.floor(n / ObstacleIndex.C);
  }
  private insert(o: Obstacle) {
    const k = this.key(o.e, o.n);
    const list = this.cells.get(k);
    if (list) list.push(o);
    else this.cells.set(k, [o]);
  }
  add(o: Obstacle) {
    this.all.push(o);
    this.insert(o);
  }
  near(e: number, n: number, radius = 8): Obstacle[] {
    const out: Obstacle[] = [];
    const C = ObstacleIndex.C;
    for (let x = Math.floor((e - radius) / C); x <= Math.floor((e + radius) / C); x++) {
      for (let y = Math.floor((n - radius) / C); y <= Math.floor((n + radius) / C); y++) {
        const list = this.cells.get(x * 100003 + y);
        if (list) for (const o of list) if (Math.hypot(o.e - e, o.n - n) <= radius + o.r) out.push(o);
      }
    }
    return out;
  }
}

const CELL = 6;
const BLOCK = 1e9;
const MAX_SLOPE = 31;

/** Traversability grid + A*. Cost ≈ relative effort per metre; BLOCK = impassable. */
export class NavGrid {
  readonly cell = CELL;
  readonly w: number;
  readonly h: number;
  private minE: number;
  private maxN: number;
  private base: Float32Array;
  cost: Float32Array;
  /** bumps whenever the grid changes, so cached paths know to refresh */
  version = 0;

  constructor(private data: DataBundle, private world: TrackWorld, private obstacles: ObstacleIndex) {
    const g = data.elevation;
    const size = g.cell * (g.width - 1);
    this.minE = g.originE;
    this.maxN = g.originN;
    this.w = Math.floor(size / CELL);
    this.h = Math.floor(size / CELL);
    this.base = new Float32Array(this.w * this.h);
    this.cost = new Float32Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const { e, n } = this.centre(x, y);
        const sl = slopeDeg(g, e, n);
        const rock = data.rocks ? sample(data.rocks, e, n) : 0.2;
        this.base[y * this.w + x] = sl > MAX_SLOPE ? BLOCK : 1 + Math.pow(sl / 11, 2) + rock * 1.6;
      }
    }
    this.rebuild();
  }

  private centre(x: number, y: number) {
    return { e: this.minE + (x + 0.5) * CELL, n: this.maxN - (y + 0.5) * CELL };
  }
  idx(e: number, n: number) {
    const x = Math.floor((e - this.minE) / CELL);
    const y = Math.floor((this.maxN - n) / CELL);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }
  costAt(e: number, n: number) {
    const i = this.idx(e, n);
    return i < 0 ? BLOCK : this.cost[i];
  }
  blockedAt(e: number, n: number) {
    return this.costAt(e, n) >= BLOCK;
  }

  /** Recompute costs from the base terrain + hazards + traverses + boulders. */
  rebuild(hazards: Poi[] = this.data.pois.filter((p) => p.kind === 'hazard')) {
    this.cost.set(this.base);
    for (const hz of hazards) this.stamp(hz.e, hz.n, hz.radius ?? 100, (c) => (c >= BLOCK ? c : c + 1.4));
    // prepared traverses are the cheapest ground, unless blocked by a rockfall
    for (const g of this.world.edges.values()) {
      if (this.world.blocked.has(g.edge.id)) continue;
      for (const s of g.samples) this.stamp(s.e, s.n, 7, (c) => (c >= BLOCK ? 2.2 : Math.min(c, 0.5 + (c - 1) * 0.12)));
    }
    for (const o of this.obstacles.all) if (o.h > 0.7) this.stamp(o.e, o.n, o.r + 1.2, () => BLOCK);
    this.version++;
  }

  private stamp(e: number, n: number, radius: number, f: (c: number) => number) {
    const x0 = Math.max(0, Math.floor((e - radius - this.minE) / CELL));
    const x1 = Math.min(this.w - 1, Math.floor((e + radius - this.minE) / CELL));
    const y0 = Math.max(0, Math.floor((this.maxN - n - radius) / CELL));
    const y1 = Math.min(this.h - 1, Math.floor((this.maxN - n + radius) / CELL));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const c = this.centre(x, y);
        if (Math.hypot(c.e - e, c.n - n) <= radius + CELL * 0.5) this.cost[y * this.w + x] = f(this.cost[y * this.w + x]);
      }
    }
  }

  /** nearest non-blocked cell index to (e, n) */
  private nearestFree(e: number, n: number) {
    const i = this.idx(e, n);
    if (i >= 0 && this.cost[i] < BLOCK) return i;
    const x0 = Math.floor((e - this.minE) / CELL);
    const y0 = Math.floor((this.maxN - n) / CELL);
    for (let rad = 1; rad < 12; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const x = x0 + dx;
          const y = y0 + dy;
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          if (this.cost[y * this.w + x] < BLOCK) return y * this.w + x;
        }
      }
    }
    return -1;
  }

  /** A* from a to b. Returns a smoothed polyline in world coordinates, or null. */
  path(a: { e: number; n: number }, b: { e: number; n: number }, maxExpand = 60000): [number, number][] | null {
    const start = this.nearestFree(a.e, a.n);
    const goal = this.nearestFree(b.e, b.n);
    if (start < 0 || goal < 0) return null;
    const W = this.w;
    const gx = goal % W;
    const gy = Math.floor(goal / W);
    const gScore = new Map<number, number>([[start, 0]]);
    const came = new Map<number, number>();
    // binary heap of [f, idx]
    const heap: number[] = [];
    const fOf: number[] = [];
    const push = (f: number, i: number) => {
      let k = heap.length;
      heap.push(i);
      fOf.push(f);
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (fOf[p] <= fOf[k]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        [fOf[p], fOf[k]] = [fOf[k], fOf[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const li = heap.pop()!;
      const lf = fOf.pop()!;
      if (heap.length) {
        heap[0] = li;
        fOf[0] = lf;
        let k = 0;
        for (;;) {
          const l = k * 2 + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && fOf[l] < fOf[m]) m = l;
          if (r < heap.length && fOf[r] < fOf[m]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          [fOf[m], fOf[k]] = [fOf[k], fOf[m]];
          k = m;
        }
      }
      return top;
    };
    const hEst = (i: number) => Math.hypot((i % W) - gx, Math.floor(i / W) - gy) * 0.5;
    push(hEst(start), start);
    const closed = new Set<number>();
    let expanded = 0;
    let found = false;
    while (heap.length && expanded++ < maxExpand) {
      const cur = pop();
      if (cur === goal) {
        found = true;
        break;
      }
      if (closed.has(cur)) continue;
      closed.add(cur);
      const cx = cur % W;
      const cy = Math.floor(cur / W);
      const gc = gScore.get(cur)!;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= W || y >= this.h) continue;
          const ni = y * W + x;
          const c = this.cost[ni];
          if (c >= BLOCK || closed.has(ni)) continue;
          // no cutting corners between two blocked cells
          if (dx && dy && (this.cost[cy * W + x] >= BLOCK || this.cost[y * W + cx] >= BLOCK)) continue;
          const ng = gc + (dx && dy ? 1.4142 : 1) * (c + this.cost[cur]) * 0.5;
          if (ng < (gScore.get(ni) ?? Infinity)) {
            gScore.set(ni, ng);
            came.set(ni, cur);
            push(ng + hEst(ni), ni);
          }
        }
      }
    }
    if (!found) return null;
    const cells: number[] = [];
    for (let c = goal; c !== start; c = came.get(c)!) cells.push(c);
    cells.push(start);
    cells.reverse();
    let pts: [number, number][] = cells.map((i) => {
      const c = this.centre(i % W, Math.floor(i / W));
      return [c.e, c.n];
    });
    pts[0] = [a.e, a.n];
    if (!this.blockedAt(b.e, b.n)) pts[pts.length - 1] = [b.e, b.n];
    pts = this.simplify(pts);
    return chaikin(chaikin(pts));
  }

  /** true if the straight segment stays on ground about as cheap as the path cells it replaces */
  private clear(p: [number, number], q: [number, number], limit: number) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const steps = Math.max(1, Math.ceil(d / (CELL * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (this.costAt(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t) > limit) return false;
    }
    return true;
  }
  private simplify(pts: [number, number][]) {
    if (pts.length < 3) return pts;
    const out: [number, number][] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = Math.min(pts.length - 1, i + 14);
      const limit = Math.max(1.2, this.costAt(pts[i][0], pts[i][1]) * 1.6);
      while (j > i + 1 && !this.clear(pts[i], pts[j], limit)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}

function chaikin(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Stumble risk per metre walked (0..~0.02), from the ground under the astronaut and how they move. */
export function stumbleRisk(o: { rock: number; slopeDeg: number; sprint: boolean; dust: number; fatigue: number; pace: number; assist: boolean; onTrack: boolean }) {
  let r = 0.00035;
  r *= 1 + o.rock * 4;
  r *= o.slopeDeg > 12 ? 1 + (o.slopeDeg - 12) / 7 : 1;
  r *= o.sprint ? 2.6 : 1;
  r *= o.pace < 0.8 ? 0.45 : o.pace > 1.2 ? 1.5 : 1;
  r *= 1 + Math.min(1.2, o.dust * 0.5);
  r *= o.fatigue > 70 ? 1.7 : o.fatigue > 50 ? 1.25 : 1;
  r *= o.onTrack ? 0.5 : 1.3;
  r *= o.assist ? 0.3 : 1;
  return r;
}
