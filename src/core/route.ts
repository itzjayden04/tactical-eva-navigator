/**
 * ROUTE ENGINE
 * Track graph, densified edge geometry, route metrics and path search.
 */
import type { DataBundle, SurfaceType, TrackEdge, TrackNode } from '../data/types';
import { sample } from './grid';

export const SURFACE_ETA: Record<SurfaceType, number> = {
  bedrock: 1.0,
  regolith: 1.2,
  slope_scree: 1.6,
  boulders: 1.5,
  soft_sand: 2.1,
};

export interface PathSample {
  s: number; // horizontal distance from start of edge (a→b), m
  e: number;
  n: number;
  h: number; // elevation, m
  gradePct: number; // along-track grade (a→b direction), %
  doseBase: number; // µSv/h from radiation grid (open sky, svf-shielded)
  dust: number;
}

export interface EdgeGeom {
  edge: TrackEdge;
  samples: PathSample[];
  length: number;
  eta: number;
}

/** A traversal of one edge in a direction. */
export interface Leg {
  edgeId: string;
  forward: boolean; // true = a→b
}

export interface RouteMetrics {
  distance: number;
  gain: number;
  loss: number;
  maxSlopeDeg: number;
  estTimeS: number;
}

const STEP = 8;

function catmull(p0: number[], p1: number[], p2: number[], p3: number[], t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [0, 1].map(
    (i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3),
  );
}

export class TrackWorld {
  nodes = new Map<string, TrackNode>();
  edges = new Map<string, EdgeGeom>();
  adj = new Map<string, Leg[]>();

  constructor(public data: DataBundle) {
    for (const n of data.mission.nodes) {
      this.nodes.set(n.id, n);
      this.adj.set(n.id, []);
    }
    for (const e of data.mission.edges) {
      this.edges.set(e.id, this.buildGeom(e));
      this.adj.get(e.a)!.push({ edgeId: e.id, forward: true });
      this.adj.get(e.b)!.push({ edgeId: e.id, forward: false });
    }
  }

