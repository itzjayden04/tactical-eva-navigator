/**
 * TACTICAL MAP: top-down canvas with independent overlay layers.
 * Unseen quantities (dose, dust, magnetic field) use colour intensity.
 */
import type { DataBundle, Grid, Poi } from '../data/types';
import { gridExtent, gridStats, slopeGrid } from '../core/grid';
import { Sim } from '../core/sim';
import type { Leg } from '../core/route';
import { TAG_INFO, type Guardian } from '../core/guardian';

export type LayerId = 'radiation' | 'slope' | 'poi' | 'dust' | 'mag' | 'fog';

type Ramp = [number, [number, number, number, number]][];
const RAMPS: Record<string, Ramp> = {
  radiation: [
    [0, [40, 60, 200, 0]],
    [0.35, [40, 140, 255, 150]],
    [0.65, [255, 220, 60, 180]],
    [1, [255, 50, 50, 220]],
  ],
  slope: [
    [0, [60, 220, 120, 0]],
    [0.25, [60, 220, 120, 120]],
    [0.5, [255, 200, 40, 170]],
    [1, [255, 40, 40, 220]],
  ],
  dust: [
    [0, [230, 190, 140, 0]],
    [1, [250, 225, 180, 210]],
  ],
  mag: [
    [0, [120, 60, 200, 0]],
    [0.5, [150, 90, 255, 130]],
    [1, [230, 140, 255, 210]],
  ],
};

export const LAYER_INFO: Record<LayerId, { label: string; swatch: string; legend: string }> = {
  radiation: { label: 'RADIATION', swatch: '#ffdc3c', legend: 'GCR dose rate µSv/h (terrain-shielded)' },
  slope: { label: 'SLOPE', swatch: '#ff5a3c', legend: 'Terrain slope 0–30°' },
  poi: { label: 'POI', swatch: '#39d0ff', legend: 'Sites, shelters, hazards' },
  dust: { label: 'DUST', swatch: '#f0d6a8', legend: 'Dust deposit index' },
  mag: { label: 'MAG FIELD', swatch: '#c08cff', legend: 'Crustal magnetic field nT' },
  fog: { label: 'FOG OF WAR', swatch: '#555', legend: 'Unexplored terrain' },
};

function rampColor(r: Ramp, t: number) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < r.length; i++) {
    if (t <= r[i][0]) {
      const [t0, c0] = r[i - 1];
      const [t1, c1] = r[i];
      const k = (t - t0) / (t1 - t0);
      return c0.map((v, j) => v + (c1[j] - v) * k);
    }
  }
  return r[r.length - 1][1];
}

