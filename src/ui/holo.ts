/**
 * HOLO LABELS: mixed-reality identification cards.
 *
 * The moment the astronaut's eyes land on something identifiable in the world
 * (a boulder, a site, the crewmate, the drone, a tag), an ID card appears next
 * to it, anchored to the object in 3D. When the eyes move on, the card does not
 * vanish: it holds for HOLD_MS (3.5 s) with a countdown ring, then fades.
 *
 * World-locked while the object is in view; when the astronaut turns away so
 * the object leaves the visor, the card "tags along" on the visor edge on the
 * side the object is, with an arrow and how far to turn, until its time is up.
 */
import type { World } from '../render/scene';
import type { Card, Guardian, Pick } from '../core/guardian';
import { esc, km } from './hud';

export const HOLD_MS = 3500;
const MAX_CARDS = 3;
const CARD_W = 250;
const EDGE = 22;

interface Holo {
  key: string;
  p: Pick;
  el: HTMLElement;
  leader: HTMLElement;
  dot: HTMLElement;
  card: Card;
  born: number;
  lastSeen: number;
  seen: boolean;
  refreshAt: number;
  x: number;
  y: number;
  placed: boolean;
  dying: boolean;
}

/** stable identity of a picked thing, so looking back at it refreshes the same card */
export function holoKey(p: Pick): string {
  if (p.type === 'boulder') return `boulder:${p.e.toFixed(1)},${p.n.toFixed(1)}`;
  return `${p.type}:${p.id ?? p.name}`;
}

/** what is worth a card: named things, and rocks close enough to matter */
export function identifiable(p: Pick | null): p is Pick {
  if (!p) return false;
  return p.type === 'entity' || p.type === 'poi' || p.type === 'tag' || p.type === 'drone' || (p.type === 'boulder' && p.dist < 90);
}

export class HoloLabels {
  private items: Holo[] = [];
  private last = performance.now();

  constructor(private root: HTMLElement, private world: World, private guardian: Guardian) {}

  /** Number of cards on the visor (for tests / diagnostics). */
  get count() {
    return this.items.filter((h) => !h.dying).length;
  }

  /** Call with what the eyes rest on right now (null = nothing identifiable). */
  observe(p: Pick | null, now = performance.now()) {
    for (const h of this.items) h.seen = false;
    if (!identifiable(p)) return;
    const key = holoKey(p);
    let h = this.items.find((i) => i.key === key && !i.dying);
    if (!h) {
      h = this.create(key, p, now);
      this.items.push(h);
      // keep the visor clean: the oldest card makes room
      const live = this.items.filter((i) => !i.dying);
      if (live.length > MAX_CARDS) this.kill(live.sort((a, b) => a.lastSeen - b.lastSeen)[0]);
    }
    h.p = p;
    h.seen = true;
    h.lastSeen = now;
  }

  /** Remove every card (EVA end, map open…). */
  clear() {
    for (const h of this.items) this.kill(h);
  }

  private create(key: string, p: Pick, now: number): Holo {
    const el = document.createElement('div');
    el.className = 'holo';
    const leader = document.createElement('div');
    leader.className = 'holo-leader';
    const dot = document.createElement('div');
    dot.className = 'holo-dot';
    this.root.append(leader, dot, el);
    const h: Holo = { key, p, el, leader, dot, card: this.guardian.describe(p), born: now, lastSeen: now, seen: true, refreshAt: now + 500, x: 0, y: 0, placed: false, dying: false };
    this.render(h);
    requestAnimationFrame(() => el.classList.add('in'));
    return h;
  }

  private kill(h: Holo) {
    if (h.dying) return;
    h.dying = true;
    h.el.classList.add('out');
    h.leader.style.opacity = '0';
    h.dot.style.opacity = '0';
    setTimeout(() => {
      h.el.remove();
      h.leader.remove();
      h.dot.remove();
      this.items = this.items.filter((i) => i !== h);
    }, 260);
  }

  private render(h: Holo) {
    const c = h.card;
    const rows = c.rows
      .filter(([k]) => k !== 'Note' && k !== 'Bearing')
      .slice(0, 3)
      .map(([k, v, cls]) => `<div class="hr"><span>${esc(k)}</span><b class="${cls ?? ''}">${esc(v.length > 46 ? v.slice(0, 44) + '…' : v)}</b></div>`)
      .join('');
    h.el.innerHTML = `
      <svg class="holo-ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" /><circle class="t" cx="10" cy="10" r="8" /></svg>
      <div class="holo-head"><span class="ms">${esc(c.icon)}</span><b>${esc(c.title)}</b>${c.big ? `<span class="holo-big">${esc(c.big)}</span>` : ''}</div>
      ${rows ? `<div class="holo-rows">${rows}</div>` : ''}
      <div class="holo-dir"><span class="ms">arrow_upward</span><span class="txt"></span></div>`;
    h.el.dataset.band = c.band ?? '';
  }

