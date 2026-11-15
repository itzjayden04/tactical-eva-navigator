/**
 * MAP NAVIGATION: street-map style interaction for the Navigator panel.
 *
 * - wheel / trackpad / pinch zoom around the cursor, drag to pan, smooth fly-to
 * - +/− buttons, "centre on me", "whole area", keyboard (+ − arrows)
 * - labels that appear by zoom level (done by TacticalMap.draw with a view)
 * - search: places, traverse junctions, your labels, crew, rover sols, lat/lon
 * - click anything for a place card (coordinates, elevation, slope, dose, distance)
 *   with actions: navigate there, add as waypoint, label it, open the rover's panorama
 * - click empty ground to drop a pin; "Plan route" mode keeps click-to-add-waypoint
 */
import type { DataBundle, GeoRef } from '../data/types';
import { toLatLon } from '../data/types';
import type { Sim } from '../core/sim';
import { TAG_INFO, TAG_KINDS, bearingWord, type Guardian, type TagKind } from '../core/guardian';
import { sample, slopeDeg } from '../core/grid';
import type { MapHit, MapView, TacticalMap } from './map';
import { esc, km } from './hud';
import { jaroWinkler } from './intent';

const MAX_K = 3; // px per metre: 3 screen px per 1 m orthophoto pixel

export interface Place {
  kind: MapHit['kind'] | 'pin' | 'search';
  id: string;
  name: string;
  e: number;
  n: number;
  icon: string;
  sub: string;
}

/** local metres from latitude / longitude (inverse of toLatLon) */
export function fromLatLon(g: GeoRef, lat: number, lon: number) {
  const k = Math.PI / 180;
  return { e: g.offsetE + (lon - g.lon0) * g.radius * k * Math.cos(g.lat0 * k), n: g.offsetN + (lat - g.lat0) * g.radius * k };
}