function gridToCanvas(g: Grid, ramp: Ramp, lo?: number, hi?: number) {
  const { min, max } = gridStats(g);
  const a = lo ?? min;
  const b = hi ?? max;
  const c = document.createElement('canvas');
  c.width = g.width;
  c.height = g.height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(g.width, g.height);
  for (let i = 0; i < g.data.length; i++) {
    const col = rampColor(ramp, (g.data[i] - a) / (b - a || 1));
    img.data.set(col.map(Math.round), i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, min: a, max: b };
}

function hillshade(g: Grid) {
  const c = document.createElement('canvas');
  c.width = g.width;
  c.height = g.height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(g.width, g.height);
  const { min, max } = gridStats(g);
  const az = (315 * Math.PI) / 180;
  const alt = (40 * Math.PI) / 180;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const at = (xx: number, yy: number) => g.data[Math.max(0, Math.min(g.height - 1, yy)) * g.width + Math.max(0, Math.min(g.width - 1, xx))];
      const dzdx = (at(x + 1, y) - at(x - 1, y)) / (2 * g.cell);
      const dzdy = (at(x, y - 1) - at(x, y + 1)) / (2 * g.cell);
      const slope = Math.atan(1.6 * Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const shade = Math.max(0, Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect));
      const hn = (at(x, y) - min) / (max - min || 1);
      const k = (y * g.width + x) * 4;
      const base = 40 + 150 * shade;
      img.data[k] = base * (0.85 + 0.3 * hn) + 18;
      img.data[k + 1] = base * 0.62 * (0.85 + 0.3 * hn);
      img.data[k + 2] = base * 0.42;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export interface LayerImage {
  canvas: HTMLCanvasElement;
  min: number;
  max: number;
}

export class TacticalMap {
  layers: Record<LayerId, boolean> = { radiation: false, slope: false, poi: true, dust: false, mag: false, fog: true };
  base: HTMLCanvasElement;
  images: Partial<Record<LayerId, LayerImage>> = {};
  fogCanvas: HTMLCanvasElement;
  ext: ReturnType<typeof gridExtent>;
  planning = false;
  highlight = 0;

  constructor(private data: DataBundle, private sim: Sim) {
    this.ext = gridExtent(data.elevation);
    this.base = hillshade(data.elevation);
    this.images.radiation = gridToCanvas(data.radiation, RAMPS.radiation);
    this.images.slope = gridToCanvas(slopeGrid(data.elevation), RAMPS.slope, 0, 30);
    this.images.dust = gridToCanvas(data.dust, RAMPS.dust);
    this.images.mag = gridToCanvas(data.magnetic, RAMPS.mag);
    this.fogCanvas = document.createElement('canvas');
    this.fogCanvas.width = this.fogCanvas.height = Sim.FOG_N;
    sim.on('fog', () => (this.fogDirty = true));
  }
  private fogDirty = true;

  toggle(id: LayerId, on?: boolean) {
    this.layers[id] = on ?? !this.layers[id];
    return this.layers[id];
  }

  private updateFog() {
    if (!this.fogDirty) return;
    this.fogDirty = false;
    const n = Sim.FOG_N;
    const ctx = this.fogCanvas.getContext('2d')!;
    const img = ctx.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      img.data[i * 4 + 3] = this.sim.fog[i] ? 0 : 170;
    }
    ctx.putImageData(img, 0, 0);
  }

  toPx(e: number, n: number, w: number, h: number) {
    return { x: ((e - this.ext.minE) / (this.ext.maxE - this.ext.minE)) * w, y: ((this.ext.maxN - n) / (this.ext.maxN - this.ext.minN)) * h };
  }
  fromPx(x: number, y: number, w: number, h: number) {
    return { e: this.ext.minE + (x / w) * (this.ext.maxE - this.ext.minE), n: this.ext.maxN - (y / h) * (this.ext.maxN - this.ext.minN) };
  }

  private drawRoute(ctx: CanvasRenderingContext2D, route: Leg[], offset: number, w: number, h: number, color: string, width: number, dash: number[] = []) {
    if (!route.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let first = true;
    route.forEach((leg, i) => {
      for (const s of this.sim.world.legSamples(leg, i === 0 ? offset : 0)) {
        const p = this.toPx(s.e, s.n, w, h);
        if (first) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        first = false;
      }
    });
    ctx.stroke();
    ctx.restore();
  }

  draw(canvas: HTMLCanvasElement, opts: { planner?: { route: Leg[]; offset: number } | null; large?: boolean; t: number }) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cw;
    const h = ch;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, w, h);
    for (const id of ['slope', 'radiation', 'dust', 'mag'] as LayerId[]) {
      if (this.layers[id] && this.images[id]) ctx.drawImage(this.images[id]!.canvas, 0, 0, w, h);
    }
    // fog
    if (this.layers.fog) {
      this.updateFog();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.fogCanvas, 0, 0, w, h);
    }
    // all tracks
    for (const g of this.sim.world.edges.values()) {
      this.drawRoute(ctx, [{ edgeId: g.edge.id, forward: true }], 0, w, h, 'rgba(230,210,190,0.45)', 1.2, [3, 3]);
    }
    // walked path
    const path = this.sim.path;
    if (path.length > 1) {
      ctx.strokeStyle = 'rgba(60,227,154,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      path.forEach(([e, n], i) => {
        const p = this.toPx(e, n, w, h);
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      const cur = this.sim.position();
      const cp = this.toPx(cur.e, cur.n, w, h);
      ctx.lineTo(cp.x, cp.y);
      ctx.stroke();
    }
    // plan
    const plan = this.sim.plan;
    if (plan && this.sim.status === 'active') this.drawRoute(ctx, plan.route, plan.offset, w, h, '#39d0ff', opts.large ? 3.5 : 2.6);
    // advisory alternate
    const adv = this.sim.advisory;
    if (adv) {
      const pulse = 0.55 + 0.45 * Math.sin(opts.t * 6);
      this.drawRoute(ctx, adv.altRoute, adv.altOffset, w, h, `rgba(255,176,32,${pulse})`, opts.large ? 4 : 3, [7, 5]);
    }
    if (opts.planner) this.drawRoute(ctx, opts.planner.route, opts.planner.offset, w, h, '#ffffff', opts.large ? 3 : 2, [2, 4]);


    // POIs
    if (this.layers.poi) for (const p of this.data.pois) if (this.sim.discovered.has(p.id)) this.drawPoi(ctx, p, w, h, !!opts.large);
    this.drawLive(ctx, (e, n) => this.toPx(e, n, w, h), !!opts.large, !!opts.large);
    // field notes
    for (const m of this.sim.marks) {
      const p = this.toPx(m.e, m.n, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // planner nodes
    this.sim.plannerNodes.forEach((id, i) => {
      const nd = this.sim.world.nodes.get(id)!;
      const p = this.toPx(nd.e, nd.n, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, opts.large ? 10 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#081018';
      ctx.font = `bold ${opts.large ? 12 : 9}px JetBrains Mono, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y + 0.5);
    });
    if (this.planning || opts.large) {
      for (const nd of this.sim.world.nodes.values()) {
        const p = this.toPx(nd.e, nd.n, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, opts.large ? 6 : 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // drone
    const d = this.sim.drone;
    if (d.active) {
      const p = this.toPx(d.e, d.n, w, h);
      if (d.mode === 'scout' && d.path.length) {
        ctx.strokeStyle = 'rgba(207,246,255,0.6)';
        ctx.setLineDash([1, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        for (let i = d.idx; i < d.path.length; i++) {
          const q = this.toPx(d.path[i][0], d.path[i][1], w, h);
          ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = '#cff6ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 6, p.y - 6);
      ctx.lineTo(p.x + 6, p.y + 6);
      ctx.moveTo(p.x + 6, p.y - 6);
      ctx.lineTo(p.x - 6, p.y + 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    // astronaut
    const me = this.sim.position();
    const mp = this.toPx(me.e, me.n, w, h);
    const hd = this.headingRad;
    ctx.save();
    ctx.translate(mp.x, mp.y);
    ctx.rotate(hd);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#081018';
    ctx.lineWidth = 1.5;
    const s = opts.large ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(0, -9 * s);
    ctx.lineTo(6 * s, 7 * s);
    ctx.lineTo(0, 3 * s);
    ctx.lineTo(-6 * s, 7 * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // scale bar
    const m500 = (500 / (this.ext.maxE - this.ext.minE)) * w;
    ctx.fillStyle = 'rgba(207,246,255,0.9)';
    ctx.fillRect(10, h - 14, m500, 2);
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('500 m', 10, h - 18);
    ctx.textAlign = 'right';
    ctx.fillText('N ▲', w - 8, 14);
  }
  headingRad = 0;
  guardian: Guardian | null = null;

  /** tags, crew, blocked traverses and the live guide path: drawn on both the radar and the full map */
  private drawLive(ctx: CanvasRenderingContext2D, S: (e: number, n: number) => { x: number; y: number }, large: boolean, labels: boolean) {
    const sim = this.sim;
    // rockfall: blocked traverses in red with a cross
    for (const id of sim.world.blocked) {
      const g = sim.world.edges.get(id)!;
      ctx.strokeStyle = 'rgba(255,90,95,0.9)';
      ctx.lineWidth = large ? 3 : 2.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      g.samples.forEach((smp, i) => {
        const q = S(smp.e, smp.n);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const o of sim.obstacles.all) {
      if (o.kind !== 'rubble') continue;
      const q = S(o.e, o.n);
      ctx.fillStyle = 'rgba(255,90,95,0.9)';
      ctx.fillRect(q.x - 1.2, q.y - 1.2, 2.4, 2.4);
    }
    // live guide path (what the ground arrows follow)
    if (sim.status === 'active' && sim.guide.length > 1) {
      ctx.strokeStyle = sim.detour ? '#ff6bd6' : '#ffffff';
      ctx.lineWidth = large ? 2 : 1.6;
      ctx.setLineDash(sim.detour ? [] : [1, 3]);
      ctx.beginPath();
      sim.guide.forEach(([e, n], i) => {
        const q = S(e, n);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const g = this.guardian;
    if (!g) return;
    for (const en of g.entities) {
      const q = S(en.e, en.n);
      ctx.fillStyle = en.kind === 'teammate' ? '#4da3ff' : '#d8d8d8';
      ctx.strokeStyle = '#081018';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (en.kind === 'teammate') ctx.arc(q.x, q.y, large ? 5.5 : 4.2, 0, Math.PI * 2);
      else ctx.rect(q.x - 3.5, q.y - 3.5, 7, 7);
      ctx.fill();
      ctx.stroke();
      if (labels) {
        ctx.font = '11px Inter, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(235,250,255,0.95)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(en.name, q.x + 8, q.y);
      }
    }
    for (const t of g.tags) {
      const pos = g.tagPos(t);
      const q = S(pos.e, pos.n);
      const sz = large ? 6 : 4.5;
      ctx.fillStyle = TAG_INFO[t.kind].color;
      ctx.strokeStyle = '#081018';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y - sz);
      ctx.lineTo(q.x + sz, q.y);
      ctx.lineTo(q.x, q.y + sz);
      ctx.lineTo(q.x - sz, q.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (labels) {
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = TAG_INFO[t.kind].color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(t.label, q.x + sz + 4, q.y);
      }
    }
  }

  private drawPoi(ctx: CanvasRenderingContext2D, p: Poi, w: number, h: number, large: boolean) {
    const { x, y } = this.toPx(p.e, p.n, w, h);
    const sz = large ? 7 : 5;
    ctx.save();
    ctx.lineWidth = 1.5;
    if (p.kind === 'hazard') {
      const r = ((p.radius ?? 100) / (this.ext.maxE - this.ext.minE)) * w;
      ctx.fillStyle = 'rgba(255,176,32,0.18)';
      ctx.strokeStyle = 'rgba(255,176,32,0.9)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffb020';
      ctx.beginPath();
      ctx.moveTo(x, y - sz);
      ctx.lineTo(x + sz, y + sz * 0.8);
      ctx.lineTo(x - sz, y + sz * 0.8);
      ctx.closePath();
      ctx.fill();
    } else {
      const col = p.kind === 'habitat' ? '#3ce39a' : p.kind === 'shelter' ? '#a0e7ff' : p.kind === 'comms' ? '#3ce39a' : p.kind === 'cache' ? (this.guardian?.cachesUsed.has(p.id) ? '#777777' : '#ffb020') : '#39d0ff';
      ctx.fillStyle = col;
      ctx.strokeStyle = '#081018';
      if (p.kind === 'habitat') ctx.fillRect(x - sz, y - sz, sz * 2, sz * 2);
      else if (p.kind === 'shelter') {
        ctx.beginPath();
        ctx.moveTo(x - sz, y + sz * 0.6);
        ctx.lineTo(x, y - sz);
        ctx.lineTo(x + sz, y + sz * 0.6);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(x, y - sz);
        ctx.lineTo(x + sz, y);
        ctx.lineTo(x, y + sz);
        ctx.lineTo(x - sz, y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();
    }
    ctx.font = `${large ? 12 : 9.5}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(235,250,255,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 3;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.name, x + sz + 3, y);
    ctx.restore();
  }

  /**
   * Heading-up circular radar for the visor (player at centre). Draws the same
   * terrain + overlay layers as the full map, so layer toggles show here too.
   */
  drawRadar(canvas: HTMLCanvasElement, opts: { t: number; rangeM: number }) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = canvas.clientWidth;
    if (!size) return;
    if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const R = size / 2;
    const k = R / opts.rangeM;
    const me = this.sim.position();
    const hd = this.headingRad;
    const cos = Math.cos(-hd);
    const sin = Math.sin(-hd);
    /** world → radar px (heading-up) */
    const S = (e: number, n: number) => {
      const dx = (e - me.e) * k;
      const dy = -(n - me.n) * k;
      return { x: R + dx * cos - dy * sin, y: R + dx * sin + dy * cos };
    };
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(6,10,14,0.55)';
    ctx.fillRect(0, 0, size, size);
    // rasters in a rotated world frame
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(-hd);
    ctx.scale(k, k);
    ctx.translate(-me.e, me.n);
    const W = this.ext.maxE - this.ext.minE;
    const H = this.ext.maxN - this.ext.minN;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(this.base, this.ext.minE, -this.ext.maxN, W, H);
    ctx.globalAlpha = 0.85;
    for (const id of ['slope', 'radiation', 'dust', 'mag'] as LayerId[]) if (this.layers[id] && this.images[id]) ctx.drawImage(this.images[id]!.canvas, this.ext.minE, -this.ext.maxN, W, H);
    ctx.globalAlpha = 1;
    if (this.layers.fog) {
      this.updateFog();
      ctx.drawImage(this.fogCanvas, this.ext.minE, -this.ext.maxN, W, H);
    }
    ctx.restore();
    const line = (pts: { e: number; n: number }[], color: string, width: number, dash: number[] = []) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const q = S(p.e, p.n);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const legPts = (route: Leg[], offset: number) => route.flatMap((leg, i) => this.sim.world.legSamples(leg, i === 0 ? offset : 0));
    for (const g of this.sim.world.edges.values()) line(legPts([{ edgeId: g.edge.id, forward: true }], 0), 'rgba(235,220,200,0.35)', 1, [2, 3]);
    line(this.sim.path.map(([e, n]) => ({ e, n })).concat([me]), 'rgba(60,227,154,0.85)', 2);
    const plan = this.sim.plan;
    if (plan && this.sim.status === 'active') line(legPts(plan.route, plan.offset), '#39d0ff', 3);
    const adv = this.sim.advisory;
    if (adv) line(legPts(adv.altRoute, adv.altOffset), `rgba(255,176,32,${0.55 + 0.45 * Math.sin(opts.t * 6)})`, 3, [6, 4]);
    // hazards + POIs (upright symbols)
    for (const p of this.data.pois) {
      if (!this.sim.discovered.has(p.id)) continue;
      if (!this.layers.poi && p.kind !== 'hazard') continue;
      const q = S(p.e, p.n);
      if (p.kind === 'hazard') {
        ctx.fillStyle = 'rgba(255,176,32,0.16)';
        ctx.strokeStyle = 'rgba(255,176,32,0.9)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(q.x, q.y, (p.radius ?? 100) * k, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = p.kind === 'habitat' ? '#3ce39a' : p.kind === 'shelter' ? '#a0e7ff' : p.kind === 'cache' ? (this.guardian?.cachesUsed.has(p.id) ? '#777777' : '#ffb020') : '#39d0ff';
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    this.drawLive(ctx, S, false, false);
    const d = this.sim.drone;
    if (d.active) {
      const q = S(d.e, d.n);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
      ctx.moveTo(q.x - 7, q.y);
      ctx.lineTo(q.x + 7, q.y);
      ctx.moveTo(q.x, q.y - 7);
      ctx.lineTo(q.x, q.y + 7);
      ctx.stroke();
    }
    const wp = this.sim.nextWaypoint();
    if (wp) {
      const q = S(wp.e, wp.n);
      const dx = q.x - R;
      const dy = q.y - R;
      const dd = Math.hypot(dx, dy);
      const lim = R - 10;
      const qx = dd > lim ? R + (dx / dd) * lim : q.x;
      const qy = dd > lim ? R + (dy / dd) * lim : q.y;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(qx, qy, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // range ring + north tick
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(R, R, R / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    const nx = R + Math.sin(-hd) * (R - 11);
    const ny = R - Math.cos(-hd) * (R - 11);
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText('N', nx, ny);
    // astronaut (always pointing up)
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(R, R - 8);
    ctx.lineTo(R + 5.5, R + 6);
    ctx.lineTo(R, R + 2.5);
    ctx.lineTo(R - 5.5, R + 6);
    ctx.closePath();
    ctx.fill();
  }
}
