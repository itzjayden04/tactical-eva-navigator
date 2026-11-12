/**
 * Forecast chart: actual history (solid) + forecast along route (dashed).
 * Changing the route changes the dashed lines — the route/health coupling.
 */
import type { ForecastResult } from '../core/forecast';
import type { HistoryPoint } from '../core/sim';
import { FATIGUE_REROUTE, RESERVE_FRAC } from '../core/health';

export interface ChartInput {
  met: number;
  history: HistoryPoint[];
  now: { o2: number; fatigue: number; batt: number; dose: number };
  forecast?: ForecastResult | null;
  alt?: ForecastResult | null;
  planner?: ForecastResult | null;
  large?: boolean;
}

const COL = { o2: '#39d0ff', fatigue: '#ffb020', batt: '#3ce39a', dose: '#ff7ad9' };

export function drawChart(canvas: HTMLCanvasElement, inp: ChartInput) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (!cw || !ch) return;
  if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
  if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const L = 28;
  const R = 34;
  const T = 16;
  const B = 16;
  const w = cw - L - R;
  const h = ch - T - B;
  const fEnd = Math.max(inp.forecast?.timeS ?? 0, inp.alt?.timeS ?? 0, inp.planner?.timeS ?? 0);
  const t0 = 0;
  const t1 = Math.max(inp.met + fEnd, inp.met + 600, 3600);
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * w;
  const y = (v: number) => T + h - (v / 100) * h;
  const maxDose = Math.max(1, inp.now.dose * 1.3, (inp.forecast?.end.doseMSv ?? 0) * 1.2, (inp.alt?.end.doseMSv ?? 0) * 1.2);
  const yd = (v: number) => T + h - (v / maxDose) * h;
  // grid
  ctx.strokeStyle = 'rgba(120,220,255,0.12)';
  ctx.lineWidth = 1;
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(127,163,179,0.9)';
  for (let v = 0; v <= 100; v += 25) {
    ctx.beginPath();
    ctx.moveTo(L, y(v));
    ctx.lineTo(L + w, y(v));
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(String(v), L - 4, y(v) + 3);
  }
  ctx.textAlign = 'left';
  ctx.fillText(`${maxDose.toFixed(1)} mSv`, L + w + 3, T + 3);
  const hours = t1 / 3600;
  const stepH = hours > 4 ? 1 : 0.5;
  for (let hh = 0; hh <= hours; hh += stepH) {
    ctx.fillText(`${hh}h`, x(hh * 3600) - 6, T + h + 12);
  }
  // thresholds
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = 'rgba(255,77,77,0.8)';
  ctx.beginPath();
  ctx.moveTo(L, y(RESERVE_FRAC * 100));
  ctx.lineTo(L + w, y(RESERVE_FRAC * 100));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,176,32,0.8)';
  ctx.beginPath();
  ctx.moveTo(L, y(FATIGUE_REROUTE));
  ctx.lineTo(L + w, y(FATIGUE_REROUTE));
  ctx.stroke();
  ctx.setLineDash([]);
  // now line
  ctx.strokeStyle = 'rgba(207,246,255,0.35)';
  ctx.beginPath();
  ctx.moveTo(x(inp.met), T);
  ctx.lineTo(x(inp.met), T + h);
  ctx.stroke();

  const series = (pts: { t: number; v: number }[], color: string, dash: number[], width = 1.6, yy = y) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), yy(p.v)) : ctx.moveTo(x(p.t), yy(p.v))));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const hist = [...inp.history, { met: inp.met, o2: inp.now.o2, fatigue: inp.now.fatigue, batt: inp.now.batt, dose: inp.now.dose } as HistoryPoint];
  series(hist.map((p) => ({ t: p.met, v: p.o2 * 100 })), COL.o2, []);
  series(hist.map((p) => ({ t: p.met, v: p.fatigue })), COL.fatigue, []);
  series(hist.map((p) => ({ t: p.met, v: p.batt * 100 })), COL.batt, []);
  series(hist.map((p) => ({ t: p.met, v: p.dose })), COL.dose, [], 1.2, yd);
  const fc = (f: ForecastResult | null | undefined, alpha: number, dash: number[], tint?: string) => {
    if (!f) return;
    const pts = f.points;
    series(pts.map((p) => ({ t: inp.met + p.t, v: p.o2 * 100 })), tint ?? COL.o2, dash, 1.4);
    series(pts.map((p) => ({ t: inp.met + p.t, v: p.fatigue })), tint ?? COL.fatigue, dash, 1.4);
    if (!tint) {
      series(pts.map((p) => ({ t: inp.met + p.t, v: p.batt * 100 })), COL.batt, dash, 1.2);
      series(pts.map((p) => ({ t: inp.met + p.t, v: p.dose })), COL.dose, dash, 1.1, yd);
    }
    void alpha;
  };
  fc(inp.forecast, 1, [5, 4]);
  fc(inp.alt, 1, [2, 3], '#ffb020');
  fc(inp.planner, 1, [1, 3], '#ffffff');
  // legend
  const items: [string, string][] = [
    ['O2', COL.o2],
    ['FATIGUE', COL.fatigue],
    ['BATT', COL.batt],
    ['DOSE', COL.dose],
  ];
  let lx = L + 2;
  ctx.font = '9px JetBrains Mono, monospace';
  for (const [name, c] of items) {
    ctx.fillStyle = c;
    ctx.fillRect(lx, 4, 8, 3);
    ctx.fillStyle = 'rgba(207,246,255,0.85)';
    ctx.fillText(name, lx + 11, 9);
    lx += ctx.measureText(name).width + 22;
  }
  ctx.fillStyle = 'rgba(127,163,179,0.9)';
  ctx.fillText(inp.alt ? '- - forecast  ··· alternate' : inp.planner ? '- - forecast  ··· planned' : '- - forecast', lx + 4, 9);
}
