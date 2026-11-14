/**
 * SIMULATION: single source of truth for the EVA.
 * Rendering (VR/AR) and HUD only read from here, so switching modes
 * never loses position, route or vitals.
 */
import type { DataBundle, IncidentDef, IncidentEffect, Poi, Severity } from '../data/types';
import { checkFailure, FATIGUE_REROUTE, HealthState, initialHealth, RESERVE_FRAC, step } from './health';
import { ActiveMod, aggregate, forecastRoute, ForecastResult, NodeWaits, shieldingAt } from './forecast';
import { Leg, RouteMetrics, sameRoute, TrackWorld, walkSpeed } from './route';
import { makeObstacles, NavGrid, ObstacleIndex, seeded, stumbleRisk, type Obstacle } from './terrain';
import { slopeDeg } from './grid';
import { sample } from './grid';

export type Status = 'briefing' | 'active' | 'success' | 'aborted' | 'failed';
export type Pace = 'slow' | 'nominal' | 'fast';
export const PACE_V: Record<Pace, number> = { slow: 0.7, nominal: 1.0, fast: 1.35 };
export const SAMPLE_TIME_S = 240;
export const WARP = 10;
export const WAIT_WARP = 40;
/** Mars surface gravity, m/s² */
export const G_MARS_MS2 = 3.71;
export const JUMP_V = 2.5;

export interface LogEntry {
  met: number;
  kind: 'incident' | 'decision' | 'reroute' | 'sample' | 'info' | 'failure' | 'hazard';
  title: string;
  severity: Severity | 'info';
  decision?: string;
  outcome?: string;
}

export interface Candidate {
  turnBack: boolean;
  legs: Leg[]; // legs after the current one
  full: Leg[]; // full route from current position
  offset: number;
}

export interface Plan {
  route: Leg[];
  offset: number;
  waits: NodeWaits;
  forecast: ForecastResult;
  metrics: RouteMetrics;
  goal: string;
}

export interface Advisory {
  title: string;
  reason: string;
  cand: Candidate;
  goalOverride?: { node: string; kind: 'shelter' | 'habitat' };
  pace?: Pace;
  current: ForecastResult;
  alt: ForecastResult;
  currentMetrics: RouteMetrics;
  altMetrics: RouteMetrics;
  altRoute: Leg[];
  altOffset: number;
}

export interface Choice {
  leg: Leg;
  name: string;
  metrics: RouteMetrics;
  forecast: ForecastResult;
  score: number;
  recommended: boolean;
  surface: string;
}

export interface HistoryPoint {
  met: number;
  o2: number;
  water: number;
  batt: number;
  fatigue: number;
  dose: number;
  hr: number;
  core: number;
  e: number;
  n: number;
}

export interface DroneState {
  active: boolean;
  mode: 'scout' | 'relay' | 'returning' | 'hold';
  e: number;
  n: number;
  alt: number;
  heading: number;
  path: [number, number][];
  idx: number;
  battery: number; // 0..100
  revealedCells: number;
}

type Listener = (payload?: any) => void;

const FOG_N = 128;

export class Sim {
  world: TrackWorld;
  status: Status = 'briefing';
  training = false;
  met = 0;
  pace: Pace = 'nominal';
  /** free-walking state (WASD). The track graph is guidance, not rails. */
  free: { e: number; n: number };
  lookYaw = 0; // radians, 0 = north, clockwise (set by the renderer/camera)
  input = { f: 0, r: 0, sprint: false };
  offTrack = 0; // metres from nearest traverse
  private lastGrade = 0;
  private atNodeId: string | null = null;
  pos: { leg: Leg | null; s: number; node: string | null };
  health: HealthState;
  mods: ActiveMod[] = [];
  committed: Leg[] = [];
  goalOverride: { node: string; kind: 'shelter' | 'habitat' } | null = null;
  objectivesDone = new Set<string>();
  waitS = 0;
  waitReason = '';
  private onWaitEnd: (() => void) | null = null;
  samplePrompt: string | null = null;
  incident: { def: IncidentDef; remainingReal: number; startedMet: number } | null = null;
  fired = new Set<string>();
  advisory: Advisory | null = null;
  private fatigueArmed = true;
  private o2ArmedAt = 0;
  awaitingChoice = false;
  choices: Choice[] = [];
  log: LogEntry[] = [];
  history: HistoryPoint[] = [];
  fog = new Uint8Array(FOG_N * FOG_N);
  discovered = new Set<string>();
  marks: { e: number; n: number; met: number; label: string }[] = [];
  drone: DroneState;
  plan: Plan | null = null;
  private planDirty = true;
  private planTimer = 0;
  private advTimer = 0;
  private histTimer = 0;
  private fogTimer = 0;
  rates = { o2gps: 0, watergps: 0, battWps: 0, doseRate: 0 };
  failReason = '';
  dosePeakRate = 0;
  stats = { advisoriesShown: 0, advisoriesAccepted: 0, distance: 0, doseAvoidedEst: 0 };
  path: [number, number][] = [];
  private listeners = new Map<string, Listener[]>();
  plannerNodes: string[] = [];
  /** edge we arrived on at the current node (to discourage backtracking) */
  arrivedVia: string | null = null;
  warp = WARP;
  // ---- real terrain: boulders, guide path, body state (jump / stumble / fall)
  obstacles: ObstacleIndex;
  nav: NavGrid;
  /** AR guide path from the astronaut's feet along the plan (world e,n), refreshed continuously */
  guide: [number, number][] = [];
  private guideTimer = 0;
  private guideKey = '';
  /** body state in REAL seconds (not warped): alt = height above ground while jumping */
  body = { alt: 0, vz: 0, stumbleT: 0, fallT: 0, shake: 0, blockedT: 0 };
  /** suit stability assist: braces joints, lowers stumble risk, caps speed */
  stability = false;
  /** current stumble risk per metre (for the HUD) */
  risk = 0;
  private rnd = seeded(7331);
  private riskAcc = 0;
  stats2 = { stumbles: 0, falls: 0, jumps: 0, blocked: 0 };
  /** off-graph destination (supply cache, tag, teammate): the guide path leads straight there */
  detour: { e: number; n: number; label: string; id: string } | null = null;
  /** extra sections merged into the exported log (tags, comms, photos) */
  extra: Record<string, unknown> = {};

  constructor(public data: DataBundle) {
    this.world = new TrackWorld(data);
    const start = data.mission.startNodeId;
    this.pos = { leg: null, s: 0, node: start };
    this.free = { e: this.world.nodes.get(start)!.e, n: this.world.nodes.get(start)!.n };
    this.atNodeId = start;
    this.health = initialHealth(data.mission.consumables);
    const n = this.world.nodes.get(start)!;
    this.drone = { active: false, mode: 'hold', e: n.e, n: n.n, alt: 0, heading: 0, path: [], idx: 0, battery: 100, revealedCells: 0 };
    for (const p of data.pois) if (p.kind !== 'hazard') this.discovered.add(p.id);
    this.obstacles = new ObstacleIndex(makeObstacles(data, this.world));
    this.nav = new NavGrid(data, this.world, this.obstacles);
  }

