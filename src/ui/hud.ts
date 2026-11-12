/**
 * HUD controller. Binds simulation state to DOM elements by ID
 * (the same IDs used in the Stitch prompt pack), so a Stitch-exported
 * layout can replace index.html without touching this logic.
 */
import type { DataBundle } from '../data/types';
import { Sim, PACE_V } from '../core/sim';
import { bandCore, bandDose, bandFatigue, bandFrac, bandHr, Band, NOMINAL_SUIT_KPA, RESERVE_FRAC } from '../core/health';
import { walkSpeed } from '../core/route';
import { LAYER_INFO, LayerId, TacticalMap } from './map';
import { drawChart } from './chart';
import type { World } from '../render/scene';

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
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const bandClass = (b: Band) => (b === 'ok' ? 'ok-t' : `${b}-t`);
const bandColor = (b: Band) => (b === 'ok' ? 'var(--ok)' : b === 'caution' ? 'var(--caution)' : 'var(--warning)');

export class Hud {
  map: TacticalMap;
  private acc = 0;
  private toastTimer = 0;
  planning = false;
  mapExpanded = false;
  private t = 0;

  constructor(private data: DataBundle, private sim: Sim, private world: World) {
    this.map = new TacticalMap(data, sim);
    this.buildLayerChips();
    this.buildCompass();
    $('hud-datasource').textContent = `DATA: ${data.label}`;
    $('hud-eva-id').textContent = data.mission.id.toUpperCase();
    sim.on('toast', (m: string) => this.toast(m));
    sim.on('incident', () => this.showIncident());
    sim.on('change', () => this.refreshStatic());
    sim.on('planner', () => this.refreshPlanner());
    sim.on('log', () => {});
  }

