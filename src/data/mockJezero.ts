/**
 * SYNTHETIC JEZERO PROVIDER
 * ------------------------------------------------------------------
 * Procedurally generated stand-in for the NASA challenge data, shaped
 * like the Jezero western delta: crater floor, a ~55 m delta scarp,
 * a crater rim rising in the west, a wadi, a butte, small craters.
 * Radiation is GCR open-sky dose (MSL RAD ~ 0.67 mSv/sol ≈ 28 µSv/h)
 * reduced by a computed sky-view factor, so cliffs and valleys shield.
 * NOT real data. Replace with NASA data on hackathon day.
 */
import type { DataBundle, DataProvider, Grid, MissionDef, Poi } from './types';
import { makeGrid, sample } from '../core/grid';

const SIZE = 257;
const CELL = 4000 / (SIZE - 1); // 15.625 m, 4 x 4 km
const ORIGIN_E = -2000;
const ORIGIN_N = 2000;

// ---------- deterministic noise ----------
function hash(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function valueNoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}
export function fbm(x: number, y: number, seed: number, oct = 5) {
  let amp = 1;
  let f = 1;
  let s = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * valueNoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (d: number, s: number) => Math.exp(-(d * d) / (2 * s * s));

function distToPolyline(e: number, n: number, pts: [number, number][]) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(e - (ax + t * dx), n - (ay + t * dy)));
  }
  return best;
}

const DELTA_APEX: [number, number] = [-1800, 1800];
const WADI: [number, number][] = [
  [520, -980],
  [330, -620],
  [120, -420],
  [-60, -340],
];
const CRATERS: [number, number, number][] = [
  [180, -1220, 60],
  [-650, -320, 120],
  [720, 120, 80],
  [-300, 1300, 150],
  [1500, -1300, 180],
  [-1000, -1500, 90],
];

/** Delta plateau weight 0..1 (1 = on top). */
function deltaMask(e: number, n: number) {
  const dx = e - DELTA_APEX[0];
  const dy = n - DELTA_APEX[1];
  const r = Math.hypot(dx, dy);
  const th = Math.atan2(dy, dx);
  const R = 2580 + 70 * Math.sin(th * 7 + 1.3) + 40 * fbm(th * 3, 0.5, 9, 3);
  return 1 - smooth(R - 130, R + 130, r);
}

export function elevationAt(e: number, n: number) {
  let h = -2600 + 0.004 * n - 0.002 * e; // gentle floor tilt
  // delta plateau, top surface sloping away from apex
  const dm = deltaMask(e, n);
  const rApex = Math.hypot(e - DELTA_APEX[0], n - DELTA_APEX[1]);
  h += dm * (55 + 0.018 * (2600 - rApex));
  // crater rim rising westward, lower near the northern inlet breach
  const rim = 300 * smooth(-450, -1550, e) * (1 - 0.55 * gauss(n - 1250, 420));
  h += rim;
  // butte (shelter overhang on its western foot)
  const bd = Math.hypot(e - 1150, n + 300);
  h += 48 * (1 - smooth(170, 240, bd));
  // comms relay hill
  h += 42 * gauss(Math.hypot(e - 1150, n - 750), 260);
  // wadi
  const wd = distToPolyline(e, n, WADI);
  h -= 4.5 * gauss(wd, 35);
  // craters: bowl + raised rim
  for (const [cx, cy, cr] of CRATERS) {
    const d = Math.hypot(e - cx, n - cy) / cr;
    h += -0.22 * cr * Math.max(0, 1 - d * d) + 0.06 * cr * gauss(d - 1, 0.18);
  }
  // roughness
  h += 4.0 * fbm(e / 380, n / 380, 3) + 1.2 * fbm(e / 90, n / 90, 7, 3);
  return h;
}

function buildElevation(): Grid {
  const g = makeGrid(SIZE, SIZE, ORIGIN_E, ORIGIN_N, CELL, 'm');
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) g.data[y * SIZE + x] = elevationAt(ORIGIN_E + x * CELL, ORIGIN_N - y * CELL);
  return g;
}