  // ---------------------------------------------------------------- events
  on(type: string, fn: Listener) {
    (this.listeners.get(type) ?? this.listeners.set(type, []).get(type)!).push(fn);
  }
  emit(type: string, payload?: any) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }
  toast(msg: string) {
    this.emit('toast', msg);
  }
  addLog(entry: Omit<LogEntry, 'met'>) {
    this.log.push({ met: this.met, ...entry });
    this.emit('log');
  }

  // ---------------------------------------------------------------- position helpers
  position(): { e: number; n: number; h: number; gradePct: number; doseBase: number; dust: number } {
    const { e, n } = this.free;
    return { e, n, h: sample(this.data.elevation, e, n), gradePct: this.lastGrade, doseBase: sample(this.data.radiation, e, n), dust: sample(this.data.dust, e, n) };
  }
  isMoving() {
    return this.status === 'active' && !this.incident && this.waitS <= 0 && this.body.fallT <= 0 && (this.input.f !== 0 || this.input.r !== 0);
  }
  /** Bearing (rad) toward the next point of the navigator's plan; used to face the astronaut at start and by the test autopilot. */
  suggestedHeading(lookAhead = 15): number {
    const plan = this.plan;
    const p = this.position();
    // the guide path already bends around boulders: follow it when we have one
    for (const [ge, gn] of this.guide) {
      if (Math.hypot(ge - p.e, gn - p.n) >= Math.min(lookAhead, 7)) return Math.atan2(ge - p.e, gn - p.n);
    }
    if (plan && plan.route.length) {
      let leg = plan.route[0];
      // progress along the first leg = nearest point to the astronaut (offset is stale while still inside a node's radius)
      const L0 = this.world.legLength(leg);
      let prog = plan.offset;
      let bd = Infinity;
      for (let q = plan.offset; q <= Math.min(L0, plan.offset + 80); q += 2) {
        const pt = this.world.pointOnLeg(leg, q);
        const d = Math.hypot(pt.e - p.e, pt.n - p.n);
        if (d < bd) {
          bd = d;
          prog = q;
        }
      }
      let s = prog + lookAhead;
      if (s > this.world.legLength(leg) && plan.route[1]) {
        s -= this.world.legLength(leg);
        leg = plan.route[1];
      }
      const t = this.world.pointOnLeg(leg, Math.min(s, this.world.legLength(leg)));
      if (Math.hypot(t.e - p.e, t.n - p.n) > 0.5) return Math.atan2(t.e - p.e, t.n - p.n);
    }
    return this.lookYaw;
  }
  /** Test/demo helper only: steer along the plan for one frame. The player never gets this. */
  autopilot() {
    this.lookYaw = this.suggestedHeading(12);
    this.input.f = 1;
    this.input.r = 0;
  }
  agg() {
    return aggregate(this.mods);
  }
  doseRateHere() {
    const p = this.position();
    return p.doseBase * this.agg().doseMult * shieldingAt(this.data.pois, p.e, p.n);
  }
  nextWaypoint(): { name: string; e: number; n: number; dist: number } | null {
    const p = this.position();
    if (this.detour) return { name: this.detour.label, e: this.detour.e, n: this.detour.n, dist: Math.hypot(this.detour.e - p.e, this.detour.n - p.n) };
    let node: string | null = null;
    if (this.pos.leg) node = this.world.legTo(this.pos.leg);
    else if (this.committed[0]) node = this.world.legTo(this.committed[0]);
    else if (this.plan && this.plan.route[0]) node = this.world.legTo(this.plan.route[0]);
    if (!node) return null;
    const nd = this.world.nodes.get(node)!;
    return { name: nd.name, e: nd.e, n: nd.n, dist: Math.hypot(nd.e - p.e, nd.n - p.n) };
  }
  pendingObjectives() {
    return this.data.mission.objectives.filter((o) => !this.objectivesDone.has(o.id));
  }
  goalChain(): string[] {
    if (this.goalOverride?.kind === 'habitat') return [this.goalOverride.node];
    const rest = this.pendingObjectives().map((o) => o.nodeId);
    if (!rest.length || rest[rest.length - 1] !== this.data.mission.startNodeId) rest.push(this.data.mission.startNodeId);
    if (this.goalOverride) return [this.goalOverride.node, ...rest];
    return rest;
  }
  currentGoal() {
    const chain = this.goalChain();
    const here = this.pos.node;
    return chain.find((g) => g !== here) ?? chain[0];
  }
  paceV() {
    return PACE_V[this.pace];
  }

  // ---------------------------------------------------------------- lifecycle
  start(training: boolean) {
    this.training = training;
    this.status = 'active';
    this.addLog({ kind: 'info', title: 'Egress complete, EVA started', severity: 'info' });
    this.revealAround(this.position().e, this.position().n, 320);
    this.arrive(this.pos.node!, true);
    this.lookYaw = this.suggestedHeading();
    this.emit('change');
  }

  update(dtReal: number) {
    if (this.status !== 'active') return;
    this.updateBody(Math.min(dtReal, 0.1));
    if (this.incident) {
      this.incident.remainingReal -= dtReal;
      if (this.incident.remainingReal <= 0) this.resolveIncident(this.incident.def.defaultOption, true);
      return;
    }
    const warp = this.waitS > 0 ? Math.max(WAIT_WARP, this.warp) : this.warp;
    let remaining = Math.min(dtReal, 0.1) * warp;
    while (remaining > 0 && this.status === 'active' && !this.incident) {
      const dt = Math.min(1, remaining);
      remaining -= dt;
      this.tick(dt);
    }
  }

  private tick(dt: number) {
    const before = { ...this.health };
    const amb = this.data.conditions.surfaceTempC;
    const agg = this.agg();
    const p = this.position();
    const doseRate = p.doseBase * agg.doseMult * shieldingAt(this.data.pois, p.e, p.n);
    this.dosePeakRate = Math.max(this.dosePeakRate, doseRate);
    if (this.waitS > 0) {
      this.health = step(this.health, { speed: 0, gradePct: 0, eta: 1, doseRate, ambientC: amb, dust: agg.dust, mods: agg }, dt);
      this.waitS -= dt;
      if (this.waitS <= 0) {
        this.waitS = 0;
        this.waitReason = '';
        const cb = this.onWaitEnd;
        this.onWaitEnd = null;
        cb?.();
        this.planDirty = true;
      }
    } else if (this.body.fallT <= 0 && (this.input.f !== 0 || this.input.r !== 0)) {
      const dir = this.lookYaw + Math.atan2(this.input.r, this.input.f);
      const se = Math.sin(dir);
      const cn = Math.cos(dir);
      const g = this.data.elevation;
      const grade = ((sample(g, p.e + se * 4, p.n + cn * 4) - sample(g, p.e - se * 4, p.n - cn * 4)) / 8) * 100;
      const onTrackEta = this.offTrack < 30 && this.pos.leg ? this.world.edges.get(this.pos.leg.edgeId)!.eta : null;
      const eta = onTrackEta ?? 1.25 + 0.8 * (this.data.rocks ? sample(this.data.rocks, p.e, p.n) : 0.2);
      const pace = this.paceV() * (this.input.sprint ? 1.35 : 1) * (this.input.f < 0 && this.input.r === 0 ? 0.6 : 1);
      const v = walkSpeed(pace, grade, eta, agg.speedCap, agg.dust) * (this.body.stumbleT > 0 ? 0.35 : 1) * (this.stability ? 0.85 : 1);
      const half = (g.cell * (g.width - 1)) / 2 - 40;
      const cx = g.originE + half + 40;
      const cy = g.originN - half - 40;
      let ne = Math.max(cx - half, Math.min(cx + half, p.e + se * v * dt));
      let nn = Math.max(cy - half, Math.min(cy + half, p.n + cn * v * dt));
      // boulders block you (slide around them); a jump clears low rocks
      let hit = false;
      for (const o of this.obstacles.near(ne, nn, 3)) {
        if (this.body.alt > o.h + 0.05) continue;
        const d = Math.hypot(ne - o.e, nn - o.n);
        const min = o.r + 0.45;
        if (d < min) {
          const k = d > 1e-3 ? min / d : 1;
          ne = o.e + (d > 1e-3 ? (ne - o.e) * k : min);
          nn = o.n + (d > 1e-3 ? (nn - o.n) * k : 0);
          hit = true;
        }
      }
      // ground too steep to climb: you slide back
      if (slopeDeg(g, ne, nn) > 34 && sample(g, ne, nn) > p.h) {
        ne = p.e;
        nn = p.n;
        hit = true;
      }
      if (hit && this.body.blockedT <= 0) {
        this.body.blockedT = 2.5;
        this.stats2.blocked++;
        this.emit('blocked');
      }
      const moved = Math.hypot(ne - p.e, nn - p.n);
      this.free.e = ne;
      this.free.n = nn;
      this.lastGrade = grade;
      this.stats.distance += moved;
      // footing: rough ground, speed, dust and fatigue can make you stumble or fall
      const rockHere = this.data.rocks ? sample(this.data.rocks, ne, nn) : 0.2;
      this.risk = stumbleRisk({ rock: rockHere, slopeDeg: slopeDeg(g, ne, nn), sprint: this.input.sprint, dust: agg.dust, fatigue: this.health.fatigue, pace: this.paceV(), assist: this.stability, onTrack: this.offTrack < 8 });
      if (this.body.alt <= 0 && this.body.fallT <= 0) {
        this.riskAcc += this.risk * moved;
        if (this.riskAcc > 1) {
          this.riskAcc = 0;
          this.trip(this.rnd() < 0.3 ? 'fall' : 'stumble');
        }
      }
      this.health = step(this.health, { speed: v, gradePct: grade, eta, doseRate, ambientC: amb, dust: agg.dust, mods: agg }, dt);
      this.trackUpdate();
      if (this.detour && Math.hypot(this.detour.e - ne, this.detour.n - nn) < 12) {
        const d = this.detour;
        this.detour = null;
        this.guideKey = '';
        this.toast(`Arrived: ${d.label}`);
        this.emit('detour-arrive', d);
        this.emit('change');
      }
    } else {
      this.lastGrade = 0;
      this.health = step(this.health, { speed: 0, gradePct: 0, eta: 1, doseRate, ambientC: amb, dust: agg.dust, mods: agg }, dt);
    }
    // consumable rates (per second)
    this.rates = {
      o2gps: (before.o2g - this.health.o2g) / dt,
      watergps: (before.waterg - this.health.waterg) / dt,
      battWps: ((before.battWh - this.health.battWh) / dt) * 3600,
      doseRate,
    };
    this.met += dt;
    // modifiers decay
    for (const m of this.mods) {
      if (m.delayS && m.delayS > 0) {
        m.delayS -= dt;
        if (m.delayS <= 0) {
          this.toast(`${m.label}: now in effect`);
          this.addLog({ kind: 'info', title: `${m.label} onset`, severity: 'warning' });
          this.planDirty = true;
        }
      } else if (m.remainingS !== undefined) m.remainingS -= dt;
    }
    const expired = this.mods.filter((m) => m.remainingS !== undefined && m.remainingS <= 0);
    if (expired.length) {
      this.mods = this.mods.filter((m) => !expired.includes(m));
      for (const m of expired) {
        this.toast(`${m.label} ended`);
        this.addLog({ kind: 'info', title: `${m.label} ended`, severity: 'info' });
      }
      this.planDirty = true;
    }
    this.histTimer -= dt;
    if (this.histTimer <= 0) {
      this.histTimer = 15;
      const h = this.health;
      const pp = this.position();
      this.history.push({ met: this.met, o2: h.o2g / h.o2Cap, water: h.waterg / h.waterCap, batt: h.battWh / h.battCap, fatigue: h.fatigue, dose: h.doseMSv, hr: h.hr, core: h.coreC, e: pp.e, n: pp.n });
      this.path.push([pp.e, pp.n]);
    }
    this.fogTimer -= dt;
    if (this.fogTimer <= 0) {
      this.fogTimer = 5;
      const pp = this.position();
      this.revealAround(pp.e, pp.n, 300);
      this.discoverNear(pp.e, pp.n, 260, 'visual');
    }
    this.updateDrone(dt);
    this.planTimer -= dt;
    if (this.planDirty || this.planTimer <= 0) this.recomputePlan();
    this.advTimer -= dt;
    if (this.advTimer <= 0) {
      this.advTimer = 5;
      this.checkAdvisories();
    }
    const fail = checkFailure(this.health);
    if (fail.failed) {
      if (this.training) {
        this.health.o2g = Math.max(this.health.o2g, 1);
        this.health.battWh = Math.max(this.health.battWh, 1);
        this.health.fatigue = Math.min(this.health.fatigue, 99);
        this.health.coreC = Math.min(this.health.coreC, 39.7);
      } else this.fail(fail.reason!);
    }
  }


  // ---------------------------------------------------------------- body: jump, stumble, fall (real time)
  /** Space bar. Mars gravity: about 0.85 m high and 1.3 s in the air. */
  jump() {
    if (this.status !== 'active' || this.incident || this.waitS > 0 || this.body.alt > 0 || this.body.fallT > 0) return false;
    this.body.vz = JUMP_V * (this.health.fatigue > 70 ? 0.8 : 1);
    this.body.alt = 0.001;
    this.stats2.jumps++;
    this.health.fatigue = Math.min(100, this.health.fatigue + 0.25);
    this.emit('jump');
    return true;
  }
  /** Lose your footing. A stumble slows you; a fall puts you on the ground for a few seconds. */
  trip(kind: 'stumble' | 'fall', cause = '') {
    if (this.body.fallT > 0) return;
    const p = this.position();
    const where = cause || (this.data.rocks && sample(this.data.rocks, p.e, p.n) > 0.45 ? 'loose rock' : Math.abs(this.lastGrade) > 20 ? 'steep ground' : 'uneven ground');
    if (kind === 'stumble') {
      this.body.stumbleT = 1.6;
      this.body.shake = 0.6;
      this.stats2.stumbles++;
      this.health.fatigue = Math.min(100, this.health.fatigue + 0.6);
      this.addLog({ kind: 'info', title: `Stumble: ${where}`, severity: 'caution', outcome: 'Recovered' });
    } else {
      this.body.fallT = 4;
      this.body.shake = 1;
      this.stats2.falls++;
      this.health.fatigue = Math.min(100, this.health.fatigue + 2.5);
      this.health.hr = Math.min(190, this.health.hr + 18);
      this.addLog({ kind: 'hazard', title: `Fall: ${where}`, severity: 'warning', outcome: 'Back on feet' });
    }
    this.emit('trip', { kind, where });
    this.emit('change');
  }
  private updateBody(dt: number) {
    const b = this.body;
    if (b.alt > 0) {
      b.vz -= G_MARS_MS2 * dt;
      b.alt += b.vz * dt;
      if (b.alt <= 0) {
        b.alt = 0;
        b.vz = 0;
        b.shake = Math.max(b.shake, 0.25);
        // landing on rough ground can cost you your footing
        const p = this.position();
        const rock = this.data.rocks ? sample(this.data.rocks, p.e, p.n) : 0.2;
        if (this.rnd() < rock * 0.35 * (this.stability ? 0.3 : 1)) this.trip(this.rnd() < 0.25 ? 'fall' : 'stumble', 'a bad landing');
      }
    }
    b.stumbleT = Math.max(0, b.stumbleT - dt);
    b.fallT = Math.max(0, b.fallT - dt);
    b.blockedT = Math.max(0, b.blockedT - dt);
    b.shake = Math.max(0, b.shake - dt * 1.4);
    this.guideTimer -= dt;
    if (this.guideTimer <= 0) this.updateGuide();
  }

  /**
   * AR guide: A* from the astronaut's feet to a point ahead on the planned route,
   * then on along the route. Recomputed as you move, deviate, reroute, or the terrain changes.
   */
  updateGuide(force = false) {
    this.guideTimer = 0.5;
    const plan = this.plan;
    const p = this.position();
    if (this.detour) {
      const d = this.detour;
      const dk = `d|${Math.round(p.e / 3)},${Math.round(p.n / 3)}|${d.id}|${this.nav.version}`;
      if (!force && dk === this.guideKey) return;
      this.guideKey = dk;
      this.guide = this.nav.path({ e: p.e, n: p.n }, { e: d.e, n: d.n }, 90000) ?? [[p.e, p.n], [d.e, d.n]];
      return;
    }
    if (!plan || !plan.route.length) {
      this.guide = [];
      return;
    }
    const key = `${Math.round(p.e / 3)},${Math.round(p.n / 3)}|${plan.route.map((l) => l.edgeId + (l.forward ? 'f' : 'r')).join('')}|${this.nav.version}`;
    if (!force && key === this.guideKey) return;
    this.guideKey = key;
    // targets along the route ahead: a point every ~40 m, and ALWAYS each leg's end node
    // (the guide must lead through waypoints, not cut the corner past them)
    const targets: { e: number; n: number; must: boolean }[] = [];
    let acc = 0;
    outer: for (let li = 0; li < plan.route.length; li++) {
      const leg = plan.route[li];
      const len = this.world.legLength(leg);
      let q0 = 0;
      if (li === 0) {
        // progress = nearest point on the first leg (pos.s is stale while still inside a node's radius)
        let bd = Infinity;
        const from = Math.min(len, this.pos.leg ? this.pos.s : plan.offset);
        for (let q = from; q <= Math.min(len, from + 90); q += 3) {
          const pt = this.world.pointOnLeg(leg, q);
          const d = Math.hypot(pt.e - p.e, pt.n - p.n);
          if (d < bd) {
            bd = d;
            q0 = q;
          }
        }
        q0 += 30;
      } else q0 = 40;
      for (let q = q0; q < len - 15; q += 40) {
        const pt = this.world.pointOnLeg(leg, q);
        if (!this.nav.blockedAt(pt.e, pt.n)) targets.push({ e: pt.e, n: pt.n, must: false });
        acc += 40;
        if (acc > 240) break outer;
      }
      const end = this.world.pointOnLeg(leg, len);
      targets.push({ e: end.e, n: end.n, must: true });
      if (acc > 240) break;
    }
    const guide: [number, number][] = [[p.e, p.n]];
    let from = { e: p.e, n: p.n };
    for (const t of targets) {
      if (Math.hypot(t.e - from.e, t.n - from.n) < 4) continue;
      const seg = this.nav.path(from, t, 20000);
      if (seg && seg.length > 1) guide.push(...seg.slice(1));
      else guide.push([t.e, t.n]);
      from = t;
    }
    this.guide = guide;
  }

  /** Public reroute entry points for the emergency actions. */
  rerouteTo(kind: 'shelter' | 'habitat' | 'avoid_steep' | 'alternate') {
    this.advisory = null;
    this.applyReroute(kind);
    this.recomputePlan();
    this.updateGuide(true);
    this.emit('change');
  }
  /** Divert to any traverse node (e.g. a supply cache), then carry on with the mission. */
  divertTo(nodeId: string, label: string) {
    this.advisory = null;
    this.goalOverride = { node: nodeId, kind: 'shelter' };
    const best = this.bestCandidate(nodeId, { wO2: 800 });
    if (best) this.commitCandidate(best.cand);
    this.addLog({ kind: 'reroute', title: `Diverting to ${label}`, severity: 'caution', outcome: best ? `${(best.f.timeS / 60).toFixed(0)} min` : '' });
    this.recomputePlan();
    this.updateGuide(true);
    this.emit('change');
  }
  /** Navigate off the traverse graph to any point (cache, tag, teammate). */
  setDetour(e: number, n: number, label: string, id = label) {
    this.detour = { e, n, label, id };
    this.addLog({ kind: 'reroute', title: `Navigating to ${label}`, severity: 'info', outcome: `${Math.hypot(e - this.free.e, n - this.free.n).toFixed(0)} m, obstacle-aware path` });
    this.updateGuide(true);
    this.emit('change');
  }
  clearDetour() {
    if (!this.detour) return;
    this.detour = null;
    this.guideKey = '';
    this.updateGuide(true);
    this.emit('change');
  }
  /** Close a traverse (rockfall): rubble on the ground, removed from every route search. */
  blockEdge(edgeId: string, atFrac = 0.5) {
    const g = this.world.edges.get(edgeId);
    if (!g || this.world.blocked.has(edgeId)) return;
    this.world.blocked.add(edgeId);
    const c = this.world.pointOnLeg({ edgeId, forward: true }, g.length * atFrac);
    const r = seeded(edgeId.length * 977 + 5);
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2;
      const d = r() * 16;
      const rad = 1.2 + r() * 2.6;
      this.obstacles.add({ e: c.e + Math.cos(a) * d, n: c.n + Math.sin(a) * d, r: rad, h: rad * 0.9, kind: 'rubble' } as Obstacle);
    }
    this.nav.rebuild();
    this.committed = this.committed.filter((l) => l.edgeId !== edgeId);
    this.addLog({ kind: 'hazard', title: `Rockfall: ${g.edge.name} blocked`, severity: 'warning', outcome: 'Removed from routing' });
    this.emit('obstacles');
    this.recomputePlan();
    this.updateGuide(true);
    this.emit('change');
    return c;
  }
  /** Hold still to bring heart rate and fatigue down. */
  rest(seconds = 300) {
    if (this.waitS > 0 || this.status !== 'active') return 'Already holding';
    this.wait(seconds, 'RESTING', () => this.toast('Rest complete'));
    this.addLog({ kind: 'decision', title: 'Rest stop', severity: 'info', decision: `${Math.round(seconds / 60)} min` });
    this.emit('change');
    return `Resting for ${Math.round(seconds / 60)} minutes`;
  }
  hold(seconds: number, reason: string, then?: () => void) {
    this.wait(seconds, reason, then);
    this.emit('change');
  }

  // ---------------------------------------------------------------- movement
  /** Snap the free position to the track graph: node arrival/departure, current edge, incidents. */
  private trackUpdate() {
    const { e, n } = this.free;
    let near: string | null = null;
    let nd = Infinity;
    for (const node of this.world.nodes.values()) {
      const d = Math.hypot(node.e - e, node.n - n);
      if (d < nd) {
        nd = d;
        near = node.id;
      }
    }
    if (near && nd < 15) {
      this.offTrack = 0;
      if (this.atNodeId !== near) {
        this.atNodeId = near;
        this.arrive(near);
      }
      return;
    }
    if (this.atNodeId) {
      if (near === this.atNodeId && nd < 25) return; // hysteresis
      const left = this.atNodeId;
      this.atNodeId = null;
      this.depart(left);
    }
    // nearest point on any edge
    let bestEdge = '';
    let bestS = 0;
    let bestD = Infinity;
    for (const [id, g] of this.world.edges) {
      for (const smp of g.samples) {
        const d = (smp.e - e) ** 2 + (smp.n - n) ** 2;
        if (d < bestD) {
          bestD = d;
          bestEdge = id;
          bestS = smp.s;
        }
      }
    }
    this.offTrack = Math.sqrt(bestD);
    const g = this.world.edges.get(bestEdge)!;
    const len = g.length;
    const prevLeg = this.pos.leg;
    const sameEdge = prevLeg?.edgeId === bestEdge;
    const prevSA = sameEdge ? (prevLeg!.forward ? this.pos.s : len - this.pos.s) : null;
    let forward = sameEdge ? prevLeg!.forward : this.arrivedFrom ? g.edge.a === this.arrivedFrom : bestS < len / 2;
    if (prevSA !== null && Math.abs(bestS - prevSA) > 0.5) forward = bestS > prevSA;
    const leg: Leg = { edgeId: bestEdge, forward };
    const sNew = forward ? bestS : len - bestS;
    if (prevSA !== null && this.offTrack < 40) this.checkEdgeIncidents(leg, forward ? prevSA : len - prevSA, sNew, len);
    if (!sameEdge) {
      if (this.committed[0]?.edgeId === bestEdge) this.committed.shift();
      else if (this.committed.length) {
        this.committed = [];
        this.toast('Off planned route: navigator recalculating');
      }
      this.planDirty = true;
    }
    this.pos = { leg, s: sNew, node: null };
  }
  private arrivedFrom: string | null = null;

  private arrive(node: string, initial = false) {
    this.arrivedVia = this.pos.leg?.edgeId ?? null;
    this.pos = { leg: null, s: 0, node };
    const nd = this.world.nodes.get(node)!;
    if (!initial) this.toast(`Arrived: ${nd.name}`);
    this.planDirty = true;
    if (!initial && node === this.data.mission.startNodeId && this.met > 120) {
      this.endMission();
      return;
    }
    if (this.committed.length && this.world.legFrom(this.committed[0]) !== node) this.committed = [];
    // shelter hold
    if (this.goalOverride?.kind === 'shelter' && this.goalOverride.node === node) {
      const spe = this.mods.find((m) => m.spec.doseMult && m.spec.doseMult > 1);
      this.goalOverride = null;
      if (spe && spe.remainingS) {
        this.wait(spe.remainingS + (spe.delayS ?? 0) + 5, 'SHELTERING · SPE IN PROGRESS', () => {
          this.toast('Space weather clear. Resume your traverse.');
          this.computeChoices();
          this.emit('change');
        });
        this.addLog({ kind: 'info', title: `Sheltering at ${nd.name}`, severity: 'info', outcome: `Shielding ${Math.round((1 - (this.data.pois.find((p) => p.id === nd.poiId)?.shielding ?? 1)) * 100)}% of sky` });
      }
    }
    if (this.goalOverride && this.goalOverride.node === node) this.goalOverride = null;
    const obj = this.pendingObjectives().find((o) => o.nodeId === node && o.kind === 'sample');
    this.samplePrompt = obj ? obj.id : null;
    this.recomputePlan();
    this.computeChoices();
    this.awaitingChoice = true;
    this.emit('change');
  }

  private depart(from: string) {
    this.arrivedFrom = from;
    this.awaitingChoice = false;
    this.samplePrompt = null;
    this.choices = [];
    this.planDirty = true;
    for (const def of this.data.mission.incidents) {
      if (!this.fired.has(def.id) && def.trigger.type === 'node_depart' && def.trigger.nodeId === from) this.fireIncident(def);
    }
    this.emit('change');
  }

  /** At a junction: set which traverse the navigator guides you along (you still walk it yourself). */
  choose(i: number) {
    if (!this.awaitingChoice || this.incident) return;
    const c = this.choices[i];
    if (!c) return;
    this.committed = [c.leg];
    this.addLog({ kind: 'decision', title: `Traverse chosen: ${c.name}`, severity: 'info', decision: c.recommended ? 'Navigator recommendation' : 'Crew choice (not recommended)' });
    this.toast(`Route set: ${c.name}. Follow the chevrons.`);
    this.recomputePlan();
    this.emit('change');
  }

  cyclePace() {
    this.pace = this.pace === 'slow' ? 'nominal' : this.pace === 'nominal' ? 'fast' : 'slow';
    this.planDirty = true;
    this.toast(`Pace: ${this.pace.toUpperCase()}`);
    this.emit('change');
  }

  private wait(seconds: number, reason: string, then?: () => void) {
    this.waitS = Math.max(this.waitS, seconds);
    this.waitReason = reason;
    const prev = this.onWaitEnd;
    this.onWaitEnd = () => {
      prev?.();
      then?.();
    };
  }

  markSample(): string {
    if (this.status !== 'active') return 'EVA not active';
    const p = this.position();
    const obj = this.pendingObjectives().find((o) => {
      if (o.kind !== 'sample') return false;
      const nd = this.world.nodes.get(o.nodeId)!;
      return Math.hypot(nd.e - p.e, nd.n - p.n) < 40;
    });
    if (obj) {
      if (this.waitS > 0) return 'Already busy';
      this.wait(SAMPLE_TIME_S, 'COLLECTING SAMPLE', () => {
        this.objectivesDone.add(obj.id);
        this.samplePrompt = null;
        this.addLog({ kind: 'sample', title: `Sample collected: ${this.world.nodes.get(obj.nodeId)!.name}`, severity: 'info', outcome: 'Objective complete' });
        this.toast(`Sample sealed and logged: ${this.world.nodes.get(obj.nodeId)!.name}`);
        this.computeChoices();
        this.emit('change');
      });
      this.emit('change');
      return `Collecting sample at ${this.world.nodes.get(obj.nodeId)!.name}`;
    }
    const label = `Field note ${this.marks.length + 1}`;
    this.marks.push({ e: p.e, n: p.n, met: this.met, label });
    this.addLog({ kind: 'info', title: `${label} marked`, severity: 'info', outcome: `E${p.e.toFixed(0)} N${p.n.toFixed(0)} · dose rate ${this.doseRateHere().toFixed(0)} µSv/h` });
    this.emit('change');
    return `${label} marked on map`;
  }

  // ---------------------------------------------------------------- incidents
  private checkEdgeIncidents(leg: Leg, s0: number, s1: number, len: number) {
    for (const def of this.data.mission.incidents) {
      if (this.fired.has(def.id) || def.trigger.type !== 'edge' || def.trigger.edgeId !== leg.edgeId) continue;
      const f0 = (leg.forward ? s0 : len - s0) / len;
      const f1 = (leg.forward ? s1 : len - s1) / len;
      const at = def.trigger.at;
      if ((f0 < at && f1 >= at) || (f0 > at && f1 <= at)) {
        this.fireIncident(def);
        return;
      }
    }
  }

  fireIncident(def: IncidentDef) {
    this.fired.add(def.id);
    for (const eff of def.onTrigger) this.applyEffect(eff, def);
    this.incident = { def, remainingReal: def.timeoutS, startedMet: this.met };
    this.advisory = null;
    this.addLog({ kind: 'incident', title: def.title, severity: def.severity });
    this.planDirty = true;
    this.recomputePlan();
    this.emit('incident', def);
    this.emit('change');
  }

  resolveIncident(i: number, timedOut = false) {
    if (!this.incident) return;
    const def = this.incident.def;
    const opt = def.options[i] ?? def.options[def.defaultOption];
    this.incident = null;
    const before = this.health.doseMSv;
    for (const eff of opt.effects) this.applyEffect(eff, def);
    const entry = [...this.log].reverse().find((l) => l.kind === 'incident' && l.title === def.title);
    if (entry) {
      entry.decision = (timedOut ? '[timeout] ' : '') + opt.label;
      entry.outcome = opt.consequence;
    }
    void before;
    this.planDirty = true;
    this.recomputePlan();
    this.emit('log');
    this.emit('change');
  }

  private applyEffect(eff: IncidentEffect, def?: IncidentDef) {
    if (eff.modifier) {
      const { id, label, durationS, delayS, ...spec } = eff.modifier;
      this.mods = this.mods.filter((m) => m.id !== id);
      if (spec.battCapacityMult) {
        this.health.battCap *= spec.battCapacityMult;
        this.health.battWh *= spec.battCapacityMult;
        delete spec.battCapacityMult;
      }
      this.mods.push({ id, label, spec, remainingS: durationS, delayS });
    }
    if (eff.removeModifier) this.mods = this.mods.filter((m) => m.id !== eff.removeModifier);
    if (eff.waitS) this.wait(eff.waitS, def ? def.title.split(':')[0] : 'HOLDING');
    if (eff.consume) {
      this.health.o2g -= eff.consume.o2g ?? 0;
      this.health.waterg -= eff.consume.waterg ?? 0;
      this.health.battWh -= eff.consume.battWh ?? 0;
    }
    if (eff.setPace) this.pace = eff.setPace;
    if (eff.note === 'drone-relay') this.launchDrone('relay');
    if (eff.reroute) this.applyReroute(eff.reroute);
    if (eff.action) this.emit('action', eff.action);
  }

  private applyReroute(kind: 'shelter' | 'habitat' | 'avoid_steep' | 'alternate') {
    const p = this.position();
    if (kind === 'shelter') {
      const shelters = this.data.pois.filter((x) => x.kind === 'shelter');
      const nodes = shelters.map((s) => [...this.world.nodes.values()].find((n) => n.poiId === s.id)).filter(Boolean);
      nodes.sort((a, b) => Math.hypot(a!.e - p.e, a!.n - p.n) - Math.hypot(b!.e - p.e, b!.n - p.n));
      const node = nodes[0];
      if (!node) return;
      this.goalOverride = { node: node.id, kind: 'shelter' };
      const best = this.bestCandidate(node.id, { wDose: 400 });
      if (best) this.commitCandidate(best.cand);
      this.addLog({ kind: 'reroute', title: `Diverting to ${node.name}`, severity: 'warning', outcome: best ? `${(best.f.timeS / 60).toFixed(0)} min, dose +${best.f.doseAdded.toFixed(2)} mSv` : '' });
    } else if (kind === 'habitat') {
      const hab = this.data.mission.startNodeId;
      this.goalOverride = { node: hab, kind: 'habitat' };
      const best = this.bestCandidate(hab, { wO2: 2000 });
      if (best) this.commitCandidate(best.cand);
      this.addLog({ kind: 'reroute', title: 'Abort: returning to habitat', severity: 'warning', outcome: best ? `ETA ${(best.f.timeS / 60).toFixed(0)} min, O2 at HAB ${(best.f.o2End * 100).toFixed(0)}%` : '' });
    } else if (kind === 'alternate') {
      const curEdge = this.pos.leg?.edgeId;
      const best = this.bestCandidate(this.currentGoal(), {}, (c) => !c.full.some((l) => l.edgeId === curEdge) || c.turnBack);
      const alt = best && best.cand.turnBack ? best : this.bestCandidate(this.currentGoal(), {}, (c) => c.turnBack && c.full.slice(1).every((l) => l.edgeId !== curEdge));
      if (alt) {
        this.commitCandidate(alt.cand);
        this.addLog({ kind: 'reroute', title: `Rerouted: ${this.world.routeName(alt.cand.full.slice(1)) || 'turn back'}`, severity: 'caution' });
      }
    } else if (kind === 'avoid_steep') {
      const best = this.bestCandidate(this.currentGoal(), { steepPenalty: 300 });
      if (best) this.commitCandidate(best.cand);
    }
    this.planDirty = true;
  }

  private commitCandidate(c: Candidate) {
    if (c.turnBack && this.pos.leg) {
      const leg = this.pos.leg;
      this.pos = { leg: { edgeId: leg.edgeId, forward: !leg.forward }, s: this.world.legLength(leg) - this.pos.s, node: null };
      this.toast('Navigator: turn around and follow the chevrons');
    }
    this.committed = [...c.legs];
    this.planDirty = true;
  }

  // ---------------------------------------------------------------- planning
  candidates(goal: string): Candidate[] {
    const out: Candidate[] = [];
    if (this.pos.node) {
      for (const p of this.world.simplePaths(this.pos.node, goal)) out.push({ turnBack: false, legs: p, full: p, offset: 0 });
      return out;
    }
    const leg = this.pos.leg!;
    const len = this.world.legLength(leg);
    for (const p of this.world.simplePaths(this.world.legTo(leg), goal)) {
      if (p[0]?.edgeId === leg.edgeId) continue;
      out.push({ turnBack: false, legs: p, full: [leg, ...p], offset: this.pos.s });
    }
    const rev: Leg = { edgeId: leg.edgeId, forward: !leg.forward };
    for (const p of this.world.simplePaths(this.world.legFrom(leg), goal)) {
      if (p[0]?.edgeId === leg.edgeId) continue;
      out.push({ turnBack: true, legs: p, full: [rev, ...p], offset: len - this.pos.s });
    }
    return out;
  }

  private waitsFor(route: Leg[]): NodeWaits {
    const w: NodeWaits = new Map();
    const pending = new Set(this.pendingObjectives().filter((o) => o.kind === 'sample').map((o) => o.nodeId));
    for (const l of route) {
      const to = this.world.legTo(l);
      if (pending.has(to)) {
        w.set(to, SAMPLE_TIME_S);
        pending.delete(to);
      }
    }
    if (this.goalOverride?.kind === 'shelter') {
      const spe = this.mods.find((m) => m.spec.doseMult && m.spec.doseMult > 1);
      if (spe?.remainingS) w.set(this.goalOverride.node, spe.remainingS + Math.max(0, spe.delayS ?? 0));
    }
    return w;
  }

  score(f: ForecastResult, m: RouteMetrics, w: { wF?: number; wDose?: number; wO2?: number; steepPenalty?: number } = {}) {
    const wF = w.wF ?? 1.5;
    const wDose = w.wDose ?? 40;
    const wO2 = w.wO2 ?? 600;
    let s = f.timeS / 60;
    s += wF * Math.max(0, f.peakFatigue - 55);
    s += wDose * f.doseAdded;
    s += wO2 * Math.max(0, 0.3 - f.o2End);
    s += 4 * Math.max(0, f.peakCore - 37.8) * 10;
    if (!f.feasible) s += 1000;
    if (w.steepPenalty && m.maxSlopeDeg > 15) s += w.steepPenalty;
    return s;
  }

  bestCandidate(goal: string, weights: Parameters<Sim['score']>[2] = {}, filter?: (c: Candidate) => boolean, pace = this.paceV()) {
    let best: { cand: Candidate; f: ForecastResult; m: RouteMetrics; score: number } | null = null;
    for (const c of this.candidates(goal)) {
      if (filter && !filter(c)) continue;
      const f = forecastRoute(this.world, this.health, this.mods, c.full, c.offset, pace, this.data.conditions.surfaceTempC, this.waitsFor(c.full));
      const m = this.world.metrics(c.full, c.offset);
      const sc = this.score(f, m, weights);
      if (!best || sc < best.score) best = { cand: c, f, m, score: sc };
    }
    return best;
  }

  /** Full remaining plan: committed legs, then best paths through the goal chain. */
  buildPlanRoute(): { route: Leg[]; offset: number } {
    const route: Leg[] = [];
    let offset = 0;
    let at: string;
    if (this.pos.leg) {
      route.push(this.pos.leg);
      offset = this.pos.s;
      at = this.world.legTo(this.pos.leg);
    } else at = this.pos.node!;
    for (const l of this.committed) {
      route.push(l);
      at = this.world.legTo(l);
    }
    for (const g of this.goalChain()) {
      if (g === at) continue;
      const paths = this.world.simplePaths(at, g);
      let best: Leg[] | null = null;
      let bs = Infinity;
      for (const p of paths) {
        if (route.length && p[0] && p[0].edgeId === route[route.length - 1].edgeId) continue;
        const f = forecastRoute(this.world, this.health, this.mods, p, 0, this.paceV(), this.data.conditions.surfaceTempC, this.waitsFor(p));
        const back = !route.length && p[0]?.edgeId === this.arrivedVia ? 40 : 0;
        const sc = this.score(f, this.world.metrics(p)) + back;
        if (sc < bs) {
          bs = sc;
          best = p;
        }
      }
      if (!best) best = this.world.shortestPath(at, g) ?? [];
      route.push(...best);
      at = g;
    }
    return { route, offset };
  }

  recomputePlan() {
    this.planDirty = false;
    this.planTimer = 10;
    const { route, offset } = this.buildPlanRoute();
    const waits = this.waitsFor(route);
    const forecast = forecastRoute(this.world, this.health, this.mods, route, offset, this.paceV(), this.data.conditions.surfaceTempC, waits);
    this.plan = { route, offset, waits, forecast, metrics: this.world.metrics(route, offset), goal: this.currentGoal() };
    if (this.awaitingChoice) this.computeChoices();
    this.guideKey = '';
    this.emit('plan');
  }

  computeChoices() {
    const node = this.pos.node;
    if (!node) return;
    const goal = this.currentGoal();
    const out: Choice[] = [];
    for (const leg of this.world.adj.get(node)!) {
      if (this.world.blocked.has(leg.edgeId)) continue;
      const to = this.world.legTo(leg);
      const rest = to === goal ? [] : (this.bestPathFrom(to, goal, leg.edgeId) ?? []);
      const full = [leg, ...rest];
      const f = forecastRoute(this.world, this.health, this.mods, full, 0, this.paceV(), this.data.conditions.surfaceTempC, this.waitsFor(full));
      const m = this.world.metrics([leg]);
      const g = this.world.edges.get(leg.edgeId)!;
      const backtrack = leg.edgeId === this.arrivedVia ? 40 : 0;
      out.push({ leg, name: g.edge.name, metrics: m, forecast: f, score: this.score(f, this.world.metrics(full)) + backtrack, recommended: false, surface: g.edge.surface.replace('_', ' ') });
    }
    out.sort((a, b) => a.score - b.score);
    if (out[0]) out[0].recommended = true;
    this.choices = out;
  }

  private bestPathFrom(from: string, goal: string, excludeFirstEdge: string): Leg[] | null {
    let best: Leg[] | null = null;
    let bs = Infinity;
    for (const p of this.world.simplePaths(from, goal, 5)) {
      if (p[0]?.edgeId === excludeFirstEdge) continue;
      const f = forecastRoute(this.world, this.health, this.mods, p, 0, this.paceV(), this.data.conditions.surfaceTempC, this.waitsFor(p));
      const sc = this.score(f, this.world.metrics(p));
      if (sc < bs) {
        bs = sc;
        best = p;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- advisories
  private checkAdvisories() {
    if (this.incident || this.advisory || this.waitS > 0 || !this.plan) return;
    const h = this.health;
    if (h.fatigue < FATIGUE_REROUTE - 10) this.fatigueArmed = true;
    if (this.fatigueArmed && h.fatigue >= FATIGUE_REROUTE) {
      this.fatigueArmed = false;
      this.makeFatigueAdvisory();
      if (this.advisory) return;
    }
    if (this.met >= this.o2ArmedAt && this.plan.forecast.o2End < RESERVE_FRAC && this.goalOverride?.kind !== 'habitat') {
      this.o2ArmedAt = this.met + 600;
      const hab = this.data.mission.startNodeId;
      const best = this.bestCandidate(hab, { wO2: 2000 });
      if (best) {
        this.setAdvisory({
          title: 'REROUTE ADVISORY · O2 MARGIN',
          reason: `O2 forecast at habitat is ${(this.plan.forecast.o2End * 100).toFixed(0)}%, below the ${RESERVE_FRAC * 100}% reserve. Returning now via ${this.world.routeName(best.cand.full)} arrives with ${(best.f.o2End * 100).toFixed(0)}%.`,
          best,
          goalOverride: { node: hab, kind: 'habitat' },
        });
      }
    }
  }

  private makeFatigueAdvisory(manual = false) {
    const goal = this.currentGoal();
    const cur = this.plan!;
    const curLegs = this.legsToGoal(cur.route, goal);
    const curF = forecastRoute(this.world, this.health, this.mods, curLegs, cur.offset, this.paceV(), this.data.conditions.surfaceTempC, this.waitsFor(curLegs));
    const curM = this.world.metrics(curLegs, cur.offset);
    // prefer a genuinely different traverse; fall back to same traverse at slow pace
    const differs = (c: Candidate) => !sameRoute(c.full, curLegs) || c.turnBack;
    let best = this.bestCandidate(goal, { wF: 8 }, differs, PACE_V.slow);
    // an alternate only counts if it is actually gentler; otherwise advise slowing down on the same traverse
    if (!best || best.f.peakFatigue >= curF.peakFatigue - 2) best = this.bestCandidate(goal, { wF: 8 }, (c) => sameRoute(c.full, curLegs) && !c.turnBack, PACE_V.slow) ?? best;
    if (!best) return;
    const curName = this.world.routeName(curLegs) || 'Current traverse';
    const altName = (best.cand.turnBack ? 'Turn back via ' : '') + (this.world.routeName(best.cand.full) || 'hold position');
    const dt = (best.f.timeS - curF.timeS) / 60;
    const reasonHead = manual ? 'Crew requested reroute.' : `Fatigue index ${this.health.fatigue.toFixed(0)} exceeds ${FATIGUE_REROUTE}.`;
    const same = sameRoute(best.cand.full, curLegs);
    this.setAdvisory({
      title: manual ? 'REROUTE · CREW REQUEST' : 'REROUTE ADVISORY · FATIGUE',
      reason: same
        ? `${reasonHead} No gentler traverse to ${this.world.nodes.get(goal)!.name}. Slow pace on ${curName} lowers peak fatigue from ${curF.peakFatigue.toFixed(0)} to ${best.f.peakFatigue.toFixed(0)} for ${dt >= 0 ? '+' : ''}${dt.toFixed(0)} min.`
        : `${reasonHead} ${curName} forecasts peak fatigue ${curF.peakFatigue.toFixed(0)} (max slope ${curM.maxSlopeDeg.toFixed(0)}°). ${altName} at slow pace keeps it at ${best.f.peakFatigue.toFixed(0)} (max slope ${best.m.maxSlopeDeg.toFixed(0)}°) for ${dt >= 0 ? '+' : ''}${dt.toFixed(0)} min.`,
      best,
      pace: 'slow',
      current: { f: curF, m: curM },
    });
  }

  private legsToGoal(route: Leg[], goal: string) {
    const out: Leg[] = [];
    for (const l of route) {
      out.push(l);
      if (this.world.legTo(l) === goal) break;
    }
    return out;
  }

  private setAdvisory(a: { title: string; reason: string; best: { cand: Candidate; f: ForecastResult; m: RouteMetrics }; goalOverride?: Advisory['goalOverride']; pace?: Pace; current?: { f: ForecastResult; m: RouteMetrics } }) {
    const cur = a.current ? { forecast: a.current.f, metrics: a.current.m } : this.plan!;
    // alternative full-mission forecast for comparison: candidate to goal + rest of chain
    this.advisory = {
      title: a.title,
      reason: a.reason,
      cand: a.best.cand,
      goalOverride: a.goalOverride,
      pace: a.pace,
      current: cur.forecast,
      alt: a.best.f,
      currentMetrics: cur.metrics,
      altMetrics: a.best.m,
      altRoute: a.best.cand.full,
      altOffset: a.best.cand.offset,
    };
    this.stats.advisoriesShown++;
    this.addLog({ kind: 'reroute', title: a.title, severity: 'caution', outcome: a.reason });
    this.emit('advisory', this.advisory);
    this.emit('change');
  }

  requestReroute() {
    if (this.advisory) return this.acceptAdvisory();
    if (this.status !== 'active' || this.incident) return 'Not available';
    this.makeFatigueAdvisory(true);
    return this.advisory ? 'Alternate route proposed. Say "reroute" again to accept.' : 'No alternate route available';
  }

  acceptAdvisory() {
    const a = this.advisory;
    if (!a) return 'No advisory';
    this.advisory = null;
    if (a.goalOverride) this.goalOverride = a.goalOverride;
    if (a.pace) this.pace = a.pace;
    this.commitCandidate(a.cand);
    this.stats.advisoriesAccepted++;
    const entry = [...this.log].reverse().find((l) => l.kind === 'reroute' && l.title === a.title);
    if (entry) entry.decision = 'Accepted';
    this.toast('Reroute accepted');
    this.recomputePlan();
    this.emit('change');
    return 'Reroute accepted';
  }

  dismissAdvisory() {
    const a = this.advisory;
    if (!a) return;
    this.advisory = null;
    const entry = [...this.log].reverse().find((l) => l.kind === 'reroute' && l.title === a.title);
    if (entry) entry.decision = 'Dismissed';
    this.emit('change');
  }

  // ---------------------------------------------------------------- planner
  plannerAdd(e: number, n: number) {
    const node = this.world.nearestNode(e, n, 300);
    if (!node) return null;
    if (this.plannerNodes[this.plannerNodes.length - 1] !== node.id) this.plannerNodes.push(node.id);
    this.emit('planner');
    return node;
  }
  plannerClear() {
    this.plannerNodes = [];
    this.emit('planner');
  }
  plannerRoute(): { route: Leg[]; offset: number } | null {
    if (!this.plannerNodes.length) return null;
    const route: Leg[] = [];
    let offset = 0;
    let at: string;
    if (this.pos.leg) {
      route.push(this.pos.leg);
      offset = this.pos.s;
      at = this.world.legTo(this.pos.leg);
    } else at = this.pos.node!;
    for (const id of this.plannerNodes) {
      if (id === at) continue;
      const p = this.world.shortestPath(at, id);
      if (!p) return null;
      route.push(...p);
      at = id;
    }
    return { route, offset };
  }
  plannerEvaluate() {
    const r = this.plannerRoute();
    if (!r) return null;
    const metrics = this.world.metrics(r.route, r.offset);
    const forecast = forecastRoute(this.world, this.health, this.mods, r.route, r.offset, this.paceV(), this.data.conditions.surfaceTempC, this.waitsFor(r.route));
    return { ...r, metrics, forecast };
  }
  plannerCommit() {
    const r = this.plannerRoute();
    if (!r) return false;
    this.committed = this.pos.leg ? r.route.slice(1) : r.route;
    this.goalOverride = null;
    this.addLog({ kind: 'decision', title: 'Crew-planned route committed', severity: 'info', decision: this.world.routeName(r.route) });
    this.plannerNodes = [];
    this.recomputePlan();
    this.emit('planner');
    this.emit('change');
    return true;
  }

  // ---------------------------------------------------------------- fog & discovery
  fogIndex(e: number, n: number) {
    const { originE, originN, cell, width } = this.data.elevation;
    const size = cell * (width - 1);
    const x = Math.floor(((e - originE) / size) * FOG_N);
    const y = Math.floor(((originN - n) / size) * FOG_N);
    if (x < 0 || y < 0 || x >= FOG_N || y >= FOG_N) return -1;
    return y * FOG_N + x;
  }
  revealAround(e: number, n: number, r: number): number {
    const { originE, originN, cell, width } = this.data.elevation;
    const size = cell * (width - 1);
    const cs = size / FOG_N;
    let added = 0;
    for (let dy = -r; dy <= r; dy += cs) {
      for (let dx = -r; dx <= r; dx += cs) {
        if (dx * dx + dy * dy > r * r) continue;
        const i = this.fogIndex(e + dx, n + dy);
        if (i >= 0 && !this.fog[i]) {
          this.fog[i] = 1;
          added++;
        }
      }
    }
    if (added) this.emit('fog');
    void originE;
    void originN;
    return added;
  }
  private discoverNear(e: number, n: number, r: number, by: 'visual' | 'drone') {
    for (const p of this.data.pois) {
      if (this.discovered.has(p.id)) continue;
      if (Math.hypot(p.e - e, p.n - n) <= r + (p.radius ?? 0)) {
        this.discovered.add(p.id);
        this.toast(by === 'drone' ? `Drone identified hazard: ${p.name}` : `Hazard sighted: ${p.name}`);
        this.addLog({ kind: 'hazard', title: `Hazard mapped: ${p.name}`, severity: 'caution', outcome: by === 'drone' ? 'Detected by drone scout' : 'Visual sighting' });
        this.emit('change');
      }
    }
  }
  static FOG_N = FOG_N;

  // ---------------------------------------------------------------- drone
  launchDrone(mode: 'scout' | 'relay' = 'scout'): string {
    if (this.status !== 'active') return 'EVA not active';
    if (this.drone.active) return 'Drone already airborne';
    if (this.drone.battery < 15) return 'Drone battery too low';
    const p = this.position();
    const path: [number, number][] = [];
    if (mode === 'scout' && this.plan) {
      let acc = 0;
      this.plan.route.forEach((leg, i) => {
        if (acc > 1100) return;
        for (const s of this.world.legSamples(leg, i === 0 ? this.plan!.offset : 0)) {
          if (acc > 1100) break;
          const last = path[path.length - 1];
          if (last) acc += Math.hypot(s.e - last[0], s.n - last[1]);
          if (!last || Math.hypot(s.e - last[0], s.n - last[1]) > 20) path.push([s.e, s.n]);
        }
      });
    }
    this.drone = { ...this.drone, active: true, mode, e: p.e, n: p.n, alt: 2, path, idx: 0 };
    this.addLog({ kind: 'info', title: mode === 'relay' ? 'Drone launched as comms relay' : 'Drone scout launched', severity: 'info' });
    this.toast(mode === 'relay' ? 'Drone relay airborne: link restored' : 'Drone scout launched along planned route');
    this.emit('change');
    return mode === 'relay' ? 'Drone relay launched' : 'Drone scout launched';
  }
  recallDrone() {
    if (this.drone.active) this.drone.mode = 'returning';
  }
  private updateDrone(dt: number) {
    const d = this.drone;
    if (!d.active) {
      d.battery = Math.min(100, d.battery + dt * 0.02);
      return;
    }
    d.battery -= (dt / 600) * 100;
    d.alt += (30 - d.alt) * Math.min(1, dt / 4);
    const me = this.position();
    let target: [number, number] | null = null;
    if (d.mode === 'scout') {
      target = d.path[d.idx] ?? null;
      if (!target) d.mode = 'returning';
    } else if (d.mode === 'relay' || d.mode === 'hold') target = [me.e, me.n];
    if (d.mode === 'returning') target = [me.e, me.n];
    if (target) {
      const dx = target[0] - d.e;
      const dy = target[1] - d.n;
      const dist = Math.hypot(dx, dy);
      const sp = 9 * dt;
      if (dist > 0.5) {
        d.heading = Math.atan2(dx, dy);
        const k = Math.min(1, sp / dist);
        d.e += dx * k;
        d.n += dy * k;
      }
      if (d.mode === 'scout' && dist < 12) d.idx++;
      if (d.mode === 'returning' && dist < 8) {
        d.active = false;
        d.alt = 0;
        this.toast(`Drone recovered · revealed ${(d.revealedCells * (4000 / FOG_N) ** 2 / 1e6).toFixed(2)} km²`);
        this.addLog({ kind: 'info', title: 'Drone recovered', severity: 'info', outcome: `${(d.revealedCells * (4000 / FOG_N) ** 2 / 1e6).toFixed(2)} km² revealed` });
      }
    }
    d.revealedCells += this.revealAround(d.e, d.n, 230);
    this.discoverNear(d.e, d.n, 200, 'drone');
    if (d.battery <= 5 && d.mode !== 'returning') d.mode = 'returning';
  }

  // ---------------------------------------------------------------- end
  private endMission() {
    const done = this.data.mission.objectives.filter((o) => o.kind === 'sample').every((o) => this.objectivesDone.has(o.id));
    this.objectivesDone.add(this.data.mission.objectives.find((o) => o.kind === 'return')?.id ?? 'return');
    this.status = done ? 'success' : 'aborted';
    this.addLog({ kind: 'info', title: done ? 'Ingress: EVA complete' : 'Ingress: EVA aborted, crew safe', severity: 'info' });
    this.emit('end');
    this.emit('change');
  }
  private fail(reason: string) {
    this.status = 'failed';
    this.failReason = reason;
    this.addLog({ kind: 'failure', title: `EVA TERMINATED: ${reason}`, severity: 'emergency' });
    this.emit('end');
    this.emit('change');
  }

  exportLog() {
    return {
      mission: this.data.mission.id,
      dataset: this.data.label,
      status: this.status,
      failReason: this.failReason || undefined,
      metS: Math.round(this.met),
      distanceM: Math.round(this.stats.distance),
      objectivesDone: [...this.objectivesDone],
      final: this.health,
      log: this.log,
      history: this.history,
      fieldNotes: this.marks,
      terrain: this.stats2,
      ...this.extra,
    };
  }
}

export function poiById(pois: Poi[], id: string) {
  return pois.find((p) => p.id === id);
}

export { sameRoute };
