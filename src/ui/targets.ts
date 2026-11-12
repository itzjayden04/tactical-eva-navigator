/**
 * GAZE TARGETING: turns a noisy gaze point into a stable "feature under the
 * astronaut's eyes". Any visible element with `data-gaze="<id>"` is a target.
 *
 * - snap: nearest target within a generous radius (webcam gaze is coarse)
 * - hysteresis: a new target must win for DWELL_MS before it takes over
 * - memory: "launch this" uses the target that was locked while the person
 *   was speaking, even if their eyes moved by the time the phrase finished
 */
const SNAP_PX = 120;
const DWELL_MS = 160;
const MEMORY_MS = 2500;

export interface Locked {
  id: string;
  label: string;
  el: HTMLElement;
}

export class Targeting {
  current: Locked | null = null;
  private cand: { id: string; since: number } | null = null;
  private lastLocked: { t: Locked; at: number } | null = null;
  onLock: (t: Locked | null) => void = () => {};

  private visibleTargets(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[data-gaze]')].filter((el) => {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.05;
    });
  }

  /** Call every frame with the current gaze (or pointer) position. */
  update(pt: { x: number; y: number } | null, now = performance.now()) {
    let best: HTMLElement | null = null;
    if (pt) {
      let bestD = Infinity;
      const els = this.visibleTargets();
      // the island's own controls win over the island itself when both are under the eyes
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const dx = Math.max(r.left - pt.x, 0, pt.x - r.right);
        const dy = Math.max(r.top - pt.y, 0, pt.y - r.bottom);
        let d = Math.hypot(dx, dy);
        if (el.id === 'island' && els.some((o) => o !== el && el.contains(o))) d += 40;
        if (d < bestD) {
          bestD = d;
          best = el;
        }
      }
      if (bestD > SNAP_PX) best = null;
    }
    const id = best?.dataset.gaze ?? null;
    if (id === (this.current?.id ?? null)) {
      this.cand = null;
      if (best && this.current) this.current.el = best;
    } else if (!this.cand || this.cand.id !== (id ?? '')) this.cand = { id: id ?? '', since: now };
    else if (now - this.cand.since > (id ? DWELL_MS : DWELL_MS * 3)) {
      this.cand = null;
      this.current = best ? { id: id!, label: best.dataset.gazeLabel ?? id!, el: best } : null;
      if (this.current) this.lastLocked = { t: this.current, at: now };
      this.onLock(this.current);
    }
    if (this.current) this.lastLocked = { t: this.current, at: now };
    // highlight
    document.querySelectorAll('.gazed').forEach((e) => e !== this.current?.el && e.classList.remove('gazed'));
    this.current?.el.classList.add('gazed');
  }

  /** The feature the astronaut means by "this": current, or the one held moments ago. */
  resolve(now = performance.now()): Locked | null {
    if (this.current) return this.current;
    if (this.lastLocked && now - this.lastLocked.at < MEMORY_MS) return this.lastLocked.t;
    return null;
  }
}
