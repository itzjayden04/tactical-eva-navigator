/**
 * TEVAN HUD controller. Binds simulation state to the visor DOM by element ID
 * (the Stitch contract: a re-generated layout keeps working if the IDs stay).
 *
 * Layout philosophy: one "dynamic island" at the top carries everything
 * transient (alerts, decisions, advisories, answers), so the rest of the visor
 * stays calm: halo rings for life support (left), a radar (right), and a dock
 * of four features (bottom) whose halos show each feature's progress.
 */
import type { DataBundle } from '../data/types';
import { Sim, PACE_V } from '../core/sim';
import { bandCore, bandDose, bandFatigue, bandFrac, bandHr, Band, RESERVE_FRAC, FATIGUE_REROUTE } from '../core/health';
import { walkSpeed } from '../core/route';
import { LAYER_INFO, LayerId, TacticalMap } from './map';
import { drawChart } from './chart';
import type { World } from '../render/scene';
import type { FeatureId } from './voice';
import { TAG_INFO, TAG_KINDS, type Guardian, type Pick } from '../core/guardian';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function fmtMET(s: number) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
export function fmtDur(s: number) {
  if (!isFinite(s) || s > 360000) return '—';
  if (s <= 0) return '0 min';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}
const say = (s: number) => {
  if (!isFinite(s) || s > 360000) return 'no limit';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} hour${h > 1 ? 's' : ''} ${m} minutes` : `${m} minutes`;
};
export const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const bandCls = (b: Band) => (b === 'ok' ? 'ok' : b);
const worst = (...b: Band[]): Band => (b.includes('warning') ? 'warning' : b.includes('caution') ? 'caution' : 'ok');
const RING = 2 * Math.PI * 19;
const DOCK_RING = 2 * Math.PI * 20;

export interface Detail {
  icon: string;
  title: string;
  big: string;
  band?: Band;
  bar?: number;
  rows: [string, string, string?][];
  chart?: boolean;
  speech: string;
  /** gaze / click buttons under the rows (emergency menu, tools, tag types) */
  acts?: Act[];
  cols?: 2 | 3 | 4;
  oneCol?: boolean;
  img?: string;
  hint?: string;
}
export interface Act {
  id: string;
  label: string;
  icon: string;
  sub?: string;
  color?: string;
  danger?: boolean;
  on?: boolean;
}

type IslandKind = 'incident' | 'advisory' | 'junction' | 'wait' | 'detail' | 'note' | 'sample' | 'idle';

export const FEATURE_LABEL: Record<string, string> = {
  mission: 'Mission',
  o2: 'Oxygen',
  h2o: 'Cooling water',
  power: 'Suit battery',
  dose: 'Radiation dose',
  fatigue: 'Fatigue',
  map: 'Map',
  route: 'Route',
  drone: 'Drone scout',
  sample: 'Samples',
  layers: 'Map layers',
  tools: 'Tools',
  emergency: 'Emergency',
  team: 'Team',
  supplies: 'Supply caches',
  systems: 'Suit systems',
  weather: 'Weather',
  tags: 'Tags',
  log: 'Mission log',
  'log-close': 'Close log',
};

export const EMERGENCY_ACTS = (g: Guardian | null, sim: Sim): Act[] => [
  { id: 'act:help', label: 'Call for help', icon: 'sos', sub: g?.helpCalled ? 'sent' : 'mayday + position', danger: true, on: g?.helpCalled },
  { id: 'act:habitat', label: 'Back to habitat', icon: 'home', sub: 'safest route home' },
  { id: 'act:shelter', label: 'Nearest shelter', icon: 'shield', sub: 'radiation / storm' },
  { id: 'act:cache', label: 'Resupply', icon: 'inventory_2', sub: 'nearest cache' },
  { id: 'act:rest', label: 'Rest 5 min', icon: 'self_improvement', sub: 'lower heart rate' },
  { id: 'act:stability', label: 'Stability assist', icon: 'accessibility_new', sub: sim.stability ? 'on' : 'off', on: sim.stability },
];
export const TOOL_ACTS: Act[] = [
  { id: 'tool:team', label: 'Team', icon: 'group' },
  { id: 'tool:supplies', label: 'Supplies', icon: 'inventory_2' },
  { id: 'tool:systems', label: 'Systems', icon: 'memory' },
  { id: 'tool:weather', label: 'Weather', icon: 'air' },
  { id: 'tool:tags', label: 'Tags', icon: 'sell' },
  { id: 'tool:log', label: 'Log', icon: 'history' },
  { id: 'act:photo', label: 'Photo', icon: 'photo_camera' },
  { id: 'act:what', label: 'What is this', icon: 'center_focus_strong' },
];
export const TAG_ACTS: Act[] = TAG_KINDS.map((k) => ({ id: `tagkind:${k}`, label: TAG_INFO[k].label, icon: TAG_INFO[k].icon, color: TAG_INFO[k].color }));

export class Hud {
  map: TacticalMap;
  mapExpanded = false;
  planning = false;
  private t = 0;
  private acc = 0;
  private detail: { id: string; until: number; build: () => Detail } | null = null;
  private note: { html: string; until: number } | null = null;
  private lastIslandHtml = '';
  private lastKind: IslandKind = 'idle';
  private waitMax = 0;
  onIslandOpen: (kind: IslandKind) => void = () => {};
  guardian: Guardian | null = null;
  /** what the astronaut is looking at in the world (drives the selection outline) */
  focus: Pick | null = null;
  focusSelUntil = 0;
  /** live sensor states for the Systems card, set by the app */
  sensors = { mic: 'Off', cam: 'Off', micOk: false, camOk: false, gaze: 'Pointer' };
  logOpen = false;
  private logDirty = true;

  constructor(private data: DataBundle, private sim: Sim, private world: World) {
    this.map = new TacticalMap(data, sim);
    this.buildLayerChips();
    this.buildCompass();
    $('brief-datasource').textContent = `DATA: ${data.label}`;
    sim.on('toast', (m: string) => this.notify(m));
    sim.on('change', () => this.refreshStatic());
    sim.on('planner', () => this.refreshPlanner());
    sim.on('say', (m: { text: string; who: string; icon: string }) => this.showSay(m.text, m.who, m.icon));
    sim.on('log', () => (this.logDirty = true));
    sim.on('comms', () => (this.logDirty = true));
  }

  // ------------------------------------------------------------ layers
  private buildLayerChips() {
    const ids: LayerId[] = ['radiation', 'slope', 'poi', 'dust', 'mag', 'fog'];
    const c = $('mx-layers');
    c.innerHTML = '';
    for (const id of ids) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.id = `mx-lyr-${id}`;
      b.dataset.layer = id;
      b.dataset.gaze = `layer:${id}`;
      b.dataset.gazeLabel = `${LAYER_INFO[id].label} layer`;
      b.innerHTML = `<i style="background:${LAYER_INFO[id].swatch}"></i>${LAYER_INFO[id].label}<span class="state"></span>`;
      c.appendChild(b);
    }
    this.syncChips();
  }
  toggleLayer(id: LayerId, on?: boolean) {
    const v = this.map.toggle(id, on);
    this.syncChips();
    return v;
  }
  activeLayers() {
    return (['radiation', 'slope', 'dust', 'mag'] as LayerId[]).filter((l) => this.map.layers[l]);
  }
  syncChips() {
    document.querySelectorAll<HTMLElement>('.chip[data-layer]').forEach((c) => {
      const on = this.map.layers[c.dataset.layer as LayerId];
      c.classList.toggle('on', on);
      (c.querySelector('.state') as HTMLElement).textContent = on ? 'On' : 'Off';
    });
    const leg: string[] = [];
    for (const id of this.activeLayers()) {
      const img = this.map.images[id];
      leg.push(`<div><b style="color:${LAYER_INFO[id].swatch}">●</b> ${LAYER_INFO[id].legend}${img ? ` · ${img.min.toFixed(1)}–${img.max.toFixed(1)}` : ''}</div>`);
    }
    $('mx-legend').innerHTML = leg.join('') || '<div>No overlays active</div>';
    $('radar-layers').innerHTML = this.activeLayers()
      .map((l) => `<span style="--c:${LAYER_INFO[l].swatch}">${LAYER_INFO[l].label}</span>`)
      .join('');
  }

  // ------------------------------------------------------------ compass
  private buildCompass() {
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let d = -360; d <= 720; d += 15) {
      const dd = ((d % 360) + 360) % 360;
      const label = names[dd] ?? (dd % 45 === 0 ? String(dd) : '');
      html += `<span class="${names[dd] ? 'major' : label ? '' : 'tick'}" style="left:${d * 2.4}px">${label || '·'}</span>`;
    }
    $('compass-tape').innerHTML = html;
  }
  private updateCompass() {
    const hd = this.world.heading();
    const w = $('hud-compass').clientWidth;
    $('compass-tape').style.transform = `translateX(${w / 2 - hd * 2.4}px)`;
    const tgt = $('hud-compass-target');
    const d = this.bearingDelta();
    if (d !== null) {
      tgt.style.left = `${Math.max(6, Math.min(w - 6, w / 2 + d * 2.4))}px`;
      tgt.style.display = '';
    } else tgt.style.display = 'none';
    this.map.headingRad = (hd * Math.PI) / 180;
  }
  /** degrees from view heading to the next waypoint (−180..180) */
  bearingDelta(): number | null {
    const wp = this.sim.nextWaypoint();
    if (!wp) return null;
    const p = this.sim.position();
    const brg = ((Math.atan2(wp.e - p.e, wp.n - p.n) * 180) / Math.PI + 360) % 360;
    let d = brg - this.world.heading();
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  // ------------------------------------------------------------ per-frame
  update(dt: number) {
    this.t += dt;
    this.updateCompass();
    this.updateChevrons();
    this.updateFocus();
    this.map.drawRadar($('map-canvas') as HTMLCanvasElement, { t: this.t, rangeM: 650 });
    if (this.mapExpanded) this.map.draw($('map-canvas-large') as HTMLCanvasElement, { planner: this.sim.plannerRoute(), large: true, t: this.t });
    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;
    this.updateTelemetry();
    this.renderIsland();
    if (this.logOpen && this.logDirty) this.renderLog();
  }

  // ------------------------------------------------------------ selection outline ("what is this", "label this")
  private updateFocus() {
    const el = $('focus-ring');
    const f = this.focus;
    if (!f || f.type === 'sky') {
      el.classList.remove('on');
      return;
    }
    const en = f.type === 'entity' ? this.guardian?.entity(f.id!) : null;
    const pr = this.world.project(en ? en.e : f.e, en ? en.n : f.n, f.up);
    if (!pr.visible) {
      el.classList.remove('on');
      return;
    }
    const size = f.type === 'ground' ? 46 : Math.max(44, Math.min(320, (f.size / Math.max(1, pr.dist)) * this.world.focalPx() * 2.5));
    el.style.width = el.style.height = `${size.toFixed(0)}px`;
    el.style.transform = `translate(${(pr.x - size / 2).toFixed(0)}px, ${(pr.y - size / 2).toFixed(0)}px)`;
    el.classList.add('on');
    el.classList.toggle('ground', f.type === 'ground');
    el.classList.toggle('sel', this.t < this.focusSelUntil);
    $('focus-label').textContent = f.type === 'ground' ? `${km(pr.dist)}` : `${f.name} · ${km(pr.dist)}`;
  }
  /** Flash the outline green: "got it, this is what you meant". */
  confirmFocus() {
    this.focusSelUntil = this.t + 1.2;
  }

  // ------------------------------------------------------------ mission log + conversation
  setLog(open: boolean) {
    this.logOpen = open;
    $('log-panel').classList.toggle('hidden', !open);
    this.logDirty = true;
    if (open) this.renderLog();
  }
  private renderLog() {
    this.logDirty = false;
    const s = this.sim;
    type Row = { met: number; cls: string; icon: string; text: string; sub?: string };
    const rows: Row[] = s.log.map((l) => ({ met: l.met, cls: l.severity, icon: l.kind === 'incident' ? 'warning' : l.kind === 'reroute' ? 'alt_route' : l.kind === 'sample' ? 'science' : l.kind === 'hazard' ? 'report' : l.kind === 'decision' ? 'check_circle' : l.kind === 'failure' ? 'dangerous' : 'info', text: l.title, sub: [l.decision, l.outcome].filter(Boolean).join(' · ') }));
    for (const c of this.guardian?.comms ?? []) rows.push({ met: c.met, cls: c.who, icon: c.who === 'you' ? 'record_voice_over' : c.who === 'tevan' ? 'smart_toy' : c.who === 'ev2' ? 'person' : c.who === 'hab' ? 'cell_tower' : 'info', text: c.who === 'you' ? `“${c.text}”` : c.text, sub: c.who === 'you' ? 'You' : c.who === 'tevan' ? 'TEVAN' : c.who === 'ev2' ? 'EV-2' : c.who === 'hab' ? 'Habitat' : '' });
    rows.sort((a, b) => a.met - b.met);
    const last = rows.slice(-70);
    $('lp-count').textContent = `${rows.length} entries`;
    const list = $('lp-list');
    list.innerHTML = last.map((r) => `<div class="lp-row ${r.cls}"><span class="t">${fmtMET(r.met).slice(0, 5)}</span><span class="ms">${r.icon}</span><span>${esc(r.text)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></div>`).join('');
    list.scrollTop = list.scrollHeight;
  }

  private halo(id: string, frac: number, text: string, band: Band) {
    const el = $(id);
    const arc = el.querySelector('.arc') as SVGCircleElement;
    arc.style.strokeDasharray = `${Math.max(0, Math.min(1, frac)) * RING} ${RING}`;
    el.dataset.band = band;
    (el.querySelector('b') as HTMLElement).textContent = text;
  }
  private dockHalo(id: string, frac: number, state = '') {
    const el = $(id);
    (el.querySelector('.arc') as SVGCircleElement).style.strokeDasharray = `${Math.max(0, Math.min(1, frac)) * DOCK_RING} ${DOCK_RING}`;
    el.dataset.state = state;
  }

  /** fraction of the planned mission distance already walked */
  routeProgress() {
    const walked = this.sim.stats.distance;
    const left = this.sim.plan?.metrics.distance ?? 0;
    return walked + left > 0 ? walked / (walked + left) : 0;
  }

  updateTelemetry() {
    const s = this.sim;
    const h = s.health;
    const agg = s.agg();
    const o2f = h.o2g / h.o2Cap;
    const wf = h.waterg / h.waterCap;
    const bf = h.battWh / h.battCap;
    const budget = s.data.mission.consumables.doseBudgetmSv;
    this.halo('h-o2', o2f, `${(o2f * 100).toFixed(0)}`, bandFrac(o2f));
    this.halo('h-h2o', wf, `${(wf * 100).toFixed(0)}`, bandFrac(wf));
    this.halo('h-power', bf, `${(bf * 100).toFixed(0)}`, bandFrac(bf));
    const db = bandDose(h.doseMSv, budget);
    this.halo('h-dose', h.doseMSv / budget, h.doseMSv < 10 ? h.doseMSv.toFixed(1) : h.doseMSv.toFixed(0), s.rates.doseRate > 200 ? 'warning' : db);
    this.halo('h-fatigue', h.fatigue / 100, h.fatigue.toFixed(0), bandFatigue(h.fatigue));
    $('h-fatigue').classList.toggle('pulse', !!s.advisory && s.advisory.title.includes('FATIGUE'));
    $('h-dose').classList.toggle('pulse', s.rates.doseRate > 200);

    const hr = $('v-hr');
    hr.textContent = h.hr.toFixed(0);
    hr.dataset.band = bandHr(h.hr);
    const p = s.position();
    const eta = s.pos.leg && s.offTrack < 30 ? s.world.edges.get(s.pos.leg.edgeId)!.eta : 1.4;
    $('v-speed').textContent = s.isMoving() ? walkSpeed(PACE_V[s.pace] * (s.input.sprint ? 1.35 : 1), p.gradePct, eta, agg.speedCap, agg.dust).toFixed(1) : '0.0';
    $('v-pace').textContent = s.pace.toUpperCase();

    // dock halos = each feature's progress
    const samples = s.data.mission.objectives.filter((o) => o.kind === 'sample');
    const got = samples.filter((o) => s.objectivesDone.has(o.id)).length;
    this.dockHalo('dock-route', this.routeProgress(), s.advisory ? 'alert' : '');
    this.dockHalo('dock-drone', s.drone.battery / 100, s.drone.active ? 'live' : '');
    this.dockHalo('dock-sample', got / Math.max(1, samples.length), s.samplePrompt && s.waitS <= 0 ? 'ready' : '');
    this.dockHalo('dock-layers', this.activeLayers().length / 4, this.activeLayers().length ? 'live' : '');
    const g = this.guardian;
    this.dockHalo('dock-tools', g ? Math.min(1, g.tags.length / 6) : 0, g && g.tags.length ? 'live' : '');
    this.dockHalo('dock-sos', g?.helpCalled ? 1 : 0, g?.helpCalled ? 'live' : '');
    // status chips: everything that is "on" right now is visible at a glance
    const chips: string[] = [];
    const chip = (cls: string, icon: string, text: string) => chips.push(`<span class="${cls}"><span class="ms">${icon}</span>${esc(text)}</span>`);
    if (g?.helpCalled) chip('warning', 'sos', `Help en route · EV-2 ${km(Math.hypot((g.entity('ev2')?.e ?? p.e) - p.e, (g.entity('ev2')?.n ?? p.n) - p.n))}`);
    if (s.detour) chip('nav', 'near_me', `Nav: ${s.detour.label}`);
    else if (s.goalOverride) chip('caution', 'alt_route', s.goalOverride.kind === 'habitat' ? 'Returning to habitat' : 'Diverting to shelter');
    if (s.stability) chip('ok', 'accessibility_new', 'Stability assist');
    for (const m of s.mods) {
      if (m.delayS && m.delayS > 0) chip('caution', 'schedule', `${m.label} in ${fmtDur(m.delayS)}`);
      else chip(m.spec.doseMult || m.spec.leakGph ? 'warning' : 'caution', m.spec.dust ? 'air' : m.spec.doseMult ? 'radiology' : m.spec.commsLoss ? 'signal_disconnected' : 'build', m.label);
    }
    if (s.world.blocked.size) chip('caution', 'landslide', `${[...s.world.blocked].map((id) => s.world.edges.get(id)!.edge.name).join(', ')} blocked`);
    if (s.body.fallT <= 0 && s.isMoving() && s.risk > 0.0022) chip('caution', 'do_not_step', 'Poor footing');
    if (s.pace !== 'nominal') chip('', 'speed', `${s.pace} pace`);
    const ch = chips.slice(0, 6).join('');
    const sc = $('status-chips');
    if (sc.dataset.h !== ch) {
      sc.dataset.h = ch;
      sc.innerHTML = ch;
    }
    $('hud').classList.toggle('fallen', s.body.fallT > 0.3);

    // radar caption
    const wp = s.nextWaypoint();
    $('r-next').textContent = (s.offTrack > 30 ? `Off track ${s.offTrack.toFixed(0)} m · ` : '') + (wp ? `${wp.name} · ${km(wp.dist)}` : 'No waypoint');
    $('r-next').classList.toggle('caution', s.offTrack > 30);
    $('r-eta').textContent = s.plan ? `Habitat ${fmtDur(s.plan.forecast.timeS)}` : '';

    // drone PIP
    const d = s.drone;
    document.body.classList.toggle('drone-live', d.active);
    $('drone-status').textContent = d.active ? `${d.mode.toUpperCase()} · ALT ${d.alt.toFixed(0)} m · ${Math.hypot(d.e - p.e, d.n - p.n).toFixed(0)} m · ${d.battery.toFixed(0)}%` : '';

    // radiation: red visor rim when the dose rate is high
    const rate = s.rates.doseRate;
    $('dose-vignette').style.opacity = String(Math.min(0.9, Math.max(0, (rate - 60) / 1500)));
    this.world.alertFlash = s.incident && s.incident.def.severity === 'emergency' ? 0.25 + 0.25 * Math.sin(this.t * 8) : 0;

    // wait bookkeeping (for the island progress bar)
    if (s.waitS > 0) this.waitMax = Math.max(this.waitMax, s.waitS);
    else this.waitMax = 0;
    if (this.mapExpanded) this.refreshPlanner();
  }

  // ------------------------------------------------------------ world-anchored markers
  private updateChevrons() {
    const s = this.sim;
    const items: string[] = [];
    const W = window.innerWidth;
    const H = window.innerHeight;
    const add = (e: number, n: number, up: number, cls: string, label: string) => {
      const pr = this.world.project(e, n, up);
      if (!pr.visible || pr.x < -40 || pr.x > W + 40 || pr.y < -40 || pr.y > H + 40) return false;
      items.push(`<div class="wp ${cls}" style="transform:translate(${pr.x.toFixed(0)}px,${pr.y.toFixed(0)}px)"><div class="lab">${label}</div></div>`);
      return true;
    };
    const wp = s.nextWaypoint();
    if (wp && s.status === 'active') {
      if (!add(wp.e, wp.n, s.detour ? 3 : 6, s.detour ? 'target nav' : 'target', `${esc(wp.name)} <b>${km(wp.dist)}</b>`)) {
        const d = this.bearingDelta() ?? 0;
        items.push(`<div class="wp edge ${d > 0 ? 'r' : 'l'}" style="transform:translate(${d > 0 ? W * 0.8 : W * 0.2}px,${H * 0.5}px)"><div class="lab">${d > 0 ? '' : '‹ '}${esc(wp.name)}${d > 0 ? ' ›' : ''}</div></div>`);
      }
    }
    const me = s.position();
    for (const poi of s.data.pois) {
      if (!s.discovered.has(poi.id)) continue;
      const dist = Math.hypot(poi.e - me.e, poi.n - me.n);
      if (dist > 1600 || (wp && Math.hypot(poi.e - wp.e, poi.n - wp.n) < 30)) continue;
      if (poi.kind === 'hazard') add(poi.e, poi.n, 2, 'hz', `<span class="ms">warning</span>${esc(poi.name)} <b>${km(Math.max(0, dist - (poi.radius ?? 0)))}</b>`);
      else if (poi.kind === 'cache') {
        if (dist < 900 && dist > 6) add(poi.e, poi.n, 3, 'cache', `<span class="ms">inventory_2</span>${esc(poi.name)}${this.guardian?.cachesUsed.has(poi.id) ? ' · used' : ''} <b>${km(dist)}</b>`);
      } else if (dist > 25 && this.map.layers.poi) add(poi.e, poi.n, 8, 'poi', `${esc(poi.name)} <b>${km(dist)}</b>`);
    }
    const g = this.guardian;
    if (g) {
      const tagged = new Set(g.tags.map((t) => t.follow).filter(Boolean));
      for (const en of g.entities) {
        if (tagged.has(en.id)) continue;
        const dist = Math.hypot(en.e - me.e, en.n - me.n);
        if (en.kind === 'teammate' && dist > 4) add(en.e, en.n, 2.6, 'crew', `<span class="ms">person</span>${esc(en.name)} <b>${km(dist)}</b>`);
      }
      for (const t of g.tags) {
        const pos = g.tagPos(t);
        const dist = Math.hypot(pos.e - me.e, pos.n - me.n);
        if (s.detour?.id === `tag:${t.id}`) continue;
        const pr = this.world.project(pos.e, pos.n, t.up + (t.follow ? 2.7 : 2.2));
        if (!pr.visible || pr.x < -40 || pr.x > W + 40 || pr.y < -40 || pr.y > H + 40) continue;
        items.push(`<div class="wp tag" style="--c:${TAG_INFO[t.kind].color};transform:translate(${pr.x.toFixed(0)}px,${pr.y.toFixed(0)}px)"><div class="lab"><span class="ms">${TAG_INFO[t.kind].icon}</span>${esc(t.label)} <b>${km(dist)}</b></div></div>`);
      }
    }
    $('hud-chevrons').innerHTML = items.join('');
  }

  // ------------------------------------------------------------ dynamic island
  /** TEVAN (or the crew) speaking: shown as a caption so the dialogue is readable as well as audible. */
  showSay(text: string, who = 'tevan', icon = 'smart_toy') {
    const name = who === 'ev2' ? 'EV-2' : who === 'hab' ? 'Habitat' : 'TEVAN';
    this.note = { html: `<div class="i-say who-${who}"><span class="ms">${icon}</span><span><small>${name}</small>${esc(text)}</span></div>`, until: this.t + Math.min(12, 3.5 + text.length * 0.055) };
    this.renderIsland();
  }
  notify(msg: string, icon = 'info', ttl = 4) {
    if (this.note && this.t < this.note.until && this.note.html.includes('i-say') && icon === 'info') return; // don't let a routine toast cut off a spoken line
    this.note = { html: `<div class="i-note"><span class="ms">${icon}</span><span>${esc(msg)}</span></div>`, until: this.t + ttl };
    this.renderIsland();
  }
  /** Expand the island with a live detail card for a feature. */
  showDetail(id: string, build: () => Detail, ttl = 8) {
    this.detail = { id, until: this.t + ttl, build };
    this.renderIsland();
  }
  closeDetail() {
    this.detail = null;
    this.note = null;
    this.renderIsland();
  }
  get islandKind() {
    return this.lastKind;
  }

  refreshStatic() {
    this.renderIsland();
  }

  private renderIsland() {
    const s = this.sim;
    let kind: IslandKind = 'idle';
    let html = '';
    if (s.status !== 'active') return;
    if (s.incident) [kind, html] = ['incident', this.incidentHtml()];
    else if (s.advisory) [kind, html] = ['advisory', this.advisoryHtml()];
    else if (this.detail && this.t < this.detail.until) [kind, html] = ['detail', this.detailHtml(this.detail.build())];
    else if (this.note && this.t < this.note.until && this.note.html.includes('i-say')) [kind, html] = ['note', this.note.html];
    else if (s.awaitingChoice && s.waitS <= 0) [kind, html] = ['junction', this.junctionHtml()];
    else if (s.waitS > 0) [kind, html] = ['wait', this.waitHtml()];
    else if (this.note && this.t < this.note.until) [kind, html] = ['note', this.note.html];
    else if (s.samplePrompt) [kind, html] = ['sample', `<div class="i-note ok"><span class="ms">science</span><span>Sample site · ${esc(s.samplePrompt)}</span><em>say “mark sample”</em></div>`];
    else [kind, html] = ['idle', this.idleHtml()];
    if (this.detail && this.t >= this.detail.until) this.detail = null;
    const island = $('island');
    if (kind !== this.lastKind) {
      island.className = `k-${kind}`;
      if (['incident', 'advisory', 'junction', 'detail'].includes(kind)) this.onIslandOpen(kind);
      this.lastKind = kind;
    }
    if (html !== this.lastIslandHtml) {
      const content = $('island-content');
      content.innerHTML = html;
      this.lastIslandHtml = html;
      // size the island to its content so width/height animate (dynamic-island morph)
      island.style.width = `${content.offsetWidth}px`;
      island.style.height = `${content.offsetHeight}px`;
      const cv = content.querySelector<HTMLCanvasElement>('canvas.i-chart');
      if (cv) this.drawRouteChart(cv);
    }
  }

  private idleHtml() {
    const s = this.sim;
    const h = s.health;
    const agg = s.agg();
    const relay = s.drone.active && s.drone.mode === 'relay';
    const los = agg.commsLoss && !relay;
    const b = worst(bandFrac(h.o2g / h.o2Cap), bandFrac(h.waterg / h.waterCap), bandFrac(h.battWh / h.battCap), bandFatigue(h.fatigue), bandCore(h.coreC));
    const wp = s.nextWaypoint();
    const d = this.bearingDelta();
    const lmst = (s.data.mission.startLmstH + (s.met / 3600) * (24 / 24.66)) % 24;
    const lm = `${String(Math.floor(lmst)).padStart(2, '0')}:${String(Math.floor((lmst % 1) * 60)).padStart(2, '0')}`;
    return `<div class="i-idle"><i class="i-dot ${bandCls(b)}"></i><span class="i-met">${fmtMET(s.met)}</span>${
      wp ? `<span class="i-sep"></span><span class="ms i-arrow" style="transform:rotate(${(d ?? 0).toFixed(0)}deg)">navigation</span><span class="i-next">${esc(wp.name)}</span><b>${km(wp.dist)}</b>` : ''
    }<span class="i-sep"></span><span class="i-dim">${lm} LMST</span>${los ? '<span class="i-los">COMMS LOS</span>' : relay ? '<span class="i-relay">RELAY</span>' : ''}${s.warp !== 10 ? `<span class="i-dim">×${s.warp}</span>` : ''}</div>`;
  }

  private waitHtml() {
    const s = this.sim;
    const frac = this.waitMax > 0 ? 1 - s.waitS / this.waitMax : 0;
    return `<div class="i-wait"><span class="ms">hourglass_top</span><span>${esc(s.waitReason.charAt(0) + s.waitReason.slice(1).toLowerCase())}</span><b>${fmtDur(s.waitS)}</b><div class="i-bar"><i style="width:${(frac * 100).toFixed(0)}%"></i></div></div>`;
  }

  private detailHtml(d: Detail) {
    const rows = d.rows.map(([k, v, c]) => `<div><span>${esc(k)}</span><b class="${c ?? ''}">${v}</b></div>`).join('');
    return `<div class="i-card i-detail"><div class="i-head"><span class="ms">${d.icon}</span><span class="i-title">${esc(d.title)}</span><b class="i-big ${d.band ? bandCls(d.band) : ''}">${d.big}</b></div>${
      d.bar !== undefined ? `<div class="i-bar ${d.band ? bandCls(d.band) : ''}"><i style="width:${(Math.max(0, Math.min(1, d.bar)) * 100).toFixed(0)}%"></i></div>` : ''
    }${d.img ? `<img class="i-photo" src="${d.img}" alt="" />` : ''}${rows ? `<div class="i-rows ${d.oneCol ? 'one' : ''}">${rows}</div>` : ''}${
      d.acts ? `<div class="i-acts ${d.cols === 2 ? 'two' : d.cols === 4 ? 'four' : ''}">${d.acts.map((a) => `<button class="i-act ${a.danger ? 'danger' : ''} ${a.on ? 'on' : ''}" data-gaze="${a.id}" data-gaze-label="${esc(a.label)}" ${a.color ? `style="--c:${a.color}"` : ''}><span class="ms">${a.icon}</span>${esc(a.label)}${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</button>`).join('')}</div>` : ''
    }${d.chart ? '<canvas class="i-chart"></canvas>' : ''}${d.hint ? `<div class="i-hint">${esc(d.hint)}</div>` : ''}</div>`;
  }

  private drawRouteChart(cv: HTMLCanvasElement) {
    const s = this.sim;
    const h = s.health;
    drawChart(cv, { met: s.met, history: s.history, now: { o2: h.o2g / h.o2Cap, fatigue: h.fatigue, batt: h.battWh / h.battCap, dose: h.doseMSv }, forecast: s.plan?.forecast, alt: s.advisory?.alt });
  }

  private incidentHtml() {
    const s = this.sim;
    const inc = s.incident!;
    const def = inc.def;
    const h = s.health;
    const p = s.position();
    const hab = s.world.nodes.get(s.data.mission.startNodeId)!;
    const agg = s.agg();
    const impact: [string, string][] = [];
    if (agg.leakGph) impact.push(['O₂ leak', `${agg.leakGph.toFixed(0)} g/h`], ['To reserve', fmtDur((h.o2g - h.o2Cap * RESERVE_FRAC) / ((agg.leakGph + 70) / 3600))]);
    const spe = s.mods.find((m) => m.spec.doseMult && m.spec.doseMult > 1);
    if (spe) impact.push(['Onset in', fmtDur(spe.delayS ?? 0)], ['Peak dose rate', `${((p.doseBase * (spe.spec.doseMult ?? 1)) / 1000).toFixed(1)} mSv/h`]);
    if (agg.dust) impact.push(['Visibility', '< 30 m']);
    if (impact.length < 2) impact.push(['O₂', `${((h.o2g / h.o2Cap) * 100).toFixed(0)}%`]);
    impact.push(['Habitat', km(Math.hypot(hab.e - p.e, hab.n - p.n))]);
    const frac = Math.max(0, inc.remainingReal / def.timeoutS);
    const opts = def.options
      .map(
        (o, i) => `<button class="i-opt ${o.recommended ? 'rec' : ''}" data-gaze="opt:${i}" data-gaze-label="Option ${i + 1}"><span class="i-num">${i + 1}</span><span class="i-otext"><b>${esc(o.label)}</b><small>${esc(o.consequence)}</small></span>${o.recommended ? '<em>Recommended</em>' : ''}</button>`,
      )
      .join('');
    return `<div class="i-card i-incident sev-${def.severity}"><div class="i-head"><span class="ms">${def.severity === 'emergency' ? 'emergency_home' : 'warning'}</span><span class="i-cat">${esc(def.category)}</span><span class="i-timer"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" style="stroke-dasharray:${(frac * 50.3).toFixed(1)} 50.3"/></svg>${Math.ceil(inc.remainingReal)}s</span></div>
      <div class="i-title big">${esc(def.title)}</div><div class="i-body">${esc(def.body)}</div>
      <div class="i-stats">${impact.slice(0, 3).map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
      <div class="i-opts">${opts}</div>
      <div class="i-hint">Say “option ${['one', 'two', 'three', 'four'][def.options.findIndex((o) => o.recommended)] ?? 'one'}”, or look at an option and say “launch this”. Default ${def.defaultOption + 1} when the timer ends.</div></div>`;
  }

  private advisoryHtml() {
    const s = this.sim;
    const a = s.advisory!;
    const rows: [string, number, number, (v: number) => string, boolean][] = [
      ['Peak fatigue', a.current.peakFatigue, a.alt.peakFatigue, (v) => v.toFixed(0), true],
      ['O₂ at goal', a.current.o2End * 100, a.alt.o2End * 100, (v) => `${v.toFixed(0)}%`, false],
      ['Dose', a.current.doseAdded, a.alt.doseAdded, (v) => `${v.toFixed(2)} mSv`, true],
      ['Max slope', a.currentMetrics.maxSlopeDeg, a.altMetrics.maxSlopeDeg, (v) => `${v.toFixed(0)}°`, true],
      ['Time', a.current.timeS, a.alt.timeS, fmtDur, true],
    ];
    const cmp = rows
      .map(([k, x, y, f, lower]) => `<div><span>${k}</span><b>${f(x)}</b><span class="ms">arrow_forward</span><b class="${(lower ? y < x - 1e-6 : y > x + 1e-6) ? 'better' : Math.abs(y - x) < 1e-6 ? '' : 'worse'}">${f(y)}</b></div>`)
      .join('');
    const name = s.world.routeName(a.altRoute) || 'same traverse';
    return `<div class="i-card i-adv"><div class="i-head"><span class="ms">alt_route</span><span class="i-cat">Reroute advisory</span><span class="i-dim">via ${esc(name)}${a.pace ? ` · ${a.pace} pace` : ''}</span></div>
      <div class="i-title">${esc(a.title.split('·').slice(1).join('·').trim() || a.title)}</div><div class="i-body">${esc(a.reason)}</div>
      <div class="i-cmp"><div class="hd"><span></span><span>Now</span><span></span><span>Alternate</span></div>${cmp}</div>
      <div class="i-actions"><button class="pill ghost" data-gaze="reroute-dismiss" data-gaze-label="Dismiss">Dismiss</button><button class="pill amber" data-gaze="reroute-accept" data-gaze-label="Accept reroute">Accept reroute</button></div>
      <div class="i-hint">Say “accept” or “dismiss”. The alternate is the dashed amber line on the radar.</div></div>`;
  }

  private junctionHtml() {
    const s = this.sim;
    const node = s.world.nodes.get(s.pos.node!)!;
    const goal = s.world.nodes.get(s.currentGoal())?.name ?? '';
    const opts = s.choices
      .slice(0, 3)
      .map((c, i) => {
        const f = c.forecast;
        const to = s.world.nodes.get(s.world.legTo(c.leg))!.name;
        const tag = c.recommended ? '<em>Recommended</em>' : !f.feasible ? '<em class="bad">Infeasible</em>' : f.peakFatigue > FATIGUE_REROUTE || c.metrics.maxSlopeDeg > 18 ? '<em class="caution">Caution</em>' : '';
        const sel = s.committed[0]?.edgeId === c.leg.edgeId;
        return `<button class="i-opt col ${c.recommended ? 'rec' : ''} ${sel ? 'sel' : ''}" data-gaze="opt:${i}" data-gaze-label="Route ${i + 1}"><div class="i-otop"><span class="i-num">${i + 1}</span>${tag}</div><b>${esc(c.name)}</b><small>to ${esc(to)} · ${km(c.metrics.distance)} · ${c.metrics.maxSlopeDeg.toFixed(0)}° max</small>
          <div class="i-ostats"><span>${fmtDur(f.timeS)}</span><span>FTG ${f.peakFatigue.toFixed(0)}</span><span>O₂ ${(f.o2End * 100).toFixed(0)}%</span><span>+${f.doseAdded.toFixed(2)} mSv</span></div></button>`;
      })
      .join('');
    return `<div class="i-card i-junction"><div class="i-head"><span class="ms">fork_right</span><span class="i-cat">Junction · ${esc(node.name)}</span><span class="i-dim">toward ${esc(goal)}</span></div><div class="i-opts row">${opts}</div><div class="i-hint">Say “route one”, or look at a route and say “launch this”. Then walk with W.</div></div>`;
  }

  // ------------------------------------------------------------ feature details ("check this feature's progress")
  featureDetail(id: FeatureId | string): Detail {
    const s = this.sim;
    const h = s.health;
    const r = s.rates;
    const c = s.data.mission.consumables;
    const tl = (amount: number, rate: number) => (rate > 1e-6 ? amount / rate : Infinity);
    const g = this.guardian;
    if (g) {
      if (id === 'team') return g.teamCard();
      if (id === 'supplies') return { ...g.suppliesCard(), oneCol: true, acts: [{ id: 'act:cache', label: 'Go to nearest cache', icon: 'near_me' }, { id: 'act:resume', label: 'Resume mission', icon: 'flag' }], cols: 2 };
      if (id === 'weather') return g.weatherCard();
      if (id === 'tags') return { ...g.tagsCard(), oneCol: true, hint: 'Look at something and say “label this”. “Go to tag” navigates. “Remove tag” deletes the newest.' };
      if (id === 'log') return { ...g.logCard(), oneCol: true, hint: 'Say “show log” for the full timeline with the conversation.' };
      if (id === 'emergency') return { icon: 'emergency_home', title: 'Emergency', big: '', rows: [], acts: EMERGENCY_ACTS(g, s), speech: 'Emergency actions. Say call for help, back to habitat, nearest shelter, resupply, rest, or stability on.', hint: 'Say the action, or look at it and say “launch this”.' };
      if (id === 'tools') return { icon: 'apps', title: 'Tools', big: '', rows: [], acts: TOOL_ACTS, cols: 4, speech: 'Tools: team, supplies, systems, weather, tags, log, photo, and what is this.', hint: 'Say a tool’s name, or look at it and say “launch this”.' };
      if (id === 'systems') {
        const agg = s.agg();
        const relay = s.drone.active && s.drone.mode === 'relay';
        const faults = s.mods.filter((m) => !m.spec.dust && !m.spec.doseMult);
        return {
          icon: 'memory',
          title: 'Suit systems',
          big: faults.length ? `${faults.length} fault${faults.length > 1 ? 's' : ''}` : 'Nominal',
          band: faults.length ? 'caution' : 'ok',
          rows: [
            ['Voice (microphone)', this.sensors.mic, this.sensors.micOk ? 'ok' : 'caution'],
            ['Gaze (camera)', this.sensors.cam, this.sensors.camOk ? 'ok' : 'caution'],
            ['Gaze input', this.sensors.gaze],
            ['Comms link', agg.commsLoss && !relay ? 'No signal' : relay ? 'Via drone relay' : 'Direct', agg.commsLoss && !relay ? 'warning' : 'ok'],
            ['Stability assist', s.stability ? 'On' : 'Off', s.stability ? 'ok' : ''],
            ['Navigation', s.detour ? `To ${s.detour.label}` : s.goalOverride ? `Override: ${s.goalOverride.kind}` : 'Mission plan'],
            ['Drone', s.drone.active ? `${s.drone.mode} · ${s.drone.battery.toFixed(0)}%` : `Docked · ${s.drone.battery.toFixed(0)}%`],
            ['Footing', s.risk > 0.0022 ? 'Poor' : s.risk > 0.001 ? 'Fair' : 'Good', s.risk > 0.0022 ? 'caution' : 'ok'],
            ['Trips', `${s.stats2.stumbles} stumbles · ${s.stats2.falls} falls`],
            ...faults.map((m) => [m.label, 'Active', 'caution'] as [string, string, string]),
          ],
          speech: `${faults.length ? `${faults.length} active fault${faults.length > 1 ? 's' : ''}: ${faults.map((m) => m.label).join(', ')}.` : 'All suit systems nominal.'} Voice ${this.sensors.micOk ? 'is listening' : 'is not available'}. Gaze ${this.sensors.camOk ? 'is tracking' : 'is using the pointer'}. Stability assist ${s.stability ? 'on' : 'off'}.`,
        };
      }
    }
    switch (id) {
      case 'o2': {
        const f = h.o2g / h.o2Cap;
        const toRes = tl(h.o2g - h.o2Cap * RESERVE_FRAC, r.o2gps);
        const leak = s.agg().leakGph;
        return {
          icon: 'air',
          title: 'Primary oxygen',
          big: `${(f * 100).toFixed(0)}%`,
          band: bandFrac(f),
          bar: f,
          rows: [['Remaining', `${h.o2g.toFixed(0)} g`], ['Use rate', `${(r.o2gps * 3600).toFixed(0)} g/h`], ['To 20% reserve', fmtDur(toRes), toRes < 1800 ? 'warning' : ''], ['At habitat (forecast)', s.plan ? `${(s.plan.forecast.o2End * 100).toFixed(0)}%` : '—'], ...(leak ? ([['Suit leak', `${leak.toFixed(0)} g/h`, 'warning']] as [string, string, string][]) : [])],
          speech: `Oxygen ${(f * 100).toFixed(0)} percent. ${say(toRes)} to reserve.${s.plan ? ` Forecast ${(s.plan.forecast.o2End * 100).toFixed(0)} percent at the habitat.` : ''}`,
        };
      }
      case 'h2o': {
        const f = h.waterg / h.waterCap;
        return {
          icon: 'water_drop',
          title: 'Cooling water',
          big: `${(f * 100).toFixed(0)}%`,
          band: bandFrac(f),
          bar: f,
          rows: [['Remaining', `${(h.waterg / 1000).toFixed(2)} kg`], ['Use rate', `${(r.watergps * 3600).toFixed(0)} g/h`], ['Time left', fmtDur(tl(h.waterg, r.watergps))], ['Core temp', `${h.coreC.toFixed(1)} °C`, bandCore(h.coreC) === 'ok' ? '' : bandCore(h.coreC)]],
          speech: `Cooling water ${(f * 100).toFixed(0)} percent, ${say(tl(h.waterg, r.watergps))} left. Core temperature ${h.coreC.toFixed(1)} degrees.`,
        };
      }
      case 'power': {
        const f = h.battWh / h.battCap;
        return {
          icon: 'battery_horiz_075',
          title: 'Suit battery',
          big: `${(f * 100).toFixed(0)}%`,
          band: bandFrac(f),
          bar: f,
          rows: [['Remaining', `${h.battWh.toFixed(0)} Wh`], ['Draw', `${r.battWps.toFixed(0)} W`], ['Time left', fmtDur(tl(h.battWh * 3600, r.battWps))], ['Capacity', h.battCap < c.battWh - 1 ? 'Reduced' : 'Nominal', h.battCap < c.battWh - 1 ? 'caution' : '']],
          speech: `Battery ${(f * 100).toFixed(0)} percent, drawing ${r.battWps.toFixed(0)} watts, ${say(tl(h.battWh * 3600, r.battWps))} left.`,
        };
      }
      case 'dose': {
        const rate = r.doseRate;
        const p = s.position();
        const shield = rate / Math.max(1e-6, p.doseBase * s.agg().doseMult);
        return {
          icon: 'radiology',
          title: 'Radiation dose',
          big: `${h.doseMSv.toFixed(2)} mSv`,
          band: bandDose(h.doseMSv, c.doseBudgetmSv),
          bar: h.doseMSv / c.doseBudgetmSv,
          rows: [['Rate now', rate >= 1000 ? `${(rate / 1000).toFixed(2)} mSv/h` : `${rate.toFixed(0)} µSv/h`, rate > 200 ? 'warning' : rate > 40 ? 'caution' : ''], ['EVA budget', `${c.doseBudgetmSv} mSv`], ['Shielding', shield < 0.95 ? `${((1 - shield) * 100).toFixed(0)}% blocked` : 'Open sky'], ['Route forecast', s.plan ? `+${s.plan.forecast.doseAdded.toFixed(2)} mSv` : '—']],
          speech: `Dose ${h.doseMSv.toFixed(2)} millisievert of ${c.doseBudgetmSv}. Rate ${rate.toFixed(0)} micro sievert per hour.`,
        };
      }
      case 'fatigue':
        return {
          icon: 'directions_walk',
          title: 'Fatigue index',
          big: h.fatigue.toFixed(0),
          band: bandFatigue(h.fatigue),
          bar: h.fatigue / 100,
          rows: [['Reroute threshold', String(FATIGUE_REROUTE)], ['Heart rate', `${h.hr.toFixed(0)} bpm`, bandHr(h.hr) === 'ok' ? '' : bandHr(h.hr)], ['Metabolic rate', `${h.metW.toFixed(0)} W`], ['Peak on route', s.plan ? s.plan.forecast.peakFatigue.toFixed(0) : '—', s.plan && s.plan.forecast.peakFatigue > FATIGUE_REROUTE ? 'caution' : ''], ['Pace', s.pace]],
          speech: `Fatigue ${h.fatigue.toFixed(0)}. Reroute threshold is ${FATIGUE_REROUTE}. Heart rate ${h.hr.toFixed(0)}.`,
        };
      case 'drone': {
        const d = s.drone;
        const p = s.position();
        const prog = d.path.length ? d.idx / d.path.length : 0;
        return {
          icon: 'flight',
          title: 'Drone scout',
          big: d.active ? d.mode.charAt(0).toUpperCase() + d.mode.slice(1) : 'Docked',
          bar: d.active && d.mode === 'scout' ? prog : d.battery / 100,
          rows: [['Battery', `${d.battery.toFixed(0)}%`, d.battery < 25 ? 'caution' : ''], ['Range', d.active ? `${Math.hypot(d.e - p.e, d.n - p.n).toFixed(0)} m` : '—'], ['Scout path', d.active && d.mode === 'scout' ? `${(prog * 100).toFixed(0)}%` : '—'], ['Terrain revealed', `${d.revealedCells} cells`]],
          speech: d.active ? `Drone ${d.mode}, ${(prog * 100).toFixed(0)} percent along the scout path, battery ${d.battery.toFixed(0)} percent.` : `Drone docked, battery ${d.battery.toFixed(0)} percent. Say launch drone to scout ahead.`,
        };
      }
      case 'sample': {
        const samples = s.data.mission.objectives.filter((o) => o.kind === 'sample');
        const got = samples.filter((o) => s.objectivesDone.has(o.id));
        const next = samples.find((o) => !s.objectivesDone.has(o.id));
        const nd = next ? s.world.nodes.get(next.nodeId)! : null;
        const p = s.position();
        return {
          icon: 'science',
          title: 'Samples',
          big: `${got.length} / ${samples.length}`,
          bar: got.length / Math.max(1, samples.length),
          rows: [...samples.map((o) => [o.label, s.objectivesDone.has(o.id) ? 'Sealed' : 'Pending', s.objectivesDone.has(o.id) ? 'ok' : ''] as [string, string, string]), ['Next site', nd ? `${nd.name} · ${km(Math.hypot(nd.e - p.e, nd.n - p.n))}` : 'All collected'], ['Field notes', String(s.marks.length)]],
          speech: `${got.length} of ${samples.length} samples collected.${nd ? ` Next site ${nd.name}, ${km(Math.hypot(nd.e - p.e, nd.n - p.n))}.` : ''}`,
        };
      }
      case 'layers':
        return {
          icon: 'layers',
          title: 'Map layers',
          big: `${this.activeLayers().length} on`,
          rows: (['radiation', 'slope', 'poi', 'dust', 'mag'] as LayerId[]).map((l) => [LAYER_INFO[l].label, this.map.layers[l] ? 'On' : 'Off', this.map.layers[l] ? 'ok' : ''] as [string, string, string]),
          speech: this.activeLayers().length ? `Layers on: ${this.activeLayers().join(', ')}.` : 'No overlay layers on. Say show radiation, or show slope.',
        };
      case 'mission': {
        const obj = s.data.mission.objectives;
        const done = obj.filter((o) => s.objectivesDone.has(o.id)).length;
        return {
          icon: 'flag',
          title: s.data.mission.title,
          big: `${done} / ${obj.length}`,
          bar: done / obj.length,
          rows: [...obj.map((o) => [o.label, s.objectivesDone.has(o.id) ? 'Done' : o.nodeId === s.currentGoal() ? 'Current' : 'Pending', s.objectivesDone.has(o.id) ? 'ok' : ''] as [string, string, string]), ['Elapsed', fmtMET(s.met)], ['Walked', km(s.stats.distance)]],
          speech: `${done} of ${obj.length} objectives complete. Elapsed ${fmtMET(s.met)}.`,
        };
      }
      case 'map':
      case 'route':
      default: {
        const plan = s.plan;
        const m = plan?.metrics;
        const f = plan?.forecast;
        const goal = plan ? s.world.nodes.get(plan.goal)?.name ?? '' : '';
        return {
          icon: 'route',
          title: goal ? `Route to ${goal}` : 'Route',
          big: `${(this.routeProgress() * 100).toFixed(0)}%`,
          bar: this.routeProgress(),
          rows: m && f ? [['Distance', km(m.distance)], ['Elevation gain', `+${m.gain.toFixed(0)} m`], ['Max slope', `${m.maxSlopeDeg.toFixed(0)}°`, m.maxSlopeDeg > 20 ? 'warning' : m.maxSlopeDeg > 15 ? 'caution' : ''], ['Est. time', fmtDur(f.timeS)], ['Peak fatigue', f.peakFatigue.toFixed(0), f.peakFatigue > FATIGUE_REROUTE ? 'caution' : ''], ['O₂ at end', `${(f.o2End * 100).toFixed(0)}%`, f.o2End < 0.3 ? 'caution' : '']] : [['Status', 'No plan']],
          chart: !!plan,
          speech: m && f ? `${(this.routeProgress() * 100).toFixed(0)} percent of the traverse done. ${km(m.distance)} to go, about ${say(f.timeS)}, max slope ${m.maxSlopeDeg.toFixed(0)} degrees. Oxygen at the end ${(f.o2End * 100).toFixed(0)} percent.` : 'No route planned.',
        };
      }
    }
  }

  // ------------------------------------------------------------ navigator panel
  refreshPlanner() {
    const s = this.sim;
    $('planner-list').innerHTML = s.plannerNodes.map((id) => `<li>${esc(s.world.nodes.get(id)!.name)}</li>`).join('') || '<li class="empty">Click the map to add waypoints</li>';
    $('planner-count').textContent = s.plannerNodes.length ? `${s.plannerNodes.length}` : '';
    const ev = s.plannerEvaluate();
    const now = { o2: s.health.o2g / s.health.o2Cap, fatigue: s.health.fatigue, batt: s.health.battWh / s.health.battCap, dose: s.health.doseMSv };
    if (ev) {
      const m = ev.metrics;
      const f = ev.forecast;
      const cell = (k: string, v: string, cls = '') => `<div class="m ${cls}"><span>${k}</span><b>${v}</b></div>`;
      $('planner-metrics').innerHTML = [
        cell('Distance', km(m.distance)),
        cell('Elevation gain', `+${m.gain.toFixed(0)} m`),
        cell('Max slope', `${m.maxSlopeDeg.toFixed(0)}°`, m.maxSlopeDeg > 15 ? 'caution' : ''),
        cell('Est. time', fmtDur(f.timeS)),
        cell('Peak fatigue', f.peakFatigue.toFixed(0), f.peakFatigue > FATIGUE_REROUTE ? 'warning' : ''),
        cell('O₂ at end', `${(f.o2End * 100).toFixed(0)}%`, f.o2End < 0.3 ? 'caution' : ''),
      ].join('');
      drawChart($('planner-chart') as HTMLCanvasElement, { met: s.met, history: s.history, now, forecast: s.plan?.forecast, planner: f });
    } else {
      $('planner-metrics').innerHTML = '<div class="m full"><span>Add two or more waypoints to see distance, elevation gain, max slope and time</span></div>';
      drawChart($('planner-chart') as HTMLCanvasElement, { met: s.met, history: s.history, now, forecast: s.plan?.forecast });
    }
  }
}