  /** where the thing is now (crew and drone move) */
  private anchor(h: Holo) {
    const p = h.p;
    if (p.type === 'entity') {
      const en = this.guardian.entity(p.id!);
      if (en) return { e: en.e, n: en.n, up: p.up };
    }
    if (p.type === 'drone') {
      const d = this.guardian.sim.drone;
      return { e: d.e, n: d.n, up: d.alt };
    }
    return { e: p.e, n: p.n, up: p.up };
  }

  /** Call every frame. */
  update(now = performance.now()) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const W = this.root.clientWidth || window.innerWidth;
    const H = this.root.clientHeight || window.innerHeight;
    const me = this.guardian.sim.position();
    const hd = this.world.heading();
    const pinned: { h: Holo; side: number; rel: number }[] = [];
    for (const h of this.items) {
      if (h.dying) continue;
      const remain = h.seen ? HOLD_MS : HOLD_MS - (now - h.lastSeen);
      if (remain <= 0) {
        this.kill(h);
        continue;
      }
      const a = this.anchor(h);
      const dist = Math.hypot(a.e - me.e, a.n - me.n);
      if (now > h.refreshAt) {
        h.refreshAt = now + 500;
        h.card = this.guardian.describe({ ...h.p, e: a.e, n: a.n, dist });
        this.render(h);
      }
      h.el.style.setProperty('--t', String(Math.max(0, remain / HOLD_MS)));
      h.el.classList.toggle('live', h.seen);
      const pr = this.world.project(a.e, a.n, a.up + Math.min(2, h.p.size * 0.6));
      const onScreen = pr.visible && pr.x > 30 && pr.x < W - 30 && pr.y > 30 && pr.y < H - 30;
      const bearing = (Math.atan2(a.e - me.e, a.n - me.n) * 180) / Math.PI;
      const rel = ((bearing - hd + 540) % 360) - 180; // -180..180, + = to the right
      if (onScreen) {
        // world-locked: card sits up-right of the object, flips left near the right edge
        const right = pr.x + 26 + CARD_W < W - EDGE;
        const tx = right ? pr.x + 26 : pr.x - 26 - CARD_W;
        const ty = Math.max(EDGE + 60, Math.min(H - 170, pr.y - 96));
        this.place(h, tx, ty, dt);
        h.el.classList.remove('pinned');
        // leader line from the object to the card
        const cx = right ? h.x : h.x + CARD_W;
        const cy = h.y + 22;
        const dx = cx - pr.x;
        const dy = cy - pr.y;
        h.leader.style.width = `${Math.hypot(dx, dy).toFixed(0)}px`;
        h.leader.style.transform = `translate(${pr.x.toFixed(0)}px, ${pr.y.toFixed(0)}px) rotate(${Math.atan2(dy, dx)}rad)`;
        h.leader.style.opacity = '1';
        h.dot.style.transform = `translate(${pr.x.toFixed(0)}px, ${pr.y.toFixed(0)}px)`;
        h.dot.style.opacity = '1';
      } else {
        pinned.push({ h, side: rel >= 0 ? 1 : -1, rel });
        h.leader.style.opacity = '0';
        h.dot.style.opacity = '0';
      }
      const dirTxt = h.el.querySelector('.holo-dir .txt');
      const dirIc = h.el.querySelector<HTMLElement>('.holo-dir .ms');
      if (dirTxt && dirIc) {
        dirTxt.textContent = onScreen ? km(dist) : `${Math.abs(rel) > 150 ? 'Behind you' : `Turn ${Math.round(Math.abs(rel))}° ${rel > 0 ? 'right' : 'left'}`} · ${km(dist)}`;
        dirIc.style.transform = `rotate(${rel.toFixed(0)}deg)`;
      }
    }
    // tag-along: off-view cards stack on the visor edge on the side the object is
    let li = 0;
    let ri = 0;
    for (const { h, side } of pinned.sort((x, y) => Math.abs(x.rel) - Math.abs(y.rel))) {
      const i = side > 0 ? ri++ : li++;
      const tx = side > 0 ? W - CARD_W - EDGE - 40 : EDGE + 40;
      this.place(h, tx, H * 0.3 + i * 128, dt);
      h.el.classList.add('pinned');
      h.el.classList.toggle('left', side < 0);
    }
  }

  private place(h: Holo, tx: number, ty: number, dt: number) {
    if (!h.placed) {
      h.x = tx;
      h.y = ty;
      h.placed = true;
    } else {
      const k = Math.min(1, dt * 14);
      h.x += (tx - h.x) * k;
      h.y += (ty - h.y) * k;
    }
    h.el.style.transform = `translate(${h.x.toFixed(1)}px, ${h.y.toFixed(1)}px)`;
  }
}