/** search score 0..1 of a query against a name (prefix > word prefix > substring > fuzzy) */
export function matchScore(q: string, name: string, keywords = ''): number {
  const nq = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (!nq) return 0;
  const hay = `${name} ${keywords}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const nm = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (nm.startsWith(nq)) return 1;
  const nameWords = nm.split(/[^a-z0-9]+/).filter(Boolean);
  if (nameWords.some((w) => w.startsWith(nq))) return 0.95;
  if (nm.includes(nq)) return 0.85;
  const words = hay.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(nq))) return 0.7;
  if (hay.includes(nq)) return 0.6;
  // typo tolerant: every query word close to some word in the name
  const qw = nq.split(/\s+/);
  let tot = 0;
  for (const a of qw) tot += Math.max(0, ...words.map((w) => jaroWinkler(a, w.slice(0, Math.max(a.length, 3) + 1))));
  const avg = tot / qw.length;
  return avg >= 0.86 ? avg * 0.7 : 0;
}

export class MapNav {
  view: MapView = { cx: 0, cy: 0, k: 0.2 };
  private target: MapView = { cx: 0, cy: 0, k: 0.2 };
  private fitted = false;
  mode: 'explore' | 'plan' = 'explore';
  selected: Place | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private labeling = false;
  private cardAt = 0;
  private results: Place[] = [];
  private resIdx = 0;
  /** add a waypoint for planning (returns the snapped node name, or null) */
  onPlan: (e: number, n: number) => string | null = () => null;
  /** speak / show a message */
  onSay: (text: string) => void = () => {};
  /** close the map (after starting navigation) */
  onClose: () => void = () => {};

  constructor(
    private map: TacticalMap,
    private sim: Sim,
    private data: DataBundle,
    private guardian: Guardian,
    private canvas: HTMLCanvasElement,
    private ui: { stage: HTMLElement; search: HTMLInputElement; results: HTMLElement; card: HTMLElement; coords: HTMLElement; zin: HTMLElement; zout: HTMLElement; locate: HTMLElement; fit: HTMLElement; modes: HTMLElement; clearSearch: HTMLElement; chips: HTMLElement },
  ) {
    this.bindPointer();
    this.bindControls();
    this.bindSearch();
  }

  // ------------------------------------------------------------------ camera
  private size() {
    return { w: this.canvas.clientWidth || 800, h: this.canvas.clientHeight || 600 };
  }
  private fitK() {
    const { w, h } = this.size();
    const ext = this.map.ext;
    return Math.min(w / (ext.maxE - ext.minE), h / (ext.maxN - ext.minN)) * 0.96;
  }
  private clamp(v: MapView): MapView {
    const ext = this.map.ext;
    const k = Math.max(this.fitK() * 0.7, Math.min(MAX_K, v.k));
    const pad = 200;
    return { k, cx: Math.max(ext.minE - pad, Math.min(ext.maxE + pad, v.cx)), cy: Math.max(ext.minN - pad, Math.min(ext.maxN + pad, v.cy)) };
  }
  /** screen px → world (e, n) for a given view */
  toWorld(x: number, y: number, v: MapView = this.view) {
    const { w, h } = this.size();
    return { e: v.cx + (x - w / 2) / v.k, n: v.cy - (y - h / 2) / v.k };
  }
  toScreen(e: number, n: number, v: MapView = this.view) {
    const { w, h } = this.size();
    return { x: w / 2 + (e - v.cx) * v.k, y: h / 2 - (n - v.cy) * v.k };
  }
  /** zoom by `f` keeping the world point under (x, y) fixed */
  zoomAt(f: number, x?: number, y?: number, smooth = true) {
    const { w, h } = this.size();
    const sx = x ?? w / 2;
    const sy = y ?? h / 2;
    const p = this.toWorld(sx, sy, this.target);
    const k = Math.max(this.fitK() * 0.7, Math.min(MAX_K, this.target.k * f));
    this.target = this.clamp({ k, cx: p.e - (sx - w / 2) / k, cy: p.n + (sy - h / 2) / k });
    if (!smooth) this.view = { ...this.target };
  }
  /** smooth flight to a place */
  flyTo(e: number, n: number, k = Math.max(this.target.k, 1)) {
    this.target = this.clamp({ cx: e, cy: n, k });
  }
  fitAll() {
    const ext = this.map.ext;
    this.target = { cx: (ext.minE + ext.maxE) / 2, cy: (ext.minN + ext.maxN) / 2, k: this.fitK() };
  }
  locate() {
    const me = this.sim.position();
    this.flyTo(me.e, me.n, Math.max(this.target.k, 0.9));
  }
  /** called when the panel opens */
  opened() {
    requestAnimationFrame(() => {
      if (!this.fitted) {
        this.fitted = true;
        this.fitAll();
        this.view = { ...this.target };
      }
    });
  }
  /** Advance the camera animation; returns the view to draw. */
  tick(dt: number): MapView {
    if (!this.fitted && this.canvas.clientWidth) {
      this.fitted = true;
      this.fitAll();
      this.view = { ...this.target };
    }
    const a = 1 - Math.exp(-dt * 12);
    const lk = Math.log(this.view.k) + (Math.log(this.target.k) - Math.log(this.view.k)) * a;
    this.view = { k: Math.exp(lk), cx: this.view.cx + (this.target.cx - this.view.cx) * a, cy: this.view.cy + (this.target.cy - this.view.cy) * a };
    this.map.selected = this.selected ? { e: this.selected.e, n: this.selected.n } : null;
    this.cardAt += dt;
    if (this.selected && !this.labeling && this.cardAt > 1) {
      this.cardAt = 0;
      this.renderCard(); // keep live distances fresh
    }
    return this.view;
  }

  // ------------------------------------------------------------------ input
  private bindPointer() {
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 1) this.drag = { x: e.offsetX, y: e.offsetY, moved: false };
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        if (this.drag) this.drag.moved = true;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      this.hover(e.offsetX, e.offsetY);
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        this.panBy(mx - this.pinch.mx, my - this.pinch.my);
        this.zoomAt(d / Math.max(1, this.pinch.d), mx, my, false);
        this.pinch = { d, mx, my };
        return;
      }
      if (this.drag) {
        const dx = e.offsetX - prev.x;
        const dy = e.offsetY - prev.y;
        if (!this.drag.moved && Math.hypot(e.offsetX - this.drag.x, e.offsetY - this.drag.y) > 4) this.drag.moved = true;
        if (this.drag.moved) {
          cv.classList.add('grabbing');
          this.panBy(dx, dy);
        }
      }
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) {
        cv.classList.remove('grabbing');
        if (this.drag && !this.drag.moved && e.type === 'pointerup') this.click(e.offsetX, e.offsetY);
        this.drag = null;
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => (this.ui.coords.textContent = ''));
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        // trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheels in big steps
        const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
        this.zoomAt(f, e.offsetX, e.offsetY);
      },
      { passive: false },
    );
    cv.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.zoomAt(e.shiftKey ? 0.5 : 2, e.offsetX, e.offsetY);
    });
    window.addEventListener('keydown', (e) => {
      if (!this.ui.stage.offsetParent || document.activeElement instanceof HTMLInputElement) return;
      const step = 80;
      if (e.key === '+' || e.key === '=') this.zoomAt(1.6);
      else if (e.key === '-' || e.key === '_') this.zoomAt(1 / 1.6);
      else if (e.key === 'ArrowLeft') this.panTarget(step, 0);
      else if (e.key === 'ArrowRight') this.panTarget(-step, 0);
      else if (e.key === 'ArrowUp') this.panTarget(0, step);
      else if (e.key === 'ArrowDown') this.panTarget(0, -step);
      else if (e.key === '/') {
        e.preventDefault();
        this.ui.search.focus();
      } else return;
      e.preventDefault();
    });
  }
  private panBy(dx: number, dy: number) {
    const v = this.clamp({ k: this.view.k, cx: this.view.cx - dx / this.view.k, cy: this.view.cy + dy / this.view.k });
    this.view = v;
    this.target = { ...v };
  }
  private panTarget(dx: number, dy: number) {
    this.target = this.clamp({ k: this.target.k, cx: this.target.cx - dx / this.target.k, cy: this.target.cy + dy / this.target.k });
  }
  private hitAt(x: number, y: number): MapHit | null {
    let best: MapHit | null = null;
    let bd = Infinity;
    for (const h of this.map.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      // prefer meaningful pins over rover stops when they overlap
      const pen = h.kind === 'rover' ? 4 : h.kind === 'node' ? 2 : 0;
      if (d <= h.r + 4 && d + pen < bd) {
        bd = d + pen;
        best = h;
      }
    }
    return best;
  }
  private hover(x: number, y: number) {
    const p = this.toWorld(x, y);
    const g = this.data.geo;
    const ll = g ? toLatLon(g, p.e, p.n) : null;
    const ext = this.map.ext;
    const inside = p.e >= ext.minE && p.e <= ext.maxE && p.n >= ext.minN && p.n <= ext.maxN;
    const el = inside ? sample(this.data.elevation, p.e, p.n) : NaN;
    this.ui.coords.textContent = inside ? `${ll ? `${ll.lat.toFixed(5)}°N ${ll.lon.toFixed(5)}°E` : `E${p.e.toFixed(0)} N${p.n.toFixed(0)}`} · ${el.toFixed(0)} m · slope ${slopeDeg(this.data.elevation, p.e, p.n).toFixed(0)}°` : 'Outside the study area';
    this.canvas.classList.toggle('over-pin', !!this.hitAt(x, y));
  }
  private click(x: number, y: number) {
    const h = this.hitAt(x, y);
    const p = this.toWorld(x, y);
    if (this.mode === 'plan') {
      const name = this.onPlan(h?.kind === 'node' || h?.kind === 'poi' ? h.e : p.e, h?.kind === 'node' || h?.kind === 'poi' ? h.n : p.n);
      if (name) this.onSay(`Waypoint added: ${name}`);
      else this.onSay('No traverse junction near there. Click closer to a white circle.');
      return;
    }
    if (h) this.select(this.placeFromHit(h));
    else this.select({ kind: 'pin', id: `pin:${p.e.toFixed(0)},${p.n.toFixed(0)}`, name: 'Dropped pin', e: p.e, n: p.n, icon: 'location_on', sub: 'Point on the map' });
  }

  // ------------------------------------------------------------------ places
  private placeFromHit(h: MapHit): Place {
    switch (h.kind) {
      case 'poi': {
        const poi = this.data.pois.find((x) => x.id === h.id)!;
        return { kind: 'poi', id: poi.id, name: poi.name, e: poi.e, n: poi.n, icon: POI_ICON[poi.kind] ?? 'location_on', sub: POI_LABEL[poi.kind] ?? poi.kind };
      }
      case 'tag': {
        const t = this.guardian.tags.find((x) => String(x.id) === h.id);
        return { kind: 'tag', id: h.id, name: h.name, e: h.e, n: h.n, icon: t ? TAG_INFO[t.kind].icon : 'sell', sub: t ? `Your label · ${TAG_INFO[t.kind].label}` : 'Your label' };
      }
      case 'node':
        return { kind: 'node', id: h.id, name: h.name, e: h.e, n: h.n, icon: 'radio_button_checked', sub: 'Traverse junction' };
      case 'entity':
        return { kind: 'entity', id: h.id, name: h.name, e: h.e, n: h.n, icon: h.id === 'ev2' ? 'person' : 'agriculture', sub: h.id === 'ev2' ? 'Crewmate (live)' : 'Equipment' };
      case 'rover':
        return { kind: 'rover', id: h.id, name: `Sol ${h.id} rover stop`, e: h.e, n: h.n, icon: 'agriculture', sub: 'Perseverance traverse (NASA/JPL)' };
      case 'me':
        return { kind: 'me', id: 'me', name: 'Your location', e: h.e, n: h.n, icon: 'my_location', sub: 'EV1 · live' };
      case 'drone':
        return { kind: 'drone', id: 'drone', name: 'Scout drone', e: h.e, n: h.n, icon: 'flight', sub: 'Live' };
      default:
        return { kind: 'pin', id: h.id, name: h.name, e: h.e, n: h.n, icon: 'location_on', sub: '' };
    }
  }
  /** every searchable place right now */
  places(): (Place & { kw: string })[] {
    const out: (Place & { kw: string })[] = [];
    const me = this.sim.position();
    out.push({ kind: 'me', id: 'me', name: 'Your location', e: me.e, n: me.n, icon: 'my_location', sub: 'EV1 · live', kw: 'me my location here current position you' });
    for (const p of this.data.pois) {
      if (!this.sim.discovered.has(p.id)) continue;
      out.push({ kind: 'poi', id: p.id, name: p.name, e: p.e, n: p.n, icon: POI_ICON[p.kind] ?? 'location_on', sub: POI_LABEL[p.kind] ?? p.kind, kw: `${p.kind} ${POI_LABEL[p.kind] ?? ''} ${p.note ?? ''}` });
    }
    for (const nd of this.sim.world.nodes.values()) {
      if (nd.poiId && out.some((o) => o.id === nd.poiId)) continue;
      out.push({ kind: 'node', id: nd.id, name: nd.name, e: nd.e, n: nd.n, icon: 'radio_button_checked', sub: 'Traverse junction', kw: 'junction node waypoint' });
    }
    for (const t of this.guardian.tags) {
      const pos = this.guardian.tagPos(t);
      out.push({ kind: 'tag', id: String(t.id), name: t.label, e: pos.e, n: pos.n, icon: TAG_INFO[t.kind].icon, sub: `Your label · ${TAG_INFO[t.kind].label}`, kw: `label tag my labels ${t.kind}` });
    }
    for (const en of this.guardian.entities) out.push({ kind: 'entity', id: en.id, name: en.name, e: en.e, n: en.n, icon: en.kind === 'teammate' ? 'person' : 'agriculture', sub: en.kind === 'teammate' ? 'Crewmate (live)' : 'Equipment', kw: `${en.kind} crew team buddy` });
    for (const g of this.sim.world.edges.values()) {
      const mid = g.samples[Math.floor(g.samples.length / 2)];
      if (mid) out.push({ kind: 'search', id: `edge:${g.edge.id}`, name: g.edge.name, e: mid.e, n: mid.n, icon: 'route', sub: `Traverse · ${g.edge.surface?.replace('_', ' ') ?? ''}`, kw: 'traverse path trail route' });
    }
    return out;
  }
  search(q: string): Place[] {
    const t = q.trim();
    if (!t) return [];
    const res: { p: Place; s: number }[] = [];
    // coordinates: "18.45, 77.44" (lat, lon) or "E 1200 N -400"
    const ll = t.match(/^(-?\d+(?:\.\d+)?)\s*°?\s*[n]?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*[e]?$/i);
    if (ll && this.data.geo && Math.abs(+ll[1]) <= 90) {
      const p = fromLatLon(this.data.geo, +ll[1], +ll[2]);
      res.push({ p: { kind: 'pin', id: 'coord', name: `${(+ll[1]).toFixed(5)}°N ${(+ll[2]).toFixed(5)}°E`, e: p.e, n: p.n, icon: 'pin_drop', sub: 'Coordinates' }, s: 2 });
    }
    const en = t.match(/^e\s*(-?\d+)\s*,?\s*n\s*(-?\d+)$/i);
    if (en) res.push({ p: { kind: 'pin', id: 'local', name: `E${en[1]} N${en[2]}`, e: +en[1], n: +en[2], icon: 'pin_drop', sub: 'Local grid (m)' }, s: 2 });
    const sol = t.match(/^sol\s*(\d+)$/i);
    if (sol && this.data.traverse) {
      const want = +sol[1];
      const wps = this.data.traverse.waypoints;
      const w = wps.reduce((a, b) => (Math.abs(b.sol - want) < Math.abs(a.sol - want) ? b : a), wps[0]);
      if (w) res.push({ p: { kind: 'rover', id: String(w.sol), name: `Sol ${w.sol} rover stop`, e: w.e, n: w.n, icon: 'agriculture', sub: 'Perseverance traverse (NASA/JPL)' }, s: 2 });
    }
    for (const p of this.places()) {
      const s = matchScore(t, p.name, p.kw);
      if (s > 0) res.push({ p, s });
    }
    const me = this.sim.position();
    res.sort((a, b) => b.s - a.s || Math.hypot(a.p.e - me.e, a.p.n - me.n) - Math.hypot(b.p.e - me.e, b.p.n - me.n));
    return res.slice(0, 7).map((r) => r.p);
  }

  select(p: Place | null, fly = false) {
    this.selected = p;
    this.labeling = false;
    this.map.pin = p && (p.kind === 'pin' || p.kind === 'search') ? { e: p.e, n: p.n } : null;
    if (p && fly) this.flyTo(p.e, p.n, Math.max(this.target.k, p.kind === 'search' ? 0.6 : 1.1));
    this.renderCard();
  }

  // ------------------------------------------------------------------ place card
  private renderCard() {
    const c = this.ui.card;
    const p = this.selected;
    if (!p) {
      c.classList.add('hidden');
      return;
    }
    // live things move
    if (p.kind === 'me') Object.assign(p, this.sim.position());
    if (p.kind === 'entity') {
      const en = this.guardian.entity(p.id);
      if (en) Object.assign(p, { e: en.e, n: en.n });
    }
    if (p.kind === 'drone') Object.assign(p, { e: this.sim.drone.e, n: this.sim.drone.n });
    const me = this.sim.position();
    const d = Math.hypot(p.e - me.e, p.n - me.n);
    const g = this.data.geo;
    const ll = g ? toLatLon(g, p.e, p.n) : null;
    const elev = sample(this.data.elevation, p.e, p.n);
    const slope = slopeDeg(this.data.elevation, p.e, p.n);
    const dose = sample(this.data.radiation, p.e, p.n);
    const ext = this.map.ext;
    const inside = p.e >= ext.minE && p.e <= ext.maxE && p.n >= ext.minN && p.n <= ext.maxN;
    const poi = p.kind === 'poi' ? this.data.pois.find((x) => x.id === p.id) : undefined;
    const tag = p.kind === 'tag' ? this.guardian.tags.find((x) => String(x.id) === p.id) : undefined;
    const wp = p.kind === 'rover' ? this.data.traverse?.waypoints.find((w) => String(w.sol) === p.id) : undefined;
    const rows: [string, string, string?][] = [];
    if (p.kind !== 'me') rows.push(['From you', d < 3 ? 'Here' : `${km(d)} ${bearingWord(p.e - me.e, p.n - me.n)}`]);
    if (ll) rows.push(['Coordinates', `${ll.lat.toFixed(5)}°N, ${ll.lon.toFixed(5)}°E`]);
    if (inside) {
      rows.push(['Elevation', `${elev.toFixed(0)} m (MOLA datum)`]);
      rows.push(['Slope', `${slope.toFixed(0)}°`, slope > 25 ? 'warning' : slope > 15 ? 'caution' : 'ok']);
      rows.push(['Dose rate', `${dose.toFixed(0)} µSv/h`, dose > 40 ? 'caution' : '']);
    }
    if (poi?.radius && poi.kind === 'hazard') rows.push(['Hazard radius', `${poi.radius} m`, 'caution']);
    const note = poi?.note ?? (wp ? `Perseverance stopped here on sol ${wp.sol}.` : p.kind === 'node' ? 'A junction of the planned traverse network. Add it as a waypoint to plan a route.' : '');
    const acts: [string, string, string][] = [];
    if (p.kind !== 'me') acts.push(['nav', 'navigation', 'Navigate']);
    acts.push(['plan', 'add_location_alt', 'Add waypoint']);
    if (tag) acts.push(['unlabel', 'label_off', 'Remove label']);
    else if (p.kind !== 'me' && p.kind !== 'entity' && p.kind !== 'drone') acts.push(['label', 'new_label', 'Label']);
    if (wp?.pano) acts.push(['pano', 'panorama', 'Rover panorama']);
    const tagColor = tag ? TAG_INFO[tag.kind].color : '';
    c.innerHTML = `
      <button class="mc-x" data-act="close" title="Close"><span class="ms">close</span></button>
      <div class="mc-head"><span class="ms mc-ic" ${tagColor ? `style="color:${tagColor}"` : ''}>${esc(p.icon)}</span><div><div class="mc-title">${esc(p.name)}</div><div class="mc-sub">${esc(p.sub)}</div></div></div>
      <div class="mc-acts">${acts.map(([a, ic, l]) => `<button data-act="${a}" class="${a === 'nav' ? 'primary' : ''}"><span class="ms">${ic}</span>${l}</button>`).join('')}</div>
      ${note ? `<div class="mc-note">${esc(note)}</div>` : ''}
      <div class="mc-rows">${rows.map(([k, v, cls]) => `<div><span>${esc(k)}</span><b class="${cls ?? ''}">${esc(v)}</b></div>`).join('')}</div>
      <div class="mc-label hidden">
        <input class="mc-name" maxlength="40" placeholder="Label name" />
        <div class="mc-kinds">${TAG_KINDS.map((k, i) => `<button data-kind="${k}" class="${i === 6 ? 'on' : ''}" title="${TAG_INFO[k].label}" style="--c:${TAG_INFO[k].color}"><span class="ms">${TAG_INFO[k].icon}</span></button>`).join('')}</div>
        <button data-act="save" class="primary"><span class="ms">check</span>Save label</button>
      </div>`;
    c.classList.remove('hidden');
  }

  private act(a: string, btn: HTMLElement) {
    const p = this.selected;
    if (!p) return;
    const me = this.sim.position();
    if (a === 'close') this.select(null);
    else if (a === 'nav') {
      if (p.kind === 'entity' && p.id === 'ev2') this.onSay(this.guardian.goToTeammate());
      else {
        this.sim.setDetour(p.e, p.n, p.name, p.kind === 'tag' ? `tag:${p.id}` : `map:${p.id}`);
        this.onSay(`Guiding you to ${p.name}, ${km(Math.hypot(p.e - me.e, p.n - me.n))} ${bearingWord(p.e - me.e, p.n - me.n)}. Follow the ground arrows.`);
      }
      this.onClose();
    } else if (a === 'plan') {
      const name = this.onPlan(p.e, p.n);
      this.onSay(name ? `Waypoint added: ${name}` : 'No traverse junction within 300 m of that place.');
    } else if (a === 'label') {
      this.labeling = true;
      const box = this.ui.card.querySelector('.mc-label')!;
      box.classList.remove('hidden');
      const inp = box.querySelector<HTMLInputElement>('.mc-name')!;
      inp.value = p.kind === 'pin' ? '' : p.name;
      inp.focus();
    } else if (a === 'save') {
      const box = this.ui.card.querySelector('.mc-label')!;
      const name = box.querySelector<HTMLInputElement>('.mc-name')!.value.trim();
      const kind = (box.querySelector<HTMLElement>('.mc-kinds .on')?.dataset.kind ?? 'note') as TagKind;
      const t = this.guardian.addTag(kind, { type: 'ground', name: name || p.name, e: p.e, n: p.n, up: 0, dist: Math.hypot(p.e - me.e, p.n - me.n), size: 1 }, name || undefined);
      this.onSay(`Labelled “${t.label}”. It shows on the map and in your visor.`);
      this.select({ kind: 'tag', id: String(t.id), name: t.label, e: t.e, n: t.n, icon: TAG_INFO[kind].icon, sub: `Your label · ${TAG_INFO[kind].label}` });
    } else if (a === 'unlabel') {
      const t = this.guardian.removeTag(Number(p.id));
      if (t) this.onSay(`Removed label ${t.label}`);
      this.select({ ...p, kind: 'pin', id: `pin:${p.e},${p.n}`, icon: 'location_on', sub: 'Point on the map' });
    } else if (a === 'pano') {
      const wp = this.data.traverse?.waypoints.find((w) => String(w.sol) === p.id);
      if (wp?.pano) window.open(wp.pano, '_blank', 'noopener');
    }
    void btn;
  }

  private bindControls() {
    const u = this.ui;
    u.zin.onclick = () => this.zoomAt(1.8);
    u.zout.onclick = () => this.zoomAt(1 / 1.8);
    u.locate.onclick = () => this.locate();
    u.fit.onclick = () => this.fitAll();
    u.modes.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
      if (!b) return;
      this.setMode(b.dataset.mode as 'explore' | 'plan');
    });
    u.card.addEventListener('click', (e) => {
      const k = (e.target as HTMLElement).closest<HTMLElement>('[data-kind]');
      if (k) {
        k.parentElement!.querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
        k.classList.add('on');
        return;
      }
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (b) this.act(b.dataset.act!, b);
    });
    u.card.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.target as HTMLElement).classList.contains('mc-name')) this.act('save', e.target as HTMLElement);
      if (e.key === 'Escape') this.select(null);
    });
    u.chips.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cat]');
      if (!b) return;
      this.category(b.dataset.cat!);
    });
  }
  setMode(m: 'explore' | 'plan') {
    this.mode = m;
    this.ui.modes.querySelectorAll<HTMLElement>('[data-mode]').forEach((x) => x.classList.toggle('on', x.dataset.mode === m));
    this.canvas.classList.toggle('plan', m === 'plan');
    if (m === 'plan') this.select(null);
  }
  /** "Shelters", "Supply caches"…: list them and frame them all */
  private category(cat: string) {
    const all = this.places();
    const pick = all.filter((p) => {
      if (cat === 'labels') return p.kind === 'tag';
      if (cat === 'crew') return p.kind === 'entity' || p.kind === 'me';
      const poi = p.kind === 'poi' ? this.data.pois.find((x) => x.id === p.id) : undefined;
      return poi?.kind === cat || (cat === 'sample' && poi?.kind === 'landmark');
    });
    this.showResults(pick, pick.length ? '' : 'Nothing here yet');
    if (!pick.length) return;
    const es = pick.map((p) => p.e);
    const ns = pick.map((p) => p.n);
    const { w, h } = this.size();
    const spanE = Math.max(200, Math.max(...es) - Math.min(...es));
    const spanN = Math.max(200, Math.max(...ns) - Math.min(...ns));
    const k = Math.min(w / spanE, h / spanN) * 0.6;
    this.target = this.clamp({ cx: (Math.max(...es) + Math.min(...es)) / 2, cy: (Math.max(...ns) + Math.min(...ns)) / 2, k });
  }

  // ------------------------------------------------------------------ search box
  private bindSearch() {
    const u = this.ui;
    u.search.addEventListener('input', () => {
      const q = u.search.value;
      u.clearSearch.classList.toggle('show', !!q);
      this.showResults(this.search(q), q.trim() ? 'No matches. Try a place, “sol 120”, or 18.445, 77.44' : '');
    });
    u.search.addEventListener('focus', () => {
      if (!u.search.value) this.showResults([], '');
    });
    u.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.results.length) return;
        this.resIdx = (this.resIdx + (e.key === 'ArrowDown' ? 1 : -1) + this.results.length) % this.results.length;
        this.paintResults();
      } else if (e.key === 'Enter') {
        const p = this.results[this.resIdx];
        if (p) this.choose(p);
      } else if (e.key === 'Escape') {
        u.search.value = '';
        u.clearSearch.classList.remove('show');
        this.showResults([], '');
        u.search.blur();
      }
    });
    u.clearSearch.onclick = () => {
      u.search.value = '';
      u.clearSearch.classList.remove('show');
      this.showResults([], '');
      this.map.pin = null;
    };
    u.results.addEventListener('pointerdown', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (!li) return;
      e.preventDefault();
      this.choose(this.results[Number(li.dataset.i)]);
    });
    u.search.addEventListener('blur', () => setTimeout(() => this.showResults([], ''), 150));
  }
  private choose(p: Place) {
    this.ui.search.value = p.name;
    this.showResults([], '');
    this.ui.search.blur();
    this.select(p, true);
  }
  private showResults(list: Place[], empty: string) {
    this.results = list;
    this.resIdx = 0;
    this.paintResults(empty);
  }
  private paintResults(empty = '') {
    const u = this.ui;
    const me = this.sim.position();
    if (!this.results.length) {
      u.results.innerHTML = empty ? `<div class="mr-empty">${esc(empty)}</div>` : '';
      u.results.classList.toggle('show', !!empty);
      return;
    }
    u.results.innerHTML = this.results
      .map((p, i) => `<div class="mr ${i === this.resIdx ? 'on' : ''}" data-i="${i}"><span class="ms">${esc(p.icon)}</span><div><b>${esc(p.name)}</b><span>${esc(p.sub)}</span></div><em>${p.kind === 'me' ? '' : km(Math.hypot(p.e - me.e, p.n - me.n))}</em></div>`)
      .join('');
    u.results.classList.add('show');
  }
}

const POI_ICON: Record<string, string> = { habitat: 'home', sample: 'science', shelter: 'roofing', hazard: 'warning', comms: 'cell_tower', cache: 'inventory_2', landmark: 'landscape' };
const POI_LABEL: Record<string, string> = { habitat: 'Habitat', sample: 'Sample site', shelter: 'Radiation shelter', hazard: 'Hazard zone', comms: 'Comms relay', cache: 'Supply cache', landmark: 'Landmark' };
