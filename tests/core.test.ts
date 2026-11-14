import { describe, it, expect } from 'vitest';
import { mockJezeroProvider } from '../src/data/mockJezero';
import { Sim } from '../src/core/sim';
import { metabolicW } from '../src/core/health';

describe('core', async () => {
  const data = await mockJezeroProvider.load();
  it('edge metrics', () => {
    const sim = new Sim(data);
    for (const [id, g] of sim.world.edges) {
      const m = sim.world.metrics([{ edgeId: id, forward: true }]);
      const doses = g.samples.map(s=>s.doseBase);
      console.log(id, g.edge.name.padEnd(22), 'len', m.distance.toFixed(0), 'gain', m.gain.toFixed(0), 'loss', m.loss.toFixed(0), 'maxSlope', m.maxSlopeDeg.toFixed(1), 'min', (m.estTimeS/60).toFixed(1), 'dose', Math.min(...doses).toFixed(1), Math.max(...doses).toFixed(1));
    }
    console.log('met level', metabolicW(1,0,1.2).toFixed(0), 'uphill15', metabolicW(0.8,15,1.6).toFixed(0), 'rest', metabolicW(0,0,1).toFixed(0), 'sand', metabolicW(0.8,0,2.1).toFixed(0));
  });
  it('autoplay recommended', () => {
    const sim = new Sim(data);
    sim.start(false);
    let guard = 0;
    while (sim.status === 'active' && guard++ < 200000) {
      if (sim.incident) { sim.resolveIncident(sim.incident.def.options.findIndex(o=>o.recommended)); continue; }
      if (sim.advisory) { sim.acceptAdvisory(); }
      if (sim.samplePrompt && sim.waitS <= 0) sim.markSample();
      else if (sim.awaitingChoice && sim.waitS <= 0 && !sim.committed.length) sim.choose(0);
      sim.autopilot();
      sim.update(0.1);
    }
    console.log('status', sim.status, sim.failReason, 'met min', (sim.met/60).toFixed(0), 'dist', sim.stats.distance.toFixed(0));
    const h = sim.health;
    console.log('o2', (h.o2g/h.o2Cap*100).toFixed(0), 'water', (h.waterg/h.waterCap*100).toFixed(0), 'batt', (h.battWh/h.battCap*100).toFixed(0), 'dose', h.doseMSv.toFixed(2), 'fatigue', h.fatigue.toFixed(0), 'core', h.coreC.toFixed(2));
    for (const l of sim.log) console.log((l.met/60).toFixed(1).padStart(6), l.kind.padEnd(9), l.title, '|', l.decision ?? '', '|', l.outcome ?? '');
    expect(['success','aborted']).toContain(sim.status);
  });
  it('autoplay worst choices', () => {
    const sim = new Sim(data);
    sim.start(false);
    let guard = 0;
    while (sim.status === 'active' && guard++ < 200000) {
      if (sim.incident) { const o = sim.incident.def.options; sim.resolveIncident(o.length-1); continue; }
      if (sim.advisory) sim.dismissAdvisory();
      if (sim.samplePrompt && sim.waitS <= 0) sim.markSample();
      else if (sim.awaitingChoice && sim.waitS <= 0 && !sim.committed.length) {
        // pick the non-recommended forward option toward goal heuristically: highest score but not going back
        const c = [...sim.choices].filter(c=>c.forecast.distance < 6000).sort((a,b)=>b.score-a.score);
        sim.choose(sim.choices.indexOf(c[0] ?? sim.choices[0]));
      }
      sim.autopilot();
      sim.update(0.1);
    }
    console.log('WORST status', sim.status, sim.failReason, 'met min', (sim.met/60).toFixed(0));
    const h = sim.health;
    console.log('o2', (h.o2g/h.o2Cap*100).toFixed(0), 'dose', h.doseMSv.toFixed(2), 'fatigue', h.fatigue.toFixed(0));
    for (const l of sim.log) console.log((l.met/60).toFixed(1).padStart(6), l.kind.padEnd(9), l.title, '|', l.decision ?? '');
  });
});
