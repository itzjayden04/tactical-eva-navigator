/**
 * GUARDIAN: the part of TEVAN that acts without being asked.
 *
 * It watches the simulation and steps in: storm and marsquake response with
 * automatic rerouting, low-consumable reminders with a resupply or return plan,
 * fall detection with an "are you OK?" check that calls for help on silence,
 * hazard-zone geofencing with automatic stability assist, and crew tracking.
 * It also owns everything the astronaut creates: tags, photos, the comms log
 * and the undo stack. Framework-free, so the same logic runs in the tests.
 */
import type { IncidentDef, Poi } from '../data/types';
import type { Sim } from './sim';
import type { Obstacle } from './terrain';
import { RESERVE_FRAC } from './health';
import { sample, slopeDeg } from './grid';

export type TagKind = 'teammate' | 'habitat' | 'destination' | 'hazard' | 'sample' | 'resource' | 'note';
export const TAG_KINDS: TagKind[] = ['teammate', 'habitat', 'destination', 'hazard', 'sample', 'resource', 'note'];
export const TAG_INFO: Record<TagKind, { label: string; color: string; icon: string }> = {
  teammate: { label: 'Teammate', color: '#4da3ff', icon: 'person' },
  habitat: { label: 'Habitat', color: '#3ce39a', icon: 'home' },
  destination: { label: 'Destination', color: '#ff6bd6', icon: 'location_on' },
  hazard: { label: 'Hazard', color: '#ff5a4d', icon: 'warning' },
  sample: { label: 'Sample', color: '#39d0ff', icon: 'science' },
  resource: { label: 'Resource', color: '#ffb020', icon: 'inventory_2' },
  note: { label: 'Note', color: '#c9b8ff', icon: 'sticky_note_2' },
};

export interface Tag {
  id: number;
  kind: TagKind;
  label: string;
  e: number;
  n: number;
  up: number;
  /** entity id: the tag follows something that moves */
  follow?: string;
  met: number;
}

export interface Entity {
  id: string;
  name: string;
  kind: 'teammate' | 'rover';
  e: number;
  n: number;
  heading: number;
  moving: boolean;
  status: string;
  path: [number, number][];
  idx: number;
  speed: number;
}

/** What the astronaut is looking at in the world (produced by the renderer's ray pick). */
export interface Pick {
  type: 'entity' | 'poi' | 'boulder' | 'ground' | 'tag' | 'drone' | 'sky';
  id?: string;
  name: string;
  e: number;
  n: number;
  /** height above ground of the thing's centre, m */
  up: number;
  dist: number;
  /** apparent radius in metres (for the selection outline) */
  size: number;
  obstacle?: Obstacle;
}

export interface Comm {
  met: number;
  who: 'you' | 'tevan' | 'ev2' | 'hab' | 'sys';
  text: string;
}