  // ------------------------------------------------------------ layers
  private buildLayerChips() {
    const ids: LayerId[] = ['radiation', 'slope', 'poi', 'dust', 'mag'];
    const mk = (container: HTMLElement, list: LayerId[], prefix: string) => {
      container.innerHTML = '';
      for (const id of list) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.id = `${prefix}${id}`;
        b.dataset.layer = id;
        b.innerHTML = `<i style="background:${LAYER_INFO[id].swatch}"></i>${LAYER_INFO[id].label}`;
        b.onclick = () => this.toggleLayer(id);
        container.appendChild(b);
      }
    };
    mk($('map-layers'), ids, 'lyr-');
    mk($('mx-layers'), [...ids, 'fog'], 'mx-lyr-');
    this.syncChips();
  }
  toggleLayer(id: LayerId) {
    const on = this.map.toggle(id);
    this.syncChips();
    return on;
  }
  syncChips() {
    document.querySelectorAll<HTMLElement>('.chip[data-layer]').forEach((c) => c.classList.toggle('on', this.map.layers[c.dataset.layer as LayerId]));
    const leg: string[] = [];
    for (const id of ['radiation', 'slope', 'dust', 'mag'] as LayerId[]) {
      if (!this.map.layers[id]) continue;
      const img = this.map.images[id];
      leg.push(`<div><b style="color:${LAYER_INFO[id].swatch}">■</b> ${LAYER_INFO[id].legend}${img ? ` · ${img.min.toFixed(1)}–${img.max.toFixed(1)}` : ''}</div>`);
    }
    $('mx-legend').innerHTML = leg.join('') || '<div>No overlays active</div>';
  }

  // ------------------------------------------------------------ compass
  private buildCompass() {
    const tape = $('compass-tape');
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let d = -360; d <= 720; d += 15) {
      const dd = ((d % 360) + 360) % 360;
      const label = names[dd] ?? (dd % 30 === 0 ? String(dd).padStart(3, '0') : '|');
      html += `<span class="${names[dd] ? 'major' : label === '|' ? 'tick' : ''}" style="left:${d * 3}px">${label}</span>`;
    }
    tape.innerHTML = html;
  }
  private updateCompass() {
    const hd = this.world.heading();
    const box = $('hud-compass');
    const w = box.clientWidth;
    $('compass-tape').style.transform = `translateX(${w / 2 - hd * 3}px)`;
    $('hud-heading').textContent = `${String(Math.round(hd) % 360).padStart(3, '0')}°`;
    const wp = this.sim.nextWaypoint();
    const tgt = $('hud-compass-target');
    if (wp) {
      const p = this.sim.position();
      const brg = ((Math.atan2(wp.e - p.e, wp.n - p.n) * 180) / Math.PI + 360) % 360;
      let d = brg - hd;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      tgt.style.left = `${Math.max(8, Math.min(w - 8, w / 2 + d * 3))}px`;
      tgt.style.display = '';
    } else tgt.style.display = 'none';
    this.map.headingRad = (hd * Math.PI) / 180;
  }

  // ------------------------------------------------------------ per-frame
  update(dt: number) {
    this.t += dt;
    this.updateCompass();
    this.updateChevrons();
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) $('toast').classList.add('hidden');
    }
    this.acc += dt;
    const planner = this.planning || this.mapExpanded ? this.sim.plannerRoute() : null;
    if (this.mapExpanded) this.map.draw($('map-canvas-large') as HTMLCanvasElement, { planner, large: true, t: this.t });
    else this.map.draw($('map-canvas') as HTMLCanvasElement, { planner, t: this.t });
    if (this.acc < 0.1) return;
    this.acc = 0;
    this.updateTelemetry();
    const inc = this.sim.incident;
    if (inc) {
      $('inc-countdown').textContent = `${Math.ceil(inc.remainingReal)} s`;
      $('inc-ring').style.strokeDashoffset = String(94.25 * (1 - Math.max(0, inc.remainingReal / inc.def.timeoutS)));
    }
  }

  private setReadout(id: string, val: string, frac: number, band: Band) {
    const el = $(id);
    const v = el.querySelector('.val') as HTMLElement;
    v.textContent = val;
    v.className = `val ${bandClass(band)}`;
    const bar = el.querySelector('.bar i') as HTMLElement;
    bar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    bar.style.background = bandColor(band);
  }
  private setConsumable(id: string, frac: number, val: string, sub: string) {
    const el = $(id);
    const b = bandFrac(frac);
    const v = el.querySelector('.val') as HTMLElement;
    v.textContent = val;
    v.className = `val mono ${bandClass(b)}`;
    const bar = el.querySelector('.cbar i') as HTMLElement;
    bar.style.width = `${Math.max(0, frac) * 100}%`;
    bar.style.background = b === 'ok' ? 'var(--accent)' : bandColor(b);
    (el.querySelector('.sub') as HTMLElement).textContent = sub;
    (el.querySelector('.reserve') as HTMLElement).style.left = `${RESERVE_FRAC * 100}%`;
  }

  updateTelemetry() {
    const s = this.sim;
    const h = s.health;
    const agg = s.agg();
    $('hud-met').textContent = fmtMET(s.met);
    $('hud-warp').textContent = s.waitS > 0 ? `TIME WARP ×${Math.max(40, s.warp)} · HOLD` : `TIME WARP ×${s.warp}`;
    const lmst = (s.data.mission.startLmstH + (s.met / 3600) * (24 / 24.66)) % 24;
    $('hud-lmst').textContent = `SOL ${s.data.mission.sol} · ${String(Math.floor(lmst)).padStart(2, '0')}:${String(Math.floor((lmst % 1) * 60)).padStart(2, '0')} LMST`;
    const comms = $('hud-comms');
    const relay = s.drone.active && s.drone.mode === 'relay';
    comms.innerHTML = agg.commsLoss && !relay ? '<i class="dot warning"></i>COMMS LOS' : relay ? '<i class="dot caution"></i>COMMS AOS · RELAY' : '<i class="dot ok"></i>COMMS AOS';
    comms.classList.toggle('los', !!agg.commsLoss && !relay);

    this.setReadout('v-hr', h.hr.toFixed(0), (h.hr - 50) / 140, bandHr(h.hr));
    this.setReadout('v-met', h.metW.toFixed(0), h.metW / 800, h.metW > 600 ? 'caution' : 'ok');
    this.setReadout('v-core', h.coreC.toFixed(1), (h.coreC - 36) / 4, bandCore(h.coreC));
    this.setReadout('v-press', h.suitKPa.toFixed(1), h.suitKPa / NOMINAL_SUIT_KPA, h.suitKPa < 28 ? 'warning' : h.suitKPa < 29.2 ? 'caution' : 'ok');
    this.setReadout('v-co2', h.co2kPa.toFixed(2), h.co2kPa / 1.0, h.co2kPa > 0.7 ? 'caution' : 'ok');
    this.setReadout('v-fatigue', h.fatigue.toFixed(0), h.fatigue / 100, bandFatigue(h.fatigue));
    $('v-fatigue').classList.toggle('hot', h.fatigue >= 60);
    $('v-fatigue').classList.toggle('pulse', !!s.advisory && s.advisory.title.includes('FATIGUE'));
    $('v-pace').textContent = s.pace.toUpperCase();
    const p = s.position();
    const moving = s.isMoving();
    const eta = s.pos.leg && s.offTrack < 30 ? s.world.edges.get(s.pos.leg.edgeId)!.eta : 1.4;
    $('v-speed').textContent = `${moving ? walkSpeed(PACE_V[s.pace] * (s.input.sprint ? 1.35 : 1), p.gradePct, eta, agg.speedCap, agg.dust).toFixed(2) : '0.00'} m/s`;
    $('v-mods').innerHTML = s.mods.map((m) => `<span class="${m.spec.leakGph || m.spec.doseMult ? 'warning' : ''}">${esc(m.label)}${m.delayS && m.delayS > 0 ? ` in ${fmtDur(m.delayS)}` : m.remainingS ? ` ${fmtDur(m.remainingS)}` : ''}</span>`).join('');

    const o2f = h.o2g / h.o2Cap;
    const wf = h.waterg / h.waterCap;
    const bf = h.battWh / h.battCap;
    const tl = (amount: number, rate: number) => (rate > 1e-6 ? fmtDur(amount / rate) : '—');
    this.setConsumable('c-o2', o2f, `${(o2f * 100).toFixed(0)}% · ${h.o2g.toFixed(0)} g`, `${(s.rates.o2gps * 3600).toFixed(0)} g/h · ${tl(h.o2g - h.o2Cap * RESERVE_FRAC, s.rates.o2gps)} to reserve`);
    this.setConsumable('c-h2o', wf, `${(wf * 100).toFixed(0)}% · ${(h.waterg / 1000).toFixed(2)} kg`, `${(s.rates.watergps * 3600).toFixed(0)} g/h · ${tl(h.waterg, s.rates.watergps)} left`);
    this.setConsumable('c-batt', bf, `${(bf * 100).toFixed(0)}% · ${h.battWh.toFixed(0)} Wh`, `${s.rates.battWps.toFixed(0)} W · ${tl(h.battWh * 3600, s.rates.battWps)} left${h.battCap < s.data.mission.consumables.battWh - 1 ? ' · CAPACITY REDUCED' : ''}`);

    const budget = s.data.mission.consumables.doseBudgetmSv;
    const db = bandDose(h.doseMSv, budget);
    $('d-total').textContent = h.doseMSv.toFixed(h.doseMSv < 10 ? 3 : 1);
    $('d-total').className = `big mono ${bandClass(db)}`;
    const rate = s.rates.doseRate;
    $('d-rate').textContent = `${rate >= 1000 ? (rate / 1000).toFixed(2) + ' mSv/h' : rate.toFixed(0) + ' µSv/h'}`;
    $('d-rate').className = `mono ${rate > 200 ? 'warning-t' : rate > 40 ? 'caution-t' : ''}`;
    const dbar = $('d-bar').querySelector('i') as HTMLElement;
    dbar.style.width = `${Math.min(100, (h.doseMSv / budget) * 100)}%`;
    dbar.style.background = bandColor(db);
    const shield = rate / Math.max(1e-6, p.doseBase * agg.doseMult);
    const shelterPoi = s.data.pois.find((q) => q.shielding !== undefined && q.radius && Math.hypot(q.e - p.e, q.n - p.n) <= q.radius);
    $('d-shield').textContent = shield < 0.95 ? `Shielding: ${((1 - shield) * 100).toFixed(0)}% sky blocked (${shelterPoi?.name ?? 'terrain'})` : `Terrain shielding ${Math.max(0, (1 - p.doseBase / s.data.conditions.gcrDoseRateuSvH) * 100).toFixed(0)}% · EVA budget ${budget} mSv`;
    $('dose-vignette').style.opacity = String(Math.min(0.9, Math.max(0, (rate - 60) / 1500)));

    // drone
    const d = s.drone;
    $('drone-status').textContent = d.active ? `BATT ${d.battery.toFixed(0)}% · ALT ${d.alt.toFixed(0)} m · ${d.mode.toUpperCase()} · ${Math.hypot(d.e - p.e, d.n - p.n).toFixed(0)} m` : `BATT ${d.battery.toFixed(0)}% · DOCKED`;
    $('drone-pip').classList.toggle('live', d.active);
    document.body.classList.toggle('drone-live', d.active);
    $('btn-drone').toggleAttribute('disabled', d.active);

    // route
    const plan = s.plan;
    if (plan) {
      const m = plan.metrics;
      $('r-dist').textContent = km(m.distance);
      $('r-gain').textContent = `+${m.gain.toFixed(0)} m`;
      $('r-slope').textContent = `${m.maxSlopeDeg.toFixed(0)}°`;
      $('r-slope').className = `mono ${m.maxSlopeDeg > 20 ? 'warning-t' : m.maxSlopeDeg > 15 ? 'caution-t' : ''}`;
      $('r-eta').textContent = fmtDur(plan.forecast.timeS);
      const wp = s.nextWaypoint();
      $('r-segment').textContent = s.pos.leg ? s.world.edges.get(s.pos.leg.edgeId)!.edge.name : `At ${s.world.nodes.get(s.pos.node!)!.name}`;
      $('r-next').textContent = (s.offTrack > 30 ? `OFF TRACE ${s.offTrack.toFixed(0)} m · ` : '') + (wp ? `${wp.name} · ${km(wp.dist)}` : '');
      $('r-next').className = s.offTrack > 30 ? 'caution-t' : 'muted';
      const goal = s.world.nodes.get(plan.goal);
      $('r-goal').textContent = goal ? `→ ${goal.name.toUpperCase()}${s.goalOverride ? ` (${s.goalOverride.kind.toUpperCase()})` : ''}` : '';
      const o2End = plan.forecast.o2End;
      $('r-eta').title = `O2 at end ${(o2End * 100).toFixed(0)}%`;
    }
    drawChart($('r-chart') as HTMLCanvasElement, {
      met: s.met,
      history: s.history,
      now: { o2: o2f, fatigue: h.fatigue, batt: bf, dose: h.doseMSv },
      forecast: plan?.forecast,
      alt: s.advisory?.alt,
      planner: this.planning ? s.plannerEvaluate()?.forecast : null,
    });
    if (this.mapExpanded) this.refreshPlanner();

    // wait banner
    const wb = $('wait-banner');
    wb.classList.toggle('hidden', !(s.waitS > 0));
    if (s.waitS > 0) $('wait-text').textContent = `${s.waitReason} · ${fmtDur(s.waitS)} remaining`;

    // AR vitals
    if (document.body.classList.contains('minimal')) {
      const cell = (k: string, v: string, b: Band) => `<div class="cell ${b}"><em>${k}</em><b>${v}</b><i></i></div>`;
      $('ar-vitals').innerHTML = [
        cell('HR', h.hr.toFixed(0), bandHr(h.hr)),
        cell('MET', `${h.metW.toFixed(0)} W`, 'ok'),
        cell('CORE', `${h.coreC.toFixed(1)}°C`, bandCore(h.coreC)),
        cell('FATIGUE', h.fatigue.toFixed(0), bandFatigue(h.fatigue)),
        cell('O2', `${(o2f * 100).toFixed(0)}%`, bandFrac(o2f)),
        cell('H2O', `${(wf * 100).toFixed(0)}%`, bandFrac(wf)),
        cell('BATT', `${(bf * 100).toFixed(0)}%`, bandFrac(bf)),
        cell('DOSE', `${h.doseMSv.toFixed(2)} mSv`, db),
        cell('RATE', `${rate.toFixed(0)} µSv/h`, rate > 200 ? 'warning' : rate > 40 ? 'caution' : 'ok'),
      ].join('');
    }
  }

  // ------------------------------------------------------------ waypoint chevrons & hazard markers
  private updateChevrons() {
    const s = this.sim;
    const layer = $('hud-chevrons');
    const items: string[] = [];
    const W = window.innerWidth;
    const H = window.innerHeight;
    const add = (e: number, n: number, up: number, cls: string, chev: string, label: string) => {
      const pr = this.world.project(e, n, up);
      if (!pr.visible) return false;
      if (pr.x < -50 || pr.x > W + 50 || pr.y < -50 || pr.y > H + 50) return false;
      const inner = cls === '' ? `<div class="chev"></div><div class="lab">${label}</div><div class="pin"></div><i></i>` : `<div class="lab">${label}</div>`;
      void chev;
      items.push(`<div class="wp ${cls}" style="left:${pr.x.toFixed(0)}px;top:${pr.y.toFixed(0)}px">${inner}</div>`);
      return true;
    };
    const wp = s.nextWaypoint();
    if (wp && s.status === 'active') {
      const shown = add(wp.e, wp.n, 6, '', '▼', `${esc(wp.name.toUpperCase())} · ${km(wp.dist)}`);
      if (!shown) {
        // off-screen indicator at the edge
        const p = s.position();
        const brg = Math.atan2(wp.e - p.e, wp.n - p.n);
        let d = brg - (this.world.heading() * Math.PI) / 180;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const x = d > 0 ? W - 330 : 300;
        items.push(`<div class="wp edge" style="left:${x}px;top:${H / 2}px"><div class="lab">${d > 0 ? '' : '◀ '}${esc(wp.name.toUpperCase())}${d > 0 ? ' ▶' : ''}</div></div>`);
      }
    }
    const me = s.position();
    for (const poi of s.data.pois) {
      if (!s.discovered.has(poi.id)) continue;
      const dist = Math.hypot(poi.e - me.e, poi.n - me.n);
      if (dist > 1600 || (wp && Math.hypot(poi.e - wp.e, poi.n - wp.n) < 30)) continue;
      if (poi.kind === 'hazard') add(poi.e, poi.n, 2, 'hz', '▲', `${esc(poi.name.toUpperCase())} · ${km(Math.max(0, dist - (poi.radius ?? 0)))}`);
      else if (dist > 25) add(poi.e, poi.n, 8, 'poi', '◆', `${esc(poi.name)} · ${km(dist)}`);
    }
    layer.innerHTML = items.join('');
  }

  // ------------------------------------------------------------ event-driven panels
  refreshStatic() {
    const s = this.sim;
    // junction chooser
    const jc = $('junction-chooser');
    const showJc = s.awaitingChoice && !s.incident && s.waitS <= 0 && s.status === 'active';
    jc.classList.toggle('hidden', !showJc);
    if (showJc) {
      const node = s.world.nodes.get(s.pos.node!)!;
      $('jc-title').textContent = `${node.name.toUpperCase()}: CHOOSE TRAVERSE → ${s.world.nodes.get(s.currentGoal())?.name.toUpperCase() ?? ''} · PRESS A NUMBER, THEN WALK [W]`;
      $('jc-options').innerHTML = s.choices
        .slice(0, 4)
        .map((c, i) => {
          const f = c.forecast;
          const to = s.world.nodes.get(s.world.legTo(c.leg))!.name;
          const tag = c.recommended ? '<span class="tag">RECOMMENDED</span>' : !f.feasible ? '<span class="tag bad">INFEASIBLE</span>' : f.peakFatigue > 70 || c.metrics.maxSlopeDeg > 18 ? '<span class="tag caution">CAUTION</span>' : '';
          return `<button class="jc-opt ${c.recommended ? 'rec' : ''} ${s.committed[0]?.edgeId === c.leg.edgeId ? 'sel' : ''}" data-i="${i}">
            <div class="top"><kbd>${i + 1}</kbd>${tag}</div>
            <div class="name">${esc(c.name)}</div>
            <div class="m">→ ${esc(to)} · ${km(c.metrics.distance)} · max ${c.metrics.maxSlopeDeg.toFixed(0)}°<br/>to goal ${fmtDur(f.timeS)} · fatigue ${f.peakFatigue.toFixed(0)} · O2 ${(f.o2End * 100).toFixed(0)}% · +${f.doseAdded.toFixed(2)} mSv</div>
            <div class="foot"><span class="${/sand|scree|boulder/i.test(c.surface) ? 'caution-t' : ''}">${esc(c.surface.toUpperCase())}</span><span>PRESS [${i + 1}]</span></div></button>`;
        })
        .join('');
      jc.querySelectorAll<HTMLElement>('.jc-opt').forEach((b) => (b.onclick = () => s.choose(Number(b.dataset.i))));
    }
    $('sample-prompt').classList.toggle('hidden', !(s.samplePrompt && s.waitS <= 0 && !s.incident));
    // reroute banner
    const adv = s.advisory;
    $('reroute-banner').classList.toggle('hidden', !adv);
    $('ar-reroute').classList.toggle('hidden', !adv);
    document.body.classList.toggle('has-advisory', !!adv);
    if (adv) {
      $('rr-title').textContent = adv.title;
      $('rr-reason').textContent = adv.reason;
      const rows: [string, number, number, (v: number) => string, boolean][] = [
        ['Distance', adv.currentMetrics.distance, adv.altMetrics.distance, km, true],
        ['Max slope', adv.currentMetrics.maxSlopeDeg, adv.altMetrics.maxSlopeDeg, (v) => `${v.toFixed(0)}°`, true],
        ['Peak fatigue', adv.current.peakFatigue, adv.alt.peakFatigue, (v) => v.toFixed(0), true],
        ['O2 at goal', adv.current.o2End * 100, adv.alt.o2End * 100, (v) => `${v.toFixed(0)}%`, false],
        ['Dose', adv.current.doseAdded, adv.alt.doseAdded, (v) => `${v.toFixed(2)} mSv`, true],
        ['ETA', adv.current.timeS, adv.alt.timeS, fmtDur, true],
      ];
      $('rr-compare').innerHTML =
        `<tr><th>METRIC</th><th>CURRENT</th><th>ALTERNATE (${esc((s.world.routeName(adv.altRoute) || 'same traverse').toUpperCase())}${adv.pace ? ` · ${adv.pace.toUpperCase()} PACE` : ''})</th></tr>` +
        rows.map(([k, a, b, f, lowerBetter]) => `<tr><td class="muted">${k}</td><td>${f(a)}</td><td class="${(lowerBetter ? b < a : b > a) ? 'better' : b === a ? '' : 'worse'}">${f(b)}</td></tr>`).join('');
      $('ar-reroute').innerHTML = `<span class="ms">alt_route</span>REROUTE: ${esc(adv.title.split('·')[1]?.trim() ?? adv.title)} <b>ACCEPT [R]</b>`;
    }
    // objectives
    const goal = s.currentGoal();
    $('r-objectives').innerHTML = s.data.mission.objectives
      .map((o) => `<li class="${s.objectivesDone.has(o.id) ? 'done' : o.nodeId === goal ? 'current' : ''}">${s.objectivesDone.has(o.id) ? '✓' : '○'} ${esc(o.label)}</li>`)
      .join('');
    $('incident-modal').classList.toggle('hidden', !s.incident);
  }

  showIncident() {
    const inc = this.sim.incident;
    if (!inc) return;
    const def = inc.def;
    const modal = $('incident-modal');
    modal.classList.remove('caution', 'warning', 'emergency');
    modal.classList.add(def.severity);
    $('inc-advisory').textContent = def.severity === 'emergency' ? 'AUTOMATED THREAT ADVISORY · EMERGENCY' : def.severity === 'warning' ? 'MISSION CONTROL WARNING' : 'NAVIGATOR CAUTION ADVISORY';
    $('inc-category').textContent = def.category;
    $('inc-time').textContent = `MET ${fmtMET(this.sim.met)}`;
    $('inc-title').textContent = def.title;
    $('inc-body').textContent = def.body;
    const s = this.sim;
    const h = s.health;
    const p = s.position();
    const hab = s.world.nodes.get(s.data.mission.startNodeId)!;
    const agg = s.agg();
    const impact: [string, string, string][] = [];
    if (agg.leakGph) impact.push(['O2 LEAK RATE', `${agg.leakGph.toFixed(0)} g/h`, 'PLSS compensating'], ['TIME TO RESERVE', fmtDur((h.o2g - h.o2Cap * RESERVE_FRAC) / ((agg.leakGph + 70) / 3600)), 'at current draw']);
    const spe = s.mods.find((m) => m.spec.doseMult && m.spec.doseMult > 1);
    if (spe) impact.push(['ONSET IN', fmtDur(spe.delayS ?? 0), `duration ${fmtDur(spe.remainingS ?? 0)}`], ['PEAK DOSE RATE', `${((p.doseBase * (spe.spec.doseMult ?? 1)) / 1000).toFixed(1)} mSv/h`, `now ${s.rates.doseRate.toFixed(0)} µSv/h`]);
    if (agg.dust) impact.push(['DUST OPACITY', `τ +${agg.dust.toFixed(1)}`, 'visibility < 30 m']);
    if (agg.speedCap < 50 && impact.length < 2) impact.push(['SPEED CAP', `${agg.speedCap.toFixed(2)} m/s`, 'injury / terrain']);
    if (impact.length < 2) impact.push(['O2 REMAINING', `${((h.o2g / h.o2Cap) * 100).toFixed(0)}%`, `fatigue ${h.fatigue.toFixed(0)}`]);
    impact.push(['DIST TO HAB', km(Math.hypot(hab.e - p.e, hab.n - p.n)), 'straight line']);
    $('inc-impact').innerHTML = impact.slice(0, 3).map(([k, v, sub]) => `<div><span class="lbl">${k}</span><div class="v">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`).join('');
    $('inc-options').innerHTML = def.options
      .map(
        (o, i) => `<button class="inc-opt ${o.recommended ? 'recommended' : ''}" data-i="${i}"><kbd>${i + 1}</kbd><div><div class="l">${esc(o.label)}</div><div class="c">${esc(o.consequence)}</div></div>
        <div class="tags">${o.recommended ? '<span class="rec">RECOMMENDED</span>' : ''}${o.tags.map((t) => `<span class="${/RISK|HIGH|ABORT/.test(t) ? 'risk' : ''}">${esc(t)}</span>`).join('')}</div></button>`,
      )
      .join('');
    $('inc-options').querySelectorAll<HTMLElement>('.inc-opt').forEach((b) => (b.onclick = () => s.resolveIncident(Number(b.dataset.i))));
    $('inc-default').textContent = `Default: option ${def.defaultOption + 1} when timer ends`;
    modal.classList.remove('hidden');
  }

  toast(msg: string) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    this.toastTimer = 3.5;
  }

  refreshPlanner() {
    const s = this.sim;
    $('planner-list').innerHTML = s.plannerNodes.map((id) => `<li>${esc(s.world.nodes.get(id)!.name)}</li>`).join('') || '<li class="empty">No waypoints yet: click the map</li>';
    $('planner-count').textContent = `${s.plannerNodes.length} WAYPOINTS`;
    const ev = s.plannerEvaluate();
    if (ev) {
      const m = ev.metrics;
      const f = ev.forecast;
      const cell = (k: string, v: string, warn = false, cls = '') => `<div class="m ${cls}"><span class="lbl">${k}</span><b class="${warn ? 'caution-t' : ''}">${v}</b></div>`;
      $('planner-metrics').innerHTML = [
        cell('DISTANCE', km(m.distance)),
        cell('ELEV GAIN', `+${m.gain.toFixed(0)} m`),
        cell('EST TIME', fmtDur(f.timeS)),
        cell('MAX SLOPE', `${m.maxSlopeDeg.toFixed(0)}°`, m.maxSlopeDeg > 15),
        cell(f.peakFatigue > 70 ? 'PEAK FATIGUE · CEILING 70 EXCEEDED' : 'PEAK FATIGUE', f.peakFatigue.toFixed(0), f.peakFatigue > 70, f.peakFatigue > 70 ? 'full bad' : 'full'),
        cell('END O2', `${(f.o2End * 100).toFixed(0)}%`, f.o2End < 0.3),
        cell('DOSE ACCUM', `${f.doseAdded.toFixed(2)} mSv`),
      ].join('');
      drawChart($('planner-chart') as HTMLCanvasElement, { met: s.met, history: s.history, now: { o2: s.health.o2g / s.health.o2Cap, fatigue: s.health.fatigue, batt: s.health.battWh / s.health.battCap, dose: s.health.doseMSv }, forecast: s.plan?.forecast, planner: f });
    } else {
      $('planner-metrics').innerHTML = '<div class="m full"><span class="lbl">ADD 2+ WAYPOINTS TO SEE METRICS</span></div>';
      drawChart($('planner-chart') as HTMLCanvasElement, { met: s.met, history: s.history, now: { o2: s.health.o2g / s.health.o2Cap, fatigue: s.health.fatigue, batt: s.health.battWh / s.health.battCap, dose: s.health.doseMSv }, forecast: s.plan?.forecast });
    }
  }
}