  private buildGeom(edge: TrackEdge): EdgeGeom {
    const a = this.nodes.get(edge.a)!;
    const b = this.nodes.get(edge.b)!;
    const ctrl: number[][] = [[a.e, a.n], ...edge.via, [b.e, b.n]];
    // dense spline points
    const dense: number[][] = [];
    for (let i = 0; i < ctrl.length - 1; i++) {
      const p0 = ctrl[Math.max(0, i - 1)];
      const p1 = ctrl[i];
      const p2 = ctrl[i + 1];
      const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
      const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const k = Math.max(2, Math.ceil(segLen / 2));
      for (let j = 0; j < k; j++) dense.push(catmull(p0, p1, p2, p3, j / k));
    }
    dense.push(ctrl[ctrl.length - 1]);
    // resample at STEP metres
    const pts: number[][] = [dense[0]];
    let acc = 0;
    for (let i = 1; i < dense.length; i++) {
      const [x0, y0] = dense[i - 1];
      const [x1, y1] = dense[i];
      let d = Math.hypot(x1 - x0, y1 - y0);
      let sx = x0;
      let sy = y0;
      while (acc + d >= STEP) {
        const t = (STEP - acc) / d;
        sx = sx + (x1 - sx) * t;
        sy = sy + (y1 - sy) * t;
        pts.push([sx, sy]);
        d = Math.hypot(x1 - sx, y1 - sy);
        acc = 0;
      }
      acc += d;
    }
    const last = dense[dense.length - 1];
    if (Math.hypot(pts[pts.length - 1][0] - last[0], pts[pts.length - 1][1] - last[1]) > 1) pts.push(last);
    const { elevation, radiation, dust } = this.data;
    const samples: PathSample[] = [];
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      samples.push({ s, e: pts[i][0], n: pts[i][1], h: sample(elevation, pts[i][0], pts[i][1]), gradePct: 0, doseBase: sample(radiation, pts[i][0], pts[i][1]), dust: sample(dust, pts[i][0], pts[i][1]) });
    }
    // along-track grade over a ±12 m window
    for (let i = 0; i < samples.length; i++) {
      const i0 = Math.max(0, i - 2);
      const i1 = Math.min(samples.length - 1, i + 2);
      const ds = samples[i1].s - samples[i0].s;
      samples[i].gradePct = ds > 0 ? ((samples[i1].h - samples[i0].h) / ds) * 100 : 0;
    }
    return { edge, samples, length: s, eta: SURFACE_ETA[edge.surface] };
  }

  legLength(leg: Leg) {
    return this.edges.get(leg.edgeId)!.length;
  }
  legFrom(leg: Leg) {
    const e = this.edges.get(leg.edgeId)!.edge;
    return leg.forward ? e.a : e.b;
  }
  legTo(leg: Leg) {
    const e = this.edges.get(leg.edgeId)!.edge;
    return leg.forward ? e.b : e.a;
  }

  /** Point on a leg at distance s from the leg's start (direction-aware). */
  pointOnLeg(leg: Leg, s: number): PathSample {
    const g = this.edges.get(leg.edgeId)!;
    const sa = leg.forward ? s : g.length - s;
    const ss = g.samples;
    const clamped = Math.max(0, Math.min(g.length, sa));
    let lo = 0;
    let hi = ss.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ss[mid].s <= clamped) lo = mid;
      else hi = mid;
    }
    const A = ss[lo];
    const B = ss[hi];
    const t = B.s > A.s ? (clamped - A.s) / (B.s - A.s) : 0;
    const lerp = (x: number, y: number) => x + (y - x) * t;
    const grade = lerp(A.gradePct, B.gradePct) * (leg.forward ? 1 : -1);
    return { s, e: lerp(A.e, B.e), n: lerp(A.n, B.n), h: lerp(A.h, B.h), gradePct: grade, doseBase: lerp(A.doseBase, B.doseBase), dust: lerp(A.dust, B.dust) };
  }

  /** Samples along a leg in travel order starting at offset s0. */
  legSamples(leg: Leg, s0 = 0): PathSample[] {
    const g = this.edges.get(leg.edgeId)!;
    const out: PathSample[] = [];
    for (let s = s0; s < g.length; s += STEP) out.push(this.pointOnLeg(leg, s));
    out.push(this.pointOnLeg(leg, g.length));
    return out;
  }

  /** Metrics for a route (optionally starting part-way along the first leg). */
  metrics(route: Leg[], firstOffset = 0): RouteMetrics {
    let distance = 0;
    let gain = 0;
    let loss = 0;
    let maxSlope = 0;
    let time = 0;
    route.forEach((leg, i) => {
      const ss = this.legSamples(leg, i === 0 ? firstOffset : 0);
      const eta = this.edges.get(leg.edgeId)!.eta;
      for (let k = 1; k < ss.length; k++) {
        const ds = ss[k].s - ss[k - 1].s;
        const dh = ss[k].h - ss[k - 1].h;
        distance += ds;
        if (dh > 0) gain += dh;
        else loss -= dh;
        maxSlope = Math.max(maxSlope, Math.abs(Math.atan(ss[k].gradePct / 100)) * (180 / Math.PI));
        time += ds / walkSpeed(1.0, ss[k].gradePct, eta, 99, 0);
      }
    });
    return { distance, gain, loss, maxSlopeDeg: maxSlope, estTimeS: time };
  }

  /** Dijkstra by distance. */
  shortestPath(from: string, to: string): Leg[] | null {
    if (from === to) return [];
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, Leg>();
    const open = new Set<string>([from]);
    while (open.size) {
      let u = '';
      let best = Infinity;
      for (const k of open) if ((dist.get(k) ?? Infinity) < best) {
        best = dist.get(k)!;
        u = k;
      }
      open.delete(u);
      if (u === to) break;
      for (const leg of this.adj.get(u)!) {
        const v = this.legTo(leg);
        const nd = best + this.legLength(leg);
        if (nd < (dist.get(v) ?? Infinity)) {
          dist.set(v, nd);
          prev.set(v, leg);
          open.add(v);
        }
      }
    }
    if (!prev.has(to)) return null;
    const path: Leg[] = [];
    let cur = to;
    while (cur !== from) {
      const leg = prev.get(cur)!;
      path.unshift(leg);
      cur = this.legFrom(leg);
    }
    return path;
  }

  /** All simple paths (no repeated nodes) up to maxLegs. */
  simplePaths(from: string, to: string, maxLegs = 6): Leg[][] {
    const out: Leg[][] = [];
    const visit = (node: string, seen: Set<string>, path: Leg[]) => {
      if (node === to) {
        out.push([...path]);
        return;
      }
      if (path.length >= maxLegs) return;
      for (const leg of this.adj.get(node)!) {
        const v = this.legTo(leg);
        if (seen.has(v)) continue;
        seen.add(v);
        path.push(leg);
        visit(v, seen, path);
        path.pop();
        seen.delete(v);
      }
    };
    if (from === to) return [[]];
    visit(from, new Set([from]), []);
    return out;
  }

  /** Nearest node to (e,n) within radius. */
  nearestNode(e: number, n: number, radius = 250): TrackNode | null {
    let best: TrackNode | null = null;
    let bd = radius;
    for (const node of this.nodes.values()) {
      const d = Math.hypot(node.e - e, node.n - n);
      if (d < bd) {
        bd = d;
        best = node;
      }
    }
    return best;
  }

  routeName(route: Leg[]) {
    return route.map((l) => this.edges.get(l.edgeId)!.edge.name).join(' → ');
  }
}

/** Walking speed (m/s): pace × Tobler-style slope factor × terrain factor, capped. */
export function walkSpeed(pace: number, gradePct: number, eta: number, speedCap: number, dust: number) {
  const g = gradePct / 100;
  const tobler = Math.exp(-3.5 * Math.abs(g + 0.05)) / Math.exp(-3.5 * 0.05);
  const terrain = Math.sqrt(1.2 / eta);
  const vis = 1 - 0.15 * Math.min(2, dust) / 2;
  return Math.max(0.25, Math.min(speedCap, pace * tobler * terrain * vis));
}

export const sameRoute = (a: Leg[], b: Leg[]) => a.length === b.length && a.every((l, i) => l.edgeId === b[i].edgeId && l.forward === b[i].forward);