/** Sky-view factor via horizon scan in 12 directions. */
function buildRadiation(elev: Grid, baseRate: number): Grid {
  const g = makeGrid(SIZE, SIZE, ORIGIN_E, ORIGIN_N, CELL, 'µSv/h');
  const dirs = 12;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const e = ORIGIN_E + x * CELL;
      const n = ORIGIN_N - y * CELL;
      const h0 = elev.data[y * SIZE + x] + 1.7;
      let blocked = 0;
      for (let k = 0; k < dirs; k++) {
        const a = (k / dirs) * Math.PI * 2;
        let maxTan = 0;
        for (let s = 20; s <= 480; s *= 1.28) {
          const t = (sample(elev, e + Math.cos(a) * s, n + Math.sin(a) * s) - h0) / s;
          if (t > maxTan) maxTan = t;
        }
        blocked += Math.sin(Math.atan(maxTan));
      }
      const svf = 1 - (0.5 * blocked) / dirs; // isotropic upper-hemisphere approximation
      const altitude = 1 + (0.09 * (h0 + 2600)) / 1000; // thinner column higher up
      const regolith = 1 + 0.05 * fbm(e / 900, n / 900, 21, 3); // neutron albedo variation
      g.data[y * SIZE + x] = baseRate * svf * altitude * regolith;
    }
  }
  return g;
}

function buildDust(elev: Grid): Grid {
  const g = makeGrid(SIZE, SIZE, ORIGIN_E, ORIGIN_N, CELL, 'τ index');
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const e = ORIGIN_E + x * CELL;
      const n = ORIGIN_N - y * CELL;
      const low = smooth(-2560, -2610, elev.data[y * SIZE + x]);
      const wadi = gauss(distToPolyline(e, n, WADI), 90);
      g.data[y * SIZE + x] = 0.3 + 0.7 * low + 1.4 * wadi + 0.35 * (fbm(e / 600, n / 600, 31, 3) + 1);
    }
  }
  return g;
}

function buildMagnetic(): Grid {
  const g = makeGrid(SIZE, SIZE, ORIGIN_E, ORIGIN_N, CELL, 'nT');
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const e = ORIGIN_E + x * CELL;
      const n = ORIGIN_N - y * CELL;
      g.data[y * SIZE + x] =
        40 + 180 * gauss(Math.hypot(e + 900, n + 900), 700) + 120 * gauss(Math.hypot(e - 1200, n - 1100), 500) + 25 * fbm(e / 700, n / 700, 41, 3);
    }
  }
  return g;
}

function buildRocks(): Grid {
  const g = makeGrid(SIZE, SIZE, ORIGIN_E, ORIGIN_N, CELL, '0..1');
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const e = ORIGIN_E + x * CELL;
      const n = ORIGIN_N - y * CELL;
      const dm = deltaMask(e, n);
      const scarpFoot = 4 * dm * (1 - dm); // peaks on the scarp
      const butte = gauss(Math.hypot(e - 1150, n + 300) - 240, 60);
      let crater = 0;
      for (const [cx, cy, cr] of CRATERS) crater += gauss(Math.hypot(e - cx, n - cy) / cr - 1.1, 0.3);
      const boulderField = gauss(Math.hypot(e + 150, n + 700), 260);
      g.data[y * SIZE + x] = Math.min(1, 0.08 + 0.55 * scarpFoot + 0.6 * butte + 0.35 * crater + 0.8 * boulderField + 0.08 * fbm(e / 200, n / 200, 51, 3));
    }
  }
  return g;
}

export const POIS: Poi[] = [
  { id: 'hab', kind: 'habitat', name: 'Habitat', e: 500, n: -1500, shielding: 0.02, radius: 12, note: 'Pressurised habitat and airlock' },
  { id: 's1', kind: 'sample', name: 'Delta Front Outcrop', e: -60, n: -340, note: 'Layered delta sediments, fine-grained mudstone' },
  { id: 's2', kind: 'sample', name: 'Rim Megabreccia', e: -1000, n: 560, note: 'Impact breccia blocks from crater rim' },
  { id: 'shelter', kind: 'shelter', name: 'Rock Overhang', e: 900, n: -350, shielding: 0.12, radius: 45, note: 'Undercut butte face; ~88% sky blocked' },
  { id: 'relay', kind: 'comms', name: 'Comms Relay Hill', e: 1150, n: 750, note: 'Line of sight to habitat & orbiter' },
  { id: 'cache-a', kind: 'cache', name: 'Supply Cache Alpha', e: 880, n: -372, note: 'Pre-placed O2, water and battery pack at the overhang' },
  { id: 'cache-b', kind: 'cache', name: 'Supply Cache Bravo', e: 262, n: 372, note: 'Pre-placed O2, water and battery pack at Junction Bravo' },
  { id: 'hz-boulder', kind: 'hazard', name: 'Boulder Field', e: -150, n: -700, radius: 220, note: 'Slip and trip risk; slow traverse' },
  { id: 'hz-sand', kind: 'hazard', name: 'Soft Regolith (Wadi)', e: 230, n: -520, radius: 120, note: 'Aeolian infill; high sinkage' },
  { id: 'hz-rim', kind: 'hazard', name: 'Rim Scree Slope', e: -700, n: 520, radius: 220, note: 'Loose scree up to 25°' },
];

