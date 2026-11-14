import { describe, it, expect } from 'vitest';
import { mockJezeroProvider } from '../src/data/mockJezero';
import { Sim } from '../src/core/sim';
import { Guardian } from '../src/core/guardian';

describe('guardian', async () => {
  const data = await mockJezeroProvider.load();
  const run = (pick: (sim: Sim) => number) => {
    const sim = new Sim(data);
    const g = new Guardian(sim);
    const said: string[] = [];
    sim.on('say', (s: { text: string }) => said.push(s.text));
    sim.start(false);
    let guard = 0;
    while (sim.status === 'active' && guard++ < 250000) {
      if (sim.incident) {
        sim.resolveIncident(pick(sim));
        continue;
      }
      if (sim.advisory) sim.acceptAdvisory();
      if (sim.samplePrompt && sim.waitS <= 0) sim.markSample();
      else if (sim.awaitingChoice && sim.waitS <= 0 && !sim.committed.length) sim.choose(0);
      sim.autopilot();
      sim.update(0.1);
      g.update(0.1);
    }
    return { sim, g, said };
  };

  it('full mission with storm, marsquake reroute and resupply', () => {
    const { sim, g, said } = run((s) => s.incident!.def.options.findIndex((o) => o.recommended));
    const h = sim.health;
    console.log('status', sim.status, sim.failReason, 'met', (sim.met / 60).toFixed(0), 'dist', sim.stats.distance.toFixed(0), 'o2', ((h.o2g / h.o2Cap) * 100).toFixed(0), 'batt', ((h.battWh / h.battCap) * 100).toFixed(0), 'falls', sim.stats2.falls, 'stumbles', sim.stats2.stumbles);
    for (const l of sim.log) console.log((l.met / 60).toFixed(1).padStart(6), l.kind.padEnd(9), l.title, '|', l.decision ?? '', '|', l.outcome ?? '');
    console.log(said.join('\n'));
    const titles = sim.log.map((l) => l.title).join('\n');
    expect(titles).toContain('DUST STORM FRONT INBOUND');
    expect(titles).toContain('MARSQUAKE');
    expect(sim.world.blocked.size).toBe(1);
    expect(['success', 'aborted']).toContain(sim.status);
    expect(g.comms.length).toBeGreaterThan(0);
  });

  it('tags, describe, mayday, undo', () => {
    const sim = new Sim(data);
    const g = new Guardian(sim);
    sim.start(false);
    const p = sim.position();
    const t = g.addTag('hazard', { type: 'ground', name: 'ground', e: p.e + 30, n: p.n, up: 0, dist: 30, size: 1 });
    expect(t.label).toBe('Hazard 1');
    const ev = g.entity('ev2')!;
    const t2 = g.addTag('teammate', { type: 'entity', id: 'ev2', name: 'EV-2', e: ev.e, n: ev.n, up: 1, dist: 50, size: 1 });
    for (let i = 0; i < 50; i++) g.update(0.1);
    expect(g.tagPos(t2).e).toBe(ev.e);
    expect(g.describe({ type: 'ground', name: 'ground', e: p.e + 30, n: p.n, up: 0, dist: 30, size: 1 }).speech).toMatch(/Slope/);
    expect(g.undo()).toMatch(/Undone/);
    expect(g.tags.length).toBe(1);
    expect(g.callHelp()).toMatch(/Mayday sent/);
    expect(g.callHelp()).toMatch(/already/);
    expect(g.goToCache()).toMatch(/Guiding you to Supply Cache/);
    expect(sim.guide.length).toBeGreaterThan(2);
    expect(g.backToHabitat()).toMatch(/Returning to habitat/);
  });
});