export interface Card {
  icon: string;
  title: string;
  big: string;
  band?: 'ok' | 'caution' | 'warning';
  bar?: number;
  rows: [string, string, string?][];
  speech: string;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const bearingWord = (de: number, dn: number) => COMPASS[Math.round((((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360) / 45) % 8];
const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const distSay = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} kilometres` : `${Math.round(m)} metres`);
const mins = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;

export const RESUPPLY = { o2g: 300, waterg: 1500, battWh: 200 };
/** below this fraction TEVAN treats a consumable as "below normal" and proposes a plan */
export const LOW = { o2: 0.45, batt: 0.3, water: 0.25 };

export class Guardian {
  tags: Tag[] = [];
  private tagSeq = 0;
  entities: Entity[] = [];
  comms: Comm[] = [];
  cachesUsed = new Set<string>();
  photos: { met: number; e: number; n: number; headingDeg: number; caption: string; thumb?: string }[] = [];
  helpCalled = false;
  /** real seconds of ground shaking left (the renderer shakes the camera) */
  quakeT = 0;
  lastSaid = '';
  private flags = new Set<string>();
  private queue: IncidentDef[] = [];
  private timer = 0;
  private slow = 0;
  private insideHz = new Set<string>();
  private stabilityAuto = false;
  private blockedSaidAt = -1e9;
  private undoStack: { label: string; fn: () => void }[] = [];
  /** set false in tests that only want the base mission */
  scripted = true;

  constructor(public sim: Sim) {
    const hab = sim.world.nodes.get(sim.data.mission.startNodeId)!;
    this.entities = [
      { id: 'ev2', name: 'EV-2', kind: 'teammate', e: hab.e + 40, n: hab.n + 30, heading: 0, moving: true, status: 'Surveying near the habitat', path: [[hab.e + 40, hab.n + 30], [hab.e + 100, hab.n + 120], [hab.e + 20, hab.n + 200], [hab.e - 30, hab.n + 300], [hab.e - 100, hab.n + 220], [hab.e - 40, hab.n + 80]], idx: 1, speed: 0.8 },
      { id: 'rover', name: 'Rover 1', kind: 'rover', e: hab.e + 34, n: hab.n - 26, heading: 0.6, moving: false, status: 'Parked, charging', path: [], idx: 0, speed: 0 },
    ];
    sim.on('action', (a: string) => this.onAction(a));
    sim.on('trip', (t: { kind: string; where: string }) => this.onTrip(t));
    sim.on('blocked', () => this.onBlocked());
    sim.on('detour-arrive', (d: { id: string; label: string }) => this.onArrive(d));
    sim.extra = { tags: this.tags, comms: this.comms, photos: this.photos };
  }

  // ------------------------------------------------------------ dialogue
  /** TEVAN speaks (the UI listens for 'say'), and the line goes in the comms log. */
  say(text: string, who: Comm['who'] = 'tevan', icon = 'smart_toy') {
    this.record(who, text);
    if (who === 'tevan') this.lastSaid = text;
    this.sim.emit('say', { text, who, icon });
  }
  record(who: Comm['who'], text: string) {
    this.comms.push({ met: this.sim.met, who, text });
    if (this.comms.length > 300) this.comms.shift();
    this.sim.emit('comms');
  }
  pushUndo(label: string, fn: () => void) {
    this.undoStack.push({ label, fn });
    if (this.undoStack.length > 20) this.undoStack.shift();
  }
  undo(): string {
    const u = this.undoStack.pop();
    if (!u) return 'Nothing to undo';
    u.fn();
    this.sim.emit('change');
    return `Undone: ${u.label}`;
  }

  // ------------------------------------------------------------ per-frame
  update(dtReal: number) {
    const sim = this.sim;
    if (sim.status !== 'active') return;
    this.quakeT = Math.max(0, this.quakeT - dtReal);
    if (!sim.incident) this.moveEntities(dtReal * sim.warp);
    if (this.queue.length && !sim.incident && sim.waitS <= 0) sim.fireIncident(this.queue.shift()!);
    this.timer -= dtReal;
    if (this.timer > 0 || sim.incident) return;
    this.timer = 0.4;
    this.watchScript();
    this.watchConsumables();
    this.watchBody();
    this.watchZones();
  }

  private moveEntities(dt: number) {
    const me = this.sim.position();
    for (const en of this.entities) {
      if (en.kind !== 'teammate') continue;
      let target: [number, number] | null = null;
      if (this.helpCalled) {
        const d = Math.hypot(me.e - en.e, me.n - en.n);
        if (d < 6) {
          if (en.moving) {
            en.moving = false;
            en.status = 'With you';
            this.say('EV-2 has reached you.', 'tevan', 'group');
            this.say('I have eyes on you. Let’s get you home.', 'ev2', 'person');
          }
          continue;
        }
        en.moving = true;
        en.status = `Responding to your call · ${dist(d)} out`;
        target = [me.e, me.n];
      } else if (en.path.length) target = en.path[en.idx];
      if (!target) continue;
      const dx = target[0] - en.e;
      const dy = target[1] - en.n;
      const d = Math.hypot(dx, dy);
      if (d < 3 && !this.helpCalled) {
        en.idx = (en.idx + 1) % en.path.length;
        continue;
      }
      const k = Math.min(1, (en.speed * dt) / Math.max(1e-6, d));
      en.e += dx * k;
      en.n += dy * k;
      en.heading = Math.atan2(dx, dy);
    }
  }
  entity(id: string) {
    return this.entities.find((x) => x.id === id);
  }

  // ------------------------------------------------------------ scripted critical events at the sample sites
  private samplesDone() {
    return this.sim.data.mission.objectives.filter((o) => o.kind === 'sample' && this.sim.objectivesDone.has(o.id)).length;
  }
  private watchScript() {
    const sim = this.sim;
    if (!this.scripted || sim.waitS > 0) return;
    const done = this.samplesDone();
    if (done >= 1 && !this.flags.has('storm')) {
      this.flags.add('storm');
      this.queue.push(this.stormIncident());
    }
    if (done >= 2 && !this.flags.has('quake')) {
      this.flags.add('quake');
      this.marsquake();
    }
    // storm passed: release the automatic stability assist
    if (this.flags.has('storm') && !this.flags.has('storm-over') && !sim.mods.some((m) => m.id === 'storm') && !sim.incident && !this.queue.length) {
      this.flags.add('storm-over');
      if (this.stabilityAuto && !this.insideHz.size) this.stability(false, true);
      this.say('The dust front has passed. Visibility is back to normal.', 'tevan', 'air');
    }
  }

  private stormIncident(): IncidentDef {
    const sim = this.sim;
    const sh = this.nearestPoi('shelter');
    return {
      id: 'storm',
      title: 'DUST STORM FRONT INBOUND',
      category: 'WARNING · WEATHER',
      severity: 'warning',
      trigger: { type: 'met', seconds: sim.met },
      body: `Orbiter imagery shows a regional dust front crossing the delta. Wind gusts to 25 m/s and visibility under 40 m for about 20 minutes. Footing gets worse: stumble risk roughly doubles.${sh ? ` Nearest shelter is ${sh.name}, ${dist(sh.d)} ${bearingWord(sh.de, sh.dn)}.` : ''}`,
      onTrigger: [{ modifier: { id: 'storm', label: 'Dust storm', dust: 1.5, metMult: 1.08, durationS: 1200, delayS: 90 } }],
      options: [
        { label: 'Stability assist on, slow pace, keep moving', consequence: 'Suit braces your joints and caps speed. Stumble risk drops by about 70%.', tags: ['STABILITY', 'PACE ↓'], effects: [{ action: 'stability-on' }, { setPace: 'slow' }], recommended: true },
        { label: 'Hold here until it passes', consequence: 'Crouch behind the outcrop for 20 minutes. Consumables keep draining at rest.', tags: ['+20 min'], effects: [{ action: 'stability-on' }, { waitS: 1290 }] },
        { label: 'Carry on at normal pace', consequence: 'Fastest, with the highest chance of a fall in low visibility.', tags: ['FALL RISK ↑'], effects: [] },
      ],
      defaultOption: 0,
      timeoutS: 30,
    };
  }

  private marsquake() {
    const sim = this.sim;
    this.quakeT = 7;
    sim.body.shake = 1;
    sim.trip('stumble', 'the marsquake');
    this.say('Marsquake. Brace.', 'tevan', 'vibration');
    // rockfall closes the first leg of the way home, if there is another way round
    const here = sim.pos.node ?? (sim.pos.leg ? sim.world.legTo(sim.pos.leg) : null);
    const hab = sim.data.mission.startNodeId;
    const leg = sim.plan?.route.find((l) => !sim.pos.leg || l.edgeId !== sim.pos.leg.edgeId) ?? sim.plan?.route[0];
    let blockedName = '';
    const before = sim.plan?.forecast;
    if (leg && here) {
      sim.world.blocked.add(leg.edgeId);
      const ok = !!sim.world.shortestPath(here, hab);
      sim.world.blocked.delete(leg.edgeId);
      if (ok) {
        const g = sim.world.edges.get(leg.edgeId)!;
        const frac = Math.min(0.5, 150 / g.length);
        sim.blockEdge(leg.edgeId, leg.forward ? frac : 1 - frac);
        blockedName = g.edge.name;
      }
    }
    const after = sim.plan?.forecast;
    const via = sim.plan ? sim.world.routeName(sim.plan.route.slice(0, 3)) : '';
    const dt = before && after ? (after.timeS - before.timeS) / 60 : 0;
    this.queue.push({
      id: 'quake',
      title: blockedName ? `MARSQUAKE: ROCKFALL ON ${blockedName.toUpperCase()}` : 'MARSQUAKE',
      category: 'EMERGENCY · SEISMIC',
      severity: 'emergency',
      trigger: { type: 'met', seconds: sim.met },
      body: blockedName
        ? `Suit accelerometers and the habitat seismometer logged a magnitude 3.9 marsquake. Rockfall has closed ${blockedName} about 150 m ahead. TEVAN has already replanned your return via ${via || 'the remaining traverses'}${dt ? ` (${dt >= 0 ? '+' : ''}${dt.toFixed(0)} min)` : ''}${after ? `, arriving with ${(after.o2End * 100).toFixed(0)}% oxygen` : ''}. Aftershocks are likely for the next few minutes.`
        : 'Suit accelerometers and the habitat seismometer logged a magnitude 3.9 marsquake. No rockfall on your route. Aftershocks are likely for the next few minutes.',
      onTrigger: [],
      options: [
        { label: blockedName ? 'Take the new route with stability assist' : 'Continue with stability assist', consequence: 'Follow the ground arrows. The suit braces against aftershocks.', tags: ['REROUTED', 'STABILITY'], effects: [{ action: 'stability-on' }], recommended: true },
        { label: 'Hold 3 minutes for aftershocks, then go', consequence: 'Stay clear of slopes and boulders while the ground settles.', tags: ['+3 min'], effects: [{ action: 'stability-on' }, { waitS: 180 }] },
        { label: 'Send the drone to scout the new route first', consequence: 'Drone flies the new route and maps fresh hazards before you commit.', tags: ['DRONE'], effects: [{ action: 'drone-scout' }] },
      ],
      defaultOption: 0,
      timeoutS: 30,
    });
  }

  // ------------------------------------------------------------ consumables
  private watchConsumables() {
    const sim = this.sim;
    const h = sim.health;
    const o2 = h.o2g / h.o2Cap;
    const batt = h.battWh / h.battCap;
    const water = h.waterg / h.waterCap;
    const once = (k: string) => (this.flags.has(k) ? false : (this.flags.add(k), true));
    if (o2 > LOW.o2 + 0.1) this.flags.delete('o2-low');
    if (batt > LOW.batt + 0.1) this.flags.delete('batt-low');
    if (o2 < 0.5 && once('o2-half')) this.say(`Oxygen is at half. ${this.o2Outlook()}`, 'tevan', 'air');
    if (o2 < LOW.o2 && once('o2-low')) this.queue.push(this.lowIncident('o2', o2));
    else if (batt < LOW.batt && once('batt-low')) this.queue.push(this.lowIncident('batt', batt));
    if (water < LOW.water && once('water-low')) this.say(`Cooling water is at ${(water * 100).toFixed(0)} percent. Slow your pace to cut heat load, or resupply at ${this.nearestCache()?.poi.name ?? 'the habitat'}.`, 'tevan', 'water_drop');
    if (o2 < RESERVE_FRAC && once('o2-reserve')) this.say('Oxygen is below the 20 percent reserve. Head for the habitat or the nearest cache now.', 'tevan', 'emergency_home');
  }
  private o2Outlook() {
    const f = this.sim.plan?.forecast;
    return f ? `Forecast at the habitat is ${(f.o2End * 100).toFixed(0)} percent.` : '';
  }

  private lowIncident(what: 'o2' | 'batt', frac: number): IncidentDef {
    const sim = this.sim;
    const c = this.nearestCache();
    const hab = sim.bestCandidate(sim.data.mission.startNodeId, { wO2: 2000 });
    const f = sim.plan?.forecast;
    const name = what === 'o2' ? 'OXYGEN' : 'SUIT BATTERY';
    const endNow = what === 'o2' ? f?.o2End : f?.battEnd;
    const cacheOk = !!c && c.d < 900;
    const tight = endNow !== undefined && endNow < RESERVE_FRAC + 0.08;
    const recCache = cacheOk && (tight || c!.d < 400);
    const options: IncidentDef['options'] = [];
    if (c)
      options.push({
        label: `Resupply at ${c.poi.name}`,
        consequence: `${dist(c.d)} ${bearingWord(c.de, c.dn)}. Adds ${RESUPPLY.o2g} g O₂, ${(RESUPPLY.waterg / 1000).toFixed(1)} kg water and ${RESUPPLY.battWh} Wh. TEVAN guides you there around obstacles.`,
        tags: ['RESUPPLY', `${dist(c.d)}`],
        effects: [{ action: 'goto-cache' }],
        recommended: recCache,
      });
    options.push({
      label: 'Return to habitat now',
      consequence: hab ? `Safest route home: ${mins(hab.f.timeS)}, arriving with ${(hab.f.o2End * 100).toFixed(0)}% oxygen.` : 'Navigator plans the safest return.',
      tags: ['ABORT'],
      effects: [{ reroute: 'habitat' }],
      recommended: !recCache && tight,
    });
    if (what === 'batt' && !sim.mods.some((m) => m.id === 'shed')) options.push({ label: 'Shed non-critical loads', consequence: 'Dims the visor and pauses map overlays. Saves about 20 W.', tags: ['−20 W'], effects: [{ modifier: { id: 'shed', label: 'Loads shed', battExtraW: -20 } }], recommended: !recCache && !tight });
    else options.push({ label: 'Continue the mission, slow pace', consequence: `Lower workload cuts oxygen use by about a fifth.${endNow !== undefined ? ` Forecast at habitat now ${(endNow * 100).toFixed(0)}%.` : ''}`, tags: ['PACE ↓'], effects: [{ setPace: 'slow' }], recommended: !recCache && !tight });
    const rec = Math.max(0, options.findIndex((o) => o.recommended));
    options.forEach((o, i) => (o.recommended = i === rec));
    return {
      id: `${what}-low-${Math.round(sim.met)}`,
      title: `${name} BELOW NORMAL: ${(frac * 100).toFixed(0)}%`,
      category: 'CAUTION · LIFE SUPPORT',
      severity: 'caution',
      trigger: { type: 'met', seconds: sim.met },
      body: `${what === 'o2' ? 'Primary oxygen' : 'Suit battery'} is at ${(frac * 100).toFixed(0)}%.${endNow !== undefined ? ` On the current route you reach the habitat with ${(endNow * 100).toFixed(0)}%, against a ${(RESERVE_FRAC * 100).toFixed(0)}% reserve.` : ''} TEVAN compared your options:`,
      onTrigger: [],
      options,
      defaultOption: rec,
      timeoutS: 30,
    };
  }

  // ------------------------------------------------------------ body: falls, heart rate, blocked
  private onTrip(t: { kind: string; where: string }) {
    const sim = this.sim;
    if (t.kind !== 'fall') {
      sim.toast(`Stumble: ${t.where}. Watch your footing.`);
      return;
    }
    const falls = sim.stats2.falls;
    if (falls >= 2 && !sim.stability) this.stability(true, true);
    this.queue.push({
      id: `fall-${falls}`,
      title: 'FALL DETECTED',
      category: 'WARNING · CREW SAFETY',
      severity: 'warning',
      trigger: { type: 'met', seconds: sim.met },
      body: `Suit accelerometers registered a fall (${t.where}). Suit pressure is holding and no leak is detected. Are you OK? If you don’t answer, TEVAN calls for help with your position.${falls >= 2 ? ' This is fall number ' + falls + ', so stability assist is now on.' : ''}`,
      onTrigger: [],
      options: [
        { label: 'I’m OK', consequence: 'Stand up and continue. The fall is logged.', tags: ['CONTINUE'], effects: [{ action: 'ok' }], recommended: true },
        { label: 'I need help', consequence: 'Mayday to the habitat and EV-2 with your coordinates.', tags: ['MAYDAY'], effects: [{ action: 'call-help' }] },
        { label: 'I’m OK, rest 5 minutes', consequence: 'Hold still to bring heart rate and fatigue down.', tags: ['+5 min'], effects: [{ waitS: 300 }] },
      ],
      defaultOption: 1,
      timeoutS: 15,
    });
  }
  private onBlocked() {
    const sim = this.sim;
    if (sim.met - this.blockedSaidAt < 120) return;
    this.blockedSaidAt = sim.met;
    const p = sim.position();
    const low = sim.obstacles.near(p.e, p.n, 2.5).some((o) => o.h <= 0.7);
    this.say(low ? 'Low rock ahead. Jump it with Space, or step around.' : slopeDeg(sim.data.elevation, p.e, p.n) > 28 ? 'That slope is too steep to climb. Follow the arrows around it.' : 'Path blocked. Follow the ground arrows around it.', 'tevan', 'block');
  }
  private watchBody() {
    const h = this.sim.health;
    if (h.hr < 135 && h.coreC < 38.1) this.flags.delete('strain');
    if ((h.hr > 162 || h.coreC > 38.5) && !this.flags.has('strain') && this.sim.waitS <= 0) {
      this.flags.add('strain');
      this.say(h.coreC > 38.5 ? `Core temperature ${h.coreC.toFixed(1)} degrees. Say “rest” to hold for five minutes, or “slow pace”.` : `Heart rate ${h.hr.toFixed(0)}. Say “rest” to hold for five minutes, or “slow pace”.`, 'tevan', 'ecg_heart');
    }
  }

  // ------------------------------------------------------------ hazard geofence
  private watchZones() {
    const sim = this.sim;
    const p = sim.position();
    for (const hz of sim.data.pois) {
      if (hz.kind !== 'hazard' || !sim.discovered.has(hz.id)) continue;
      const inside = Math.hypot(hz.e - p.e, hz.n - p.n) < (hz.radius ?? 100);
      if (inside && !this.insideHz.has(hz.id)) {
        this.insideHz.add(hz.id);
        const auto = !sim.stability;
        if (auto) this.stability(true, true);
        sim.addLog({ kind: 'hazard', title: `Entered hazard zone: ${hz.name}`, severity: 'caution', outcome: auto ? 'Stability assist engaged automatically' : 'Stability assist already on' });
        this.say(`Entering ${hz.name}. ${hz.note ? hz.note.split(';')[0] + '. ' : ''}${auto ? 'Stability assist is on.' : ''}`, 'tevan', 'warning');
      } else if (!inside && this.insideHz.has(hz.id)) {
        this.insideHz.delete(hz.id);
        if (this.stabilityAuto && !this.insideHz.size && !sim.mods.some((m) => m.id === 'storm')) {
          this.stability(false, true);
          this.say(`Clear of ${hz.name}. Stability assist off.`, 'tevan', 'check_circle');
        }
      }
    }
  }

  // ------------------------------------------------------------ actions (voice, gaze, click, or incident options)
  private onAction(a: string) {
    if (a === 'stability-on') this.stability(true, true);
    else if (a === 'stability-off') this.stability(false);
    else if (a === 'goto-cache') this.say(this.goToCache());
    else if (a === 'call-help') this.say(this.callHelp(true), 'tevan', 'sos');
    else if (a === 'drone-scout') this.sim.launchDrone('scout');
    else if (a === 'ok') this.sim.addLog({ kind: 'info', title: 'Crew confirmed OK after fall', severity: 'info' });
  }

  stability(on = !this.sim.stability, auto = false): string {
    const sim = this.sim;
    if (sim.stability === on) return `Stability assist already ${on ? 'on' : 'off'}`;
    sim.stability = on;
    this.stabilityAuto = on && auto;
    sim.addLog({ kind: 'decision', title: `Stability assist ${on ? 'on' : 'off'}`, severity: 'info', decision: auto ? 'Automatic' : 'Crew' });
    sim.emit('change');
    return on ? 'Stability assist on. Speed capped, stumble risk down about 70 percent.' : 'Stability assist off.';
  }

  callHelp(auto = false): string {
    const sim = this.sim;
    const p = sim.position();
    const ev2 = this.entity('ev2');
    const d = ev2 ? Math.hypot(ev2.e - p.e, ev2.n - p.n) : 0;
    if (this.helpCalled) return ev2 ? `Help is already on the way. EV-2 is ${distSay(d)} out.` : 'Help is already on the way.';
    this.helpCalled = true;
    let relay = '';
    if (sim.agg().commsLoss && !(sim.drone.active && sim.drone.mode === 'relay')) {
      sim.mods = sim.mods.filter((m) => !m.spec.commsLoss);
      if (sim.drone.active) sim.drone.mode = 'relay';
      else sim.launchDrone('relay');
      relay = ' No direct link, so the drone is relaying.';
    }
    this.addTag('note', { type: 'ground', name: 'SOS position', e: p.e, n: p.n, up: 0, dist: 0, size: 1 }, 'SOS position', false);
    sim.addLog({ kind: 'incident', title: auto ? 'MAYDAY sent automatically (no answer after fall)' : 'MAYDAY: crew called for help', severity: 'emergency', outcome: `Position E${p.e.toFixed(0)} N${p.n.toFixed(0)} sent to habitat and EV-2` });
    if (ev2) {
      ev2.speed = 1.3;
      ev2.moving = true;
      ev2.status = 'Responding to your call';
    }
    const eta = ev2 ? d / 1.3 : 0;
    this.record('hab', `Habitat copies your mayday at E${p.e.toFixed(0)} N${p.n.toFixed(0)}. EV-2 is on the way, about ${mins(eta)}. Stay where you are if you can.`);
    sim.emit('change');
    return `Mayday sent with your position.${relay} Habitat acknowledged. ${ev2 ? `EV-2 is ${distSay(d)} away, about ${Math.max(1, Math.round(eta / 60))} minute${Math.round(eta / 60) > 1 ? 's' : ''}.` : ''} Stay where you are if you can.`;
  }

  backToHabitat(): string {
    const sim = this.sim;
    sim.clearDetour();
    sim.rerouteTo('habitat');
    const f = sim.plan?.forecast;
    return f ? `Returning to habitat. About ${Math.round(f.timeS / 60)} minutes, arriving with ${(f.o2End * 100).toFixed(0)} percent oxygen. Follow the arrows.` : 'Returning to habitat. Follow the arrows.';
  }
  toShelter(): string {
    const sim = this.sim;
    const sh = this.nearestPoi('shelter');
    if (!sh) return 'No shelter on the map';
    sim.clearDetour();
    sim.rerouteTo('shelter');
    return `Heading to ${sh.name}, ${distSay(sh.d)} ${bearingWord(sh.de, sh.dn)}. Follow the arrows.`;
  }
  rest(): string {
    const r = this.sim.rest(300);
    return r.startsWith('Resting') ? 'Resting for five minutes. Heart rate and fatigue will come down.' : r;
  }
  resumeMission(): string {
    const sim = this.sim;
    sim.clearDetour();
    sim.goalOverride = null;
    sim.committed = [];
    sim.recomputePlan();
    sim.updateGuide(true);
    sim.addLog({ kind: 'decision', title: 'Mission plan resumed', severity: 'info' });
    sim.emit('change');
    const wp = sim.nextWaypoint();
    return wp ? `Mission plan resumed. Next is ${wp.name}.` : 'Mission plan resumed.';
  }

  // ------------------------------------------------------------ supply caches
  private nearestPoi(kind: Poi['kind']) {
    const p = this.sim.position();
    let best: { poi: Poi; d: number; de: number; dn: number; name: string } | null = null;
    for (const poi of this.sim.data.pois) {
      if (poi.kind !== kind) continue;
      const d = Math.hypot(poi.e - p.e, poi.n - p.n);
      if (!best || d < best.d) best = { poi, d, de: poi.e - p.e, dn: poi.n - p.n, name: poi.name };
    }
    return best;
  }
  nearestCache() {
    const p = this.sim.position();
    let best: { poi: Poi; d: number; de: number; dn: number } | null = null;
    for (const poi of this.sim.data.pois) {
      if (poi.kind !== 'cache' || this.cachesUsed.has(poi.id)) continue;
      const d = Math.hypot(poi.e - p.e, poi.n - p.n);
      if (!best || d < best.d) best = { poi, d, de: poi.e - p.e, dn: poi.n - p.n };
    }
    return best;
  }
  goToCache(): string {
    const c = this.nearestCache();
    if (!c) return 'No unused supply cache left. Say “back to habitat”.';
    if (c.d < 14) return this.resupply();
    this.sim.setDetour(c.poi.e, c.poi.n, c.poi.name, `cache:${c.poi.id}`);
    return `Guiding you to ${c.poi.name}, ${distSay(c.d)} ${bearingWord(c.de, c.dn)}. Follow the arrows.`;
  }
  resupply(): string {
    const sim = this.sim;
    const c = this.nearestCache();
    if (!c || c.d > 20) return c ? `${c.poi.name} is ${distSay(c.d)} away. Say “go to cache”.` : 'No unused supply cache left';
    if (sim.waitS > 0) return 'Already busy';
    this.cachesUsed.add(c.poi.id);
    sim.hold(180, 'RESUPPLYING', () => {
      const h = sim.health;
      const before = { o2: h.o2g, w: h.waterg, b: h.battWh };
      h.o2g = Math.min(h.o2Cap, h.o2g + RESUPPLY.o2g);
      h.waterg = Math.min(h.waterCap, h.waterg + RESUPPLY.waterg);
      h.battWh = Math.min(h.battCap, h.battWh + RESUPPLY.battWh);
      sim.addLog({ kind: 'info', title: `Resupplied at ${c.poi.name}`, severity: 'info', outcome: `+${(h.o2g - before.o2).toFixed(0)} g O2, +${((h.waterg - before.w) / 1000).toFixed(1)} kg water, +${(h.battWh - before.b).toFixed(0)} Wh` });
      sim.recomputePlan();
      this.say(`Resupply complete. Oxygen ${((h.o2g / h.o2Cap) * 100).toFixed(0)} percent, battery ${((h.battWh / h.battCap) * 100).toFixed(0)} percent. ${this.o2Outlook()}`, 'tevan', 'inventory_2');
      sim.emit('change');
    });
    return `Resupplying at ${c.poi.name}. Three minutes.`;
  }
  private onArrive(d: { id: string; label: string }) {
    if (d.id.startsWith('cache:')) this.say(this.resupply(), 'tevan', 'inventory_2');
    else this.say(`You have arrived at ${d.label}.`, 'tevan', 'location_on');
  }

  // ------------------------------------------------------------ tags
  tagPos(t: Tag): { e: number; n: number } {
    const en = t.follow ? this.entity(t.follow) : null;
    return en ? { e: en.e, n: en.n } : { e: t.e, n: t.n };
  }
  /** Sensible default tag type for what was picked (TEVAN asks when it can't tell). */
  suggestKind(p: Pick): TagKind | null {
    if (p.type === 'entity') return p.id === 'ev2' ? 'teammate' : 'resource';
    if (p.type === 'drone') return 'resource';
    if (p.type === 'poi') {
      const poi = this.sim.data.pois.find((x) => x.id === p.id);
      if (!poi) return null;
      return poi.kind === 'habitat' ? 'habitat' : poi.kind === 'hazard' ? 'hazard' : poi.kind === 'sample' ? 'sample' : poi.kind === 'cache' ? 'resource' : 'destination';
    }
    return null;
  }
  addTag(kind: TagKind, p: Pick, label?: string, undoable = true): Tag {
    const count = this.tags.filter((t) => t.kind === kind).length + 1;
    const named = p.type === 'entity' || p.type === 'poi' || p.type === 'drone';
    const t: Tag = { id: ++this.tagSeq, kind, label: label ?? (named ? p.name : `${TAG_INFO[kind].label} ${count}`), e: p.e, n: p.n, up: p.up, follow: p.type === 'entity' ? p.id : undefined, met: this.sim.met };
    this.tags.push(t);
    this.sim.addLog({ kind: 'info', title: `Tagged ${TAG_INFO[kind].label.toLowerCase()}: ${t.label}`, severity: 'info', outcome: `E${p.e.toFixed(0)} N${p.n.toFixed(0)}${t.follow ? ' · follows a moving target' : ''}` });
    if (undoable) this.pushUndo(`tag ${t.label}`, () => this.removeTag(t.id));
    this.sim.emit('change');
    return t;
  }
  removeTag(id?: number): Tag | null {
    const i = id === undefined ? this.tags.length - 1 : this.tags.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const [t] = this.tags.splice(i, 1);
    if (this.sim.detour?.id === `tag:${t.id}`) this.sim.clearDetour();
    this.sim.emit('change');
    return t;
  }
  /** Navigate to a tag: the newest destination tag by default, or the newest tag of a given kind. */
  goToTag(kind?: TagKind): string {
    const pool = [...this.tags].reverse();
    const t = pool.find((x) => (kind ? x.kind === kind : x.kind === 'destination')) ?? (kind ? undefined : pool[0]);
    if (!t) return kind ? `No ${TAG_INFO[kind].label.toLowerCase()} tag yet. Look at something and say “label this”.` : 'No tags yet. Look at something and say “label this”.';
    const pos = this.tagPos(t);
    const me = this.sim.position();
    this.sim.setDetour(pos.e, pos.n, t.label, `tag:${t.id}`);
    return `Guiding you to ${t.label}, ${distSay(Math.hypot(pos.e - me.e, pos.n - me.n))} ${bearingWord(pos.e - me.e, pos.n - me.n)}.`;
  }
  goToTeammate(): string {
    const en = this.entity('ev2');
    if (!en) return 'No teammate on the surface';
    const me = this.sim.position();
    this.sim.setDetour(en.e, en.n, en.name, 'entity:ev2');
    return `Guiding you to ${en.name}, ${distSay(Math.hypot(en.e - me.e, en.n - me.n))} ${bearingWord(en.e - me.e, en.n - me.n)}.`;
  }

  // ------------------------------------------------------------ "what is this"
  describe(p: Pick): Card {
    const sim = this.sim;
    const me = sim.position();
    const where = `${dist(p.dist)} ${bearingWord(p.e - me.e, p.n - me.n)}`;
    const whereSay = `${distSay(p.dist)} to the ${bearingWord(p.e - me.e, p.n - me.n)}`;
    const tagged = this.tags.find((t) => Math.hypot(this.tagPos(t).e - p.e, this.tagPos(t).n - p.n) < 4);
    const tagRow: [string, string, string?][] = tagged ? [['Tagged', `${TAG_INFO[tagged.kind].label}: ${tagged.label}`]] : [];
    if (p.type === 'sky') {
      const agg = sim.agg();
      const c = sim.data.conditions;
      return { icon: 'wb_twilight', title: 'Martian sky', big: `τ ${(c.dustTau + agg.dust).toFixed(1)}`, rows: [['Dust opacity', agg.dust > 0.5 ? 'Storm' : 'Normal', agg.dust > 0.5 ? 'caution' : ''], ['Surface temp', `${c.surfaceTempC} °C`], ['Dose rate here', `${sim.doseRateHere().toFixed(0)} µSv/h`]], speech: `That is the sky. Dust opacity ${(c.dustTau + agg.dust).toFixed(1)}, surface temperature ${c.surfaceTempC} degrees. ${agg.dust > 0.5 ? 'A dust storm is active.' : 'No storm right now.'}` };
    }
    if (p.type === 'entity') {
      const en = this.entity(p.id!)!;
      if (en.kind === 'teammate') return { icon: 'person', title: `${en.name} · crewmate`, big: dist(p.dist), rows: [['Status', en.status], ['Moving', en.moving ? `Yes, ${en.speed.toFixed(1)} m/s` : 'No'], ['Bearing', bearingWord(p.e - me.e, p.n - me.n)], ['Link', sim.agg().commsLoss ? 'No signal' : 'Voice + telemetry', sim.agg().commsLoss ? 'warning' : 'ok'], ...tagRow], speech: `That is ${en.name}, your crewmate, ${whereSay}. ${en.status}. ${en.moving ? 'Moving.' : 'Stationary.'}` };
      return { icon: 'agriculture', title: en.name, big: dist(p.dist), rows: [['Status', en.status], ['Moving', 'No'], ['Bearing', bearingWord(p.e - me.e, p.n - me.n)], ...tagRow], speech: `That is ${en.name}, ${whereSay}. ${en.status}.` };
    }
    if (p.type === 'drone') return { icon: 'flight', title: 'Scout drone', big: `${sim.drone.battery.toFixed(0)}%`, rows: [['Mode', sim.drone.mode], ['Range', dist(p.dist)], ['Altitude', `${sim.drone.alt.toFixed(0)} m`]], speech: `That is your scout drone, ${whereSay}, in ${sim.drone.mode} mode with ${sim.drone.battery.toFixed(0)} percent battery.` };
    if (p.type === 'tag') {
      const t = this.tags.find((x) => String(x.id) === p.id)!;
      return { icon: TAG_INFO[t.kind].icon, title: `${TAG_INFO[t.kind].label} tag · ${t.label}`, big: dist(p.dist), rows: [['Bearing', bearingWord(p.e - me.e, p.n - me.n)], ['Tagged at', `MET ${Math.floor(t.met / 60)} min`], ['Follows', t.follow ? 'A moving target' : 'Fixed position']], speech: `That is your ${TAG_INFO[t.kind].label.toLowerCase()} tag, ${t.label}, ${whereSay}. Say “go to tag” to navigate there.` };
    }
    if (p.type === 'poi') {
      const poi = sim.data.pois.find((x) => x.id === p.id)!;
      const rows: [string, string, string?][] = [['Type', poi.kind], ['Distance', where]];
      let extra = '';
      if (poi.kind === 'cache') {
        const used = this.cachesUsed.has(poi.id);
        rows.push(['Contents', used ? 'Used' : `${RESUPPLY.o2g} g O₂ · ${(RESUPPLY.waterg / 1000).toFixed(1)} kg water · ${RESUPPLY.battWh} Wh`, used ? 'caution' : 'ok']);
        extra = used ? 'It has already been used.' : 'Say “go to cache” to resupply there.';
      } else if (poi.kind === 'shelter') {
        rows.push(['Sky blocked', `${Math.round((1 - (poi.shielding ?? 1)) * 100)}%`, 'ok']);
        extra = `It blocks ${Math.round((1 - (poi.shielding ?? 1)) * 100)} percent of the sky during a radiation event.`;
      } else if (poi.kind === 'hazard') {
        rows.push(['Radius', `${poi.radius ?? 100} m`, 'caution']);
        extra = 'TEVAN turns stability assist on when you enter it.';
      } else if (poi.kind === 'sample') {
        const obj = sim.data.mission.objectives.find((o) => sim.world.nodes.get(o.nodeId)?.poiId === poi.id);
        const done = obj ? sim.objectivesDone.has(obj.id) : false;
        rows.push(['Sample', done ? 'Sealed' : 'Pending', done ? 'ok' : '']);
        extra = done ? 'The sample here is already sealed.' : 'A sample is still to be collected here.';
      } else if (poi.kind === 'habitat') extra = 'Home. Say “back to habitat” to route there.';
      if (poi.note) rows.push(['Note', poi.note]);
      return { icon: poi.kind === 'hazard' ? 'warning' : poi.kind === 'cache' ? 'inventory_2' : poi.kind === 'habitat' ? 'home' : 'location_on', title: poi.name, big: dist(p.dist), rows: [...rows, ...tagRow], speech: `That is ${poi.name}, ${whereSay}. ${poi.note ? poi.note.split(';')[0] + '. ' : ''}${extra}` };
    }
    if (p.type === 'boulder' && p.obstacle) {
      const o = p.obstacle;
      const jump = o.h <= 0.7;
      const rubble = o.kind === 'rubble';
      return {
        icon: rubble ? 'landslide' : 'landscape',
        title: rubble ? 'Rockfall debris' : jump ? 'Low rock' : 'Boulder',
        big: `${(o.r * 2).toFixed(1)} m`,
        band: jump ? 'ok' : 'caution',
        rows: [['Height', `${o.h.toFixed(1)} m`], ['Distance', where], ['Passable', jump ? 'Jump it (Space)' : 'No, go around', jump ? 'ok' : 'caution'], ...tagRow],
        speech: rubble ? `That is fresh rockfall debris from the marsquake, ${whereSay}. It blocks the traverse. The arrows route around it.` : jump ? `That is a low rock, about ${(o.h * 100).toFixed(0)} centimetres high, ${whereSay}. You can jump it with Space.` : `That is a boulder about ${(o.r * 2).toFixed(1)} metres across and ${o.h.toFixed(1)} metres high, ${whereSay}. Too tall to jump. The arrows route around it.`,
      };
    }
    // open ground
    const g = sim.data.elevation;
    const sl = slopeDeg(g, p.e, p.n);
    const rock = sim.data.rocks ? sample(sim.data.rocks, p.e, p.n) : 0.2;
    const dust = sample(sim.data.dust, p.e, p.n);
    const dose = sample(sim.data.radiation, p.e, p.n);
    const dh = sample(g, p.e, p.n) - me.h;
    const surface = sl > 20 ? 'Loose scree slope' : rock > 0.55 ? 'Boulder-strewn ground' : dust > 1.2 ? 'Soft wind-blown sand' : rock > 0.3 ? 'Rocky regolith' : 'Firm regolith';
    const footing = sl > 31 ? 'Impassable' : sl > 20 || rock > 0.55 ? 'Poor' : sl > 12 || rock > 0.35 || dust > 1.2 ? 'Fair' : 'Good';
    const hz = sim.data.pois.find((x) => x.kind === 'hazard' && sim.discovered.has(x.id) && Math.hypot(x.e - p.e, x.n - p.n) < (x.radius ?? 100));
    let trav = '';
    for (const e of sim.world.edges.values()) {
      if (e.samples.some((s) => Math.hypot(s.e - p.e, s.n - p.n) < 12)) {
        trav = e.edge.name + (sim.world.blocked.has(e.edge.id) ? ' (blocked)' : '');
        break;
      }
    }
    return {
      icon: 'terrain',
      title: surface,
      big: `${sl.toFixed(0)}°`,
      band: footing === 'Good' ? 'ok' : footing === 'Fair' ? 'caution' : 'warning',
      rows: [['Footing', footing, footing === 'Good' ? 'ok' : footing === 'Fair' ? 'caution' : 'warning'], ['Distance', where], ['Height vs you', `${dh >= 0 ? '+' : ''}${dh.toFixed(0)} m`], ['Dose rate there', `${dose.toFixed(0)} µSv/h`], ...(trav ? ([['Traverse', trav]] as [string, string][]) : []), ...(hz ? ([['Hazard zone', hz.name, 'caution']] as [string, string, string][]) : []), ...tagRow],
      speech: `${surface}, ${whereSay}. Slope ${sl.toFixed(0)} degrees, footing ${footing.toLowerCase()}.${trav ? ` It is on the ${trav}.` : ''}${hz ? ` Inside the ${hz.name} hazard zone.` : ''} Say “label this” to tag it.`,
    };
  }

  // ------------------------------------------------------------ status cards (visor tools)
  teamCard(): Card {
    const me = this.sim.position();
    const ev2 = this.entity('ev2')!;
    const rover = this.entity('rover')!;
    const hab = this.sim.world.nodes.get(this.sim.data.mission.startNodeId)!;
    const d = Math.hypot(ev2.e - me.e, ev2.n - me.n);
    const los = this.sim.agg().commsLoss && !(this.sim.drone.active && this.sim.drone.mode === 'relay');
    return {
      icon: 'group',
      title: 'Team',
      big: dist(d),
      rows: [['EV-2', `${dist(d)} ${bearingWord(ev2.e - me.e, ev2.n - me.n)}`], ['EV-2 status', ev2.status, this.helpCalled ? 'caution' : ''], ['Rover 1', `${dist(Math.hypot(rover.e - me.e, rover.n - me.n))} · ${rover.status}`], ['Habitat', dist(Math.hypot(hab.e - me.e, hab.n - me.n))], ['Comms link', los ? 'No signal' : 'Good', los ? 'warning' : 'ok'], ['Mayday', this.helpCalled ? 'Sent, help en route' : 'Not sent', this.helpCalled ? 'warning' : '']],
      speech: `EV-2 is ${distSay(d)} to the ${bearingWord(ev2.e - me.e, ev2.n - me.n)}. ${ev2.status}. Comms link ${los ? 'is down' : 'is good'}.`,
    };
  }
  suppliesCard(): Card {
    const me = this.sim.position();
    const caches = this.sim.data.pois.filter((p) => p.kind === 'cache');
    const left = caches.filter((c) => !this.cachesUsed.has(c.id)).length;
    const near = this.nearestCache();
    return {
      icon: 'inventory_2',
      title: 'Supply caches',
      big: `${left} / ${caches.length}`,
      bar: caches.length ? left / caches.length : 0,
      rows: [...caches.map((c) => [c.name, this.cachesUsed.has(c.id) ? 'Used' : `${dist(Math.hypot(c.e - me.e, c.n - me.n))} ${bearingWord(c.e - me.e, c.n - me.n)}`, this.cachesUsed.has(c.id) ? 'caution' : 'ok'] as [string, string, string]), ['Each holds', `${RESUPPLY.o2g} g O₂ · ${(RESUPPLY.waterg / 1000).toFixed(1)} kg H₂O · ${RESUPPLY.battWh} Wh`]],
      speech: near ? `${left} of ${caches.length} supply caches unused. The nearest is ${near.poi.name}, ${distSay(near.d)} ${bearingWord(near.de, near.dn)}. Say “go to cache”.` : 'All supply caches are used.',
    };
  }
  weatherCard(): Card {
    const sim = this.sim;
    const c = sim.data.conditions;
    const agg = sim.agg();
    const storm = sim.mods.find((m) => m.id === 'storm' || m.id === 'dust');
    const spe = sim.mods.find((m) => m.spec.doseMult && m.spec.doseMult > 1);
    const rate = sim.rates.doseRate;
    return {
      icon: 'air',
      title: 'Weather and space weather',
      big: storm ? 'Storm' : 'Clear',
      band: storm || spe ? 'caution' : 'ok',
      rows: [['Dust opacity τ', (c.dustTau + agg.dust).toFixed(1), agg.dust > 0.5 ? 'caution' : ''], ['Dust event', storm ? (storm.delayS && storm.delayS > 0 ? `${storm.label} arrives in ${mins(storm.delayS)}` : `${storm.label}, ${mins(storm.remainingS ?? 0)} left`) : 'None', storm ? 'caution' : 'ok'], ['Surface temp', `${c.surfaceTempC} °C`], ['Dose rate', rate >= 1000 ? `${(rate / 1000).toFixed(1)} mSv/h` : `${rate.toFixed(0)} µSv/h`, rate > 200 ? 'warning' : ''], ['Solar particle event', spe ? (spe.delayS && spe.delayS > 0 ? `Onset in ${mins(spe.delayS)}` : `Active, ${mins(spe.remainingS ?? 0)} left`) : 'None', spe ? 'warning' : 'ok'], ['Seismic', this.flags.has('quake') ? 'M3.9 logged, aftershocks possible' : 'Quiet', this.flags.has('quake') ? 'caution' : 'ok']],
      speech: `${storm ? `${storm.label} ${storm.delayS && storm.delayS > 0 ? 'is inbound' : 'is active'}.` : 'No dust event.'} ${spe ? 'A solar particle event is in progress.' : 'Space weather is quiet.'} Surface temperature ${c.surfaceTempC} degrees.`,
    };
  }
  tagsCard(): Card {
    const me = this.sim.position();
    return {
      icon: 'sell',
      title: 'Tags',
      big: String(this.tags.length),
      rows: this.tags.length
        ? this.tags.slice(-7).map((t) => {
            const pos = this.tagPos(t);
            return [`${TAG_INFO[t.kind].label} · ${t.label}`, `${dist(Math.hypot(pos.e - me.e, pos.n - me.n))} ${bearingWord(pos.e - me.e, pos.n - me.n)}`, `tag-${t.kind}`] as [string, string, string];
          })
        : [['No tags yet', 'look at something, say “label this”']],
      speech: this.tags.length ? `${this.tags.length} tag${this.tags.length > 1 ? 's' : ''}. The latest is ${this.tags[this.tags.length - 1].label}.` : 'No tags yet. Look at something and say label this.',
    };
  }
  logCard(): Card {
    const log = this.sim.log.slice(-7).reverse();
    return {
      icon: 'history',
      title: 'Mission log',
      big: String(this.sim.log.length),
      rows: log.map((l) => [`${String(Math.floor(l.met / 60)).padStart(3, ' ')} min`, l.title + (l.decision ? ` → ${l.decision}` : ''), l.severity === 'info' ? '' : l.severity === 'emergency' ? 'warning' : l.severity] as [string, string, string]),
      speech: log[0] ? `Last event: ${log[0].title}.${log[0].decision ? ` Decision: ${log[0].decision}.` : ''}` : 'The log is empty.',
    };
  }
}