export const MISSION: MissionDef = {
  id: 'eva-03',
  title: 'EVA-03 · JEZERO CRATER',
  subtitle: 'Delta Front Sample Traverse',
  sol: 412,
  startLmstH: 9.23,
  startNodeId: 'HAB',
  consumables: { o2g: 540, waterg: 3000, battWh: 420, doseBudgetmSv: 50 },
  nodes: [
    { id: 'HAB', name: 'Habitat', e: 500, n: -1500, poiId: 'hab' },
    { id: 'JA', name: 'Junction Alpha', e: 450, n: -900 },
    { id: 'S1', name: 'Delta Front Outcrop', e: -60, n: -340, poiId: 's1' },
    { id: 'SH', name: 'Rock Overhang', e: 900, n: -350, poiId: 'shelter' },
    { id: 'JB', name: 'Junction Bravo', e: 250, n: 350 },
    { id: 'S2', name: 'Rim Megabreccia', e: -1000, n: 560, poiId: 's2' },
    { id: 'CR', name: 'Comms Relay Hill', e: 1150, n: 750, poiId: 'relay' },
  ],
  edges: [
    { id: 'E1', name: 'Egress Path', a: 'HAB', b: 'JA', via: [[470, -1200]], surface: 'regolith' },
    { id: 'E2', name: 'Delta Front Traverse', a: 'JA', b: 'S1', via: [[150, -880], [-120, -720], [-200, -520]], surface: 'boulders', description: 'Firm footing but crosses the boulder field' },
    { id: 'E3', name: 'Wadi Shortcut', a: 'JA', b: 'S1', via: [[330, -620], [120, -450]], surface: 'soft_sand', description: 'Shorter, flat, soft aeolian sand' },
    { id: 'E4', name: 'Butte Approach', a: 'JA', b: 'SH', via: [[720, -680]], surface: 'regolith' },
    { id: 'E5', name: 'Scarp Foot Trail', a: 'S1', b: 'SH', via: [[250, -300], [600, -320]], surface: 'regolith' },
    { id: 'E6', name: 'Delta Climb', a: 'S1', b: 'JB', via: [[-120, 20], [80, 220]], surface: 'slope_scree', description: 'Climbs the delta scarp' },
    { id: 'E7', name: 'Eastern Lobe', a: 'SH', b: 'JB', via: [[820, 0], [520, 260]], surface: 'regolith' },
    { id: 'E8', name: 'Rim Ascent', a: 'JB', b: 'S2', via: [[-250, 420], [-650, 500]], surface: 'slope_scree', description: 'Direct, steep, exposed' },
    { id: 'E9', name: 'Fan Lobe Route', a: 'JB', b: 'S2', via: [[0, 850], [-450, 1000], [-850, 880]], surface: 'regolith', description: 'Longer, gentle grades' },
    { id: 'E10', name: 'Western Return', a: 'S2', b: 'HAB', via: [[-950, -100], [-650, -800], [-50, -1300]], surface: 'regolith', description: 'Long descent across the crater floor' },
    { id: 'E11', name: 'Relay Spur', a: 'JB', b: 'CR', via: [[720, 600]], surface: 'regolith' },
    { id: 'E12', name: 'Relay Descent', a: 'CR', b: 'SH', via: [[1450, 150], [1320, -620], [980, -580]], surface: 'regolith' },
  ],
  objectives: [
    { id: 'o1', label: 'Collect sample at Delta Front Outcrop', nodeId: 'S1', kind: 'sample' },
    { id: 'o2', label: 'Collect sample at Rim Megabreccia', nodeId: 'S2', kind: 'sample' },
    { id: 'o3', label: 'Return to Habitat above consumable reserve', nodeId: 'HAB', kind: 'return' },
  ],
  incidents: [
    {
      id: 'dust-devil',
      title: 'DUST DEVIL CROSSING THE WADI',
      category: 'CAUTION · ENVIRONMENT',
      severity: 'caution',
      trigger: { type: 'edge', edgeId: 'E3', at: 0.45 },
      body: 'A convective vortex is tracking across the wadi toward you. Visibility will drop below 30 m and fine dust will load the visor and suit joints. Soft sand already raises your walking cost.',
      onTrigger: [{ modifier: { id: 'dust', label: 'Dust devil', dust: 2.2, metMult: 1.12, durationS: 600 } }],
      options: [
        { label: 'Shelter in place, face away', consequence: 'Wait ~5 min for it to pass. Consumables keep draining at rest.', tags: ['+5 min'], effects: [{ waitS: 300 }, { removeModifier: 'dust' }], recommended: true },
        { label: 'Push through', consequence: 'Keep moving with high exertion in low visibility.', tags: ['FATIGUE ↑'], effects: [{ modifier: { id: 'dust-push', label: 'Pushing through dust', metMult: 1.3, durationS: 600 } }] },
        { label: 'Turn back to Delta Front Traverse', consequence: 'Navigator plans the firm-ground alternative.', tags: ['REROUTE'], effects: [{ reroute: 'alternate' }] },
      ],
      defaultOption: 0,
      timeoutS: 25,
    },
    {
      id: 'foot-slip',
      title: 'FOOT SLIP IN BOULDER FIELD',
      category: 'WARNING · CREW HEALTH',
      severity: 'warning',
      trigger: { type: 'edge', edgeId: 'E2', at: 0.5 },
      body: 'Your right boot slid off a tilted block. Ankle strain reported, no suit breach. Walking speed and efficiency are reduced.',
      onTrigger: [{ modifier: { id: 'ankle', label: 'Ankle strain', speedCap: 0.6, metMult: 1.2 } }],
      options: [
        { label: 'Apply ankle brace from tool kit', consequence: 'Stops for 4 min, restores most mobility.', tags: ['+4 min'], effects: [{ waitS: 240 }, { removeModifier: 'ankle' }, { modifier: { id: 'brace', label: 'Ankle braced', speedCap: 0.95, metMult: 1.06 } }], recommended: true },
        { label: 'Continue unassisted', consequence: 'Speed capped at 0.6 m/s, higher exertion for the rest of the EVA.', tags: ['FATIGUE ↑'], effects: [] },
      ],
      defaultOption: 0,
      timeoutS: 25,
    },
    {
      id: 'spe',
      title: 'SOLAR PARTICLE EVENT WARNING',
      category: 'WARNING · SPACE WEATHER',
      severity: 'warning',
      trigger: { type: 'node_depart', nodeId: 'S1' },
      body: 'Mission Control: proton flux rising after an X-class flare. Protons arrive in ~15 min; surface dose rate then rises ×300 (≈8 mSv/h) for ~30 min. Terrain shielding matters: the Rock Overhang blocks ~88% of the sky.',
      onTrigger: [{ modifier: { id: 'spe', label: 'Solar particle event', doseMult: 300, delayS: 900, durationS: 1800 } }],
      options: [
        { label: 'Divert to Rock Overhang shelter', consequence: 'Navigator routes to shelter; wait there until the event passes.', tags: ['DOSE ↓↓', '+time'], effects: [{ reroute: 'shelter' }], recommended: true },
        { label: 'Return to habitat', consequence: 'Abort remaining objectives and head home.', tags: ['ABORT'], effects: [{ reroute: 'habitat' }] },
        { label: 'Continue mission (accept dose)', consequence: 'Open-sky exposure at ~8 mSv/h for 30 min (≈4 mSv).', tags: ['HIGH DOSE'], effects: [] },
      ],
      defaultOption: 0,
      timeoutS: 30,
    },
    {
      id: 'leak',
      title: 'SUIT PRESSURE DROP: MICRO-LEAK',
      category: 'EMERGENCY · SUIT SYSTEMS',
      severity: 'emergency',
      trigger: { type: 'edge', edgeId: 'E8', at: 0.45 },
      body: 'Abrasive scree has opened a pinhole near the left glove bearing. The PLSS is compensating from primary O2 at ~120 g/h.',
      onTrigger: [{ modifier: { id: 'leak', label: 'Glove micro-leak', leakGph: 120 } }],
      options: [
        { label: 'Apply glove patch kit', consequence: 'Stops ~90% of the leak. Patch kit used.', tags: ['+3 min', '−6 g O2'], effects: [{ waitS: 180 }, { removeModifier: 'leak' }, { modifier: { id: 'leak-patched', label: 'Patched leak', leakGph: 12 } }], recommended: true },
        { label: 'Abort to habitat now', consequence: 'Navigator plans the safest return with the leak active.', tags: ['ABORT'], effects: [{ reroute: 'habitat' }] },
        { label: 'Continue and monitor', consequence: 'Leak continues at 120 g/h.', tags: ['HIGH RISK'], effects: [] },
      ],
      defaultOption: 0,
      timeoutS: 25,
    },
    {
      id: 'battery',
      title: 'PLSS BATTERY CELL FAULT',
      category: 'WARNING · POWER',
      severity: 'warning',
      trigger: { type: 'edge', edgeId: 'E9', at: 0.5 },
      body: 'Cold-soak in the lobe shadow tripped a battery cell. Usable capacity dropped by 35%. Heaters are drawing more.',
      onTrigger: [{ modifier: { id: 'batt-fault', label: 'Cell fault', battCapacityMult: 0.65, battExtraW: 15 } }],
      options: [
        { label: 'Shed non-critical loads', consequence: 'Dim HUD, disable map overlays except route, cut 20 W.', tags: ['−20 W'], effects: [{ modifier: { id: 'shed', label: 'Loads shed', battExtraW: -20 } }], recommended: true },
        { label: 'Continue at full load', consequence: 'Battery drains faster.', tags: ['BATT ↓'], effects: [] },
      ],
      defaultOption: 0,
      timeoutS: 25,
    },
    {
      id: 'sublimator',
      title: 'SUBLIMATOR PERFORMANCE DEGRADED',
      category: 'CAUTION · THERMAL',
      severity: 'caution',
      trigger: { type: 'edge', edgeId: 'E7', at: 0.5 },
      body: 'Dust on the sublimator plate halved cooling efficiency. Core temperature will climb under high workload.',
      onTrigger: [{ modifier: { id: 'cooling', label: 'Cooling degraded', coolingMult: 0.5 } }],
      options: [
        { label: 'Reduce pace to slow', consequence: 'Lower heat load; longer traverse.', tags: ['PACE ↓'], effects: [{ setPace: 'slow' }], recommended: true },
        { label: 'Keep nominal pace', consequence: 'Core temperature rises; fatigue builds faster.', tags: ['HEAT ↑'], effects: [] },
      ],
      defaultOption: 0,
      timeoutS: 25,
    },
    {
      id: 'comms',
      title: 'LOSS OF SIGNAL BEHIND RIM',
      category: 'CAUTION · COMMS',
      severity: 'caution',
      trigger: { type: 'edge', edgeId: 'E10', at: 0.15 },
      body: 'The crater rim blocks line of sight to the habitat. Mission Control alerts and space-weather updates are unavailable until you regain signal.',
      onTrigger: [{ modifier: { id: 'los', label: 'Loss of signal', commsLoss: true, durationS: 900 } }],
      options: [
        { label: 'Launch drone as comms relay', consequence: 'Drone hovers overhead and restores the link.', tags: ['DRONE'], effects: [{ removeModifier: 'los' }, { note: 'drone-relay' }], recommended: true },
        { label: 'Continue without comms', consequence: 'LOS for ~15 min.', tags: ['LOS'], effects: [] },
      ],
      defaultOption: 0,
      timeoutS: 25,
    },
  ],
};

export const mockJezeroProvider: DataProvider = {
  id: 'mock',
  label: 'SYNTHETIC JEZERO v0',
  async load(): Promise<DataBundle> {
    const elevation = buildElevation();
    const conditions = { surfaceTempC: -63, dustTau: 0.6, gcrDoseRateuSvH: 28 };
    return {
      label: 'SYNTHETIC JEZERO v0',
      source: 'synthetic',
      elevation,
      radiation: buildRadiation(elevation, conditions.gcrDoseRateuSvH),
      dust: buildDust(elevation),
      magnetic: buildMagnetic(),
      rocks: buildRocks(),
      pois: POIS,
      mission: MISSION,
      conditions,
    };
  },
};
