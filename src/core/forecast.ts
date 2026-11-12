/**
 * FORECAST: run the health model forward along a candidate route.
 * Uses exactly the same `step()` as the live simulation, so the
 * forecast chart and the lived experience agree (no hidden future
 * incidents: the navigator only knows current conditions).
 */
import type { ModifierSpec, Poi } from '../data/types';
import { HealthState, Modifiers, NO_MODS, step, RESERVE_FRAC } from './health';
import { Leg, TrackWorld, walkSpeed } from './route';

export interface ActiveMod {
  id: string;
  label: string;
  spec: ModifierSpec;
  remainingS?: number;
  delayS?: number; // not yet in effect (e.g. SPE lead time)
}

export function aggregate(mods: ActiveMod[]): Modifiers {
  const m: Modifiers = { ...NO_MODS };
  for (const { spec, delayS } of mods) {
    if (delayS && delayS > 0) continue;
    if (spec.leakGph) m.leakGph += spec.leakGph;
    if (spec.metMult) m.metMult *= spec.metMult;
    if (spec.speedCap) m.speedCap = Math.min(m.speedCap, spec.speedCap);
    if (spec.coolingMult) m.coolingMult *= spec.coolingMult;
    if (spec.battExtraW) m.battExtraW += spec.battExtraW;
    if (spec.doseMult) m.doseMult *= spec.doseMult;
    if (spec.dust) m.dust += spec.dust;
    if (spec.commsLoss) m.commsLoss = true;
  }
  return m;
}

export function shieldingAt(pois: Poi[], e: number, n: number) {
  let s = 1;
  for (const p of pois) if (p.shielding !== undefined && p.radius && Math.hypot(p.e - e, p.n - n) <= p.radius) s = Math.min(s, p.shielding);
  return s;
}

export interface ForecastPoint {
  t: number; // seconds from now
  d: number; // metres from now
  o2: number; // fraction
  water: number;
  batt: number;
  fatigue: number;
  dose: number; // mSv cumulative
  hr: number;
  core: number;
}

export interface ForecastResult {
  points: ForecastPoint[];
  timeS: number;
  distance: number;
  peakFatigue: number;
  o2End: number;
  waterEnd: number;
  battEnd: number;
  doseAdded: number;
  peakCore: number;
  feasible: boolean;
  end: HealthState;
}

/** Waits inserted at nodes (sampling time, shelter holds). */
export type NodeWaits = Map<string, number>;

export function forecastRoute(
  world: TrackWorld,
  h0: HealthState,
  mods0: ActiveMod[],
  route: Leg[],
  firstOffset: number,
  pace: number,
  ambientC: number,
  nodeWaits: NodeWaits = new Map(),
): ForecastResult {
  let h = { ...h0 };
  let mods = mods0.map((m) => ({ ...m }));
  let t = 0;
  let d = 0;
  const pts: ForecastPoint[] = [];
  const push = () =>
    pts.push({ t, d, o2: h.o2g / h.o2Cap, water: h.waterg / h.waterCap, batt: h.battWh / h.battCap, fatigue: h.fatigue, dose: h.doseMSv, hr: h.hr, core: h.coreC });
  push();
  let peakF = h.fatigue;
  let peakCore = h.coreC;
  const pois = world.data.pois;
  const decay = (dt: number) => {
    for (const m of mods) {
      if (m.delayS && m.delayS > 0) m.delayS -= dt;
      else if (m.remainingS !== undefined) m.remainingS -= dt;
    }
    mods = mods.filter((m) => m.remainingS === undefined || m.remainingS > 0);
  };
  const rest = (seconds: number, e: number, n: number, doseBase: number) => {
    let left = seconds;
    while (left > 0) {
      const dt = Math.min(30, left);
      const agg = aggregate(mods);
      h = step(h, { speed: 0, gradePct: 0, eta: 1, doseRate: doseBase * agg.doseMult * shieldingAt(pois, e, n), ambientC, dust: 0, mods: agg }, dt);
      t += dt;
      left -= dt;
      decay(dt);
      peakF = Math.max(peakF, h.fatigue);
      peakCore = Math.max(peakCore, h.coreC);
    }
    push();
  };
  route.forEach((leg, i) => {
    const ss = world.legSamples(leg, i === 0 ? firstOffset : 0);
    const eta = world.edges.get(leg.edgeId)!.eta;
    for (let k = 1; k < ss.length; k++) {
      const a = ss[k - 1];
      const b = ss[k];
      const ds = b.s - a.s;
      const agg = aggregate(mods);
      const v = walkSpeed(pace, b.gradePct, eta, agg.speedCap, agg.dust);
      const dt = ds / v;
      h = step(h, { speed: v, gradePct: b.gradePct, eta, doseRate: b.doseBase * agg.doseMult * shieldingAt(pois, b.e, b.n), ambientC, dust: agg.dust, mods: agg }, dt);
      t += dt;
      d += ds;
      decay(dt);
      peakF = Math.max(peakF, h.fatigue);
      peakCore = Math.max(peakCore, h.coreC);
      if (k % 4 === 0) push();
    }
    push();
    const node = world.legTo(leg);
    const w = nodeWaits.get(node);
    if (w) {
      const nd = world.nodes.get(node)!;
      rest(w, nd.e, nd.n, ss[ss.length - 1].doseBase);
    }
  });
  const last = pts[pts.length - 1];
  return {
    points: pts,
    timeS: t,
    distance: d,
    peakFatigue: peakF,
    o2End: last.o2,
    waterEnd: last.water,
    battEnd: last.batt,
    doseAdded: h.doseMSv - h0.doseMSv,
    peakCore,
    feasible: last.o2 > RESERVE_FRAC && last.batt > 0.05 && last.water > 0.05 && peakF < 100,
    end: h,
  };
}
