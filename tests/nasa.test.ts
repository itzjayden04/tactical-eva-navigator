import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { staticGridProvider } from '../src/data/staticGrid';
import { toLatLon } from '../src/data/types';
import { Sim } from '../src/core/sim';
import { Guardian } from '../src/core/guardian';

// serve public/ from disk the way the browser would
vi.stubGlobal('fetch', async (url: string) => {
  const path = 'public/' + url.replace(/^\.?\//, '');
  const buf = readFileSync(path);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
});

describe('real NASA Jezero dataset', async () => {
  const data = await staticGridProvider('nasa-jezero').load();

  it('loads HiRISE terrain, imagery and the Perseverance traverse', () => {
    expect(data.source).toBe('nasa');
    expect(data.elevation.width).toBe(513);
    const el = data.elevation.data.reduce((a, v) => [Math.min(a[0], v), Math.max(a[1], v)], [Infinity, -Infinity]);
    expect(el[0]).toBeGreaterThan(-2620);
    expect(el[1]).toBeLessThan(-2400);
    expect(data.imagery?.url).toContain('ortho.jpg');
    expect(data.traverse!.points.length).toBeGreaterThan(100);
    expect(data.traverse!.waypoints.some((w) => w.pano)).toBe(true);
    expect(data.mission.edges.map((e) => e.id)).toEqual(expect.arrayContaining(['E1', 'E8', 'E9', 'E10', 'E12']));
    expect(data.mission.incidents.find((i) => i.id === 'foot-slip')!.title).toMatch(/SÉÍTAH/);
  });

  it('georeferences the habitat at the Octavia E. Butler landing site', () => {
    const hab = data.mission.nodes.find((n) => n.id === 'HAB')!;
    const ll = toLatLon(data.geo!, hab.e, hab.n);
    expect(ll.lat).toBeCloseTo(18.4446, 3);
    expect(ll.lon).toBeCloseTo(77.4509, 3);
  });

  it('runs the full EVA on the real terrain', () => {
    const sim = new Sim(data);
    const g = new Guardian(sim);
    sim.start(false);
    let guard = 0;
    while (sim.status === 'active' && guard++ < 250000) {
      if (sim.incident) {
        sim.resolveIncident(sim.incident.def.options.findIndex((o) => o.recommended));
        continue;
      }
      if (sim.advisory) sim.acceptAdvisory();
      if (sim.samplePrompt && sim.waitS <= 0) sim.markSample();
      else if (sim.awaitingChoice && sim.waitS <= 0 && !sim.committed.length) sim.choose(0);
      sim.autopilot();
      sim.update(0.1);
      g.update(0.1);
    }
    const h = sim.health;
    console.log('NASA run:', sim.status, sim.failReason ?? '', 'met', (sim.met / 60).toFixed(0), 'min, dist', sim.stats.distance.toFixed(0), 'm, o2', ((h.o2g / h.o2Cap) * 100).toFixed(0), '% batt', ((h.battWh / h.battCap) * 100).toFixed(0), '% falls', sim.stats2.falls, 'stumbles', sim.stats2.stumbles);
    for (const l of sim.log) console.log((l.met / 60).toFixed(1).padStart(6), l.kind.padEnd(9), l.title, '|', l.decision ?? '', '|', l.outcome ?? '');
    expect(['success', 'aborted']).toContain(sim.status);
  });
});
