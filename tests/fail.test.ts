import { it, expect } from 'vitest';
import { mockJezeroProvider } from '../src/data/mockJezero';
import { Sim } from '../src/core/sim';
it('fails on O2 depletion', async () => {
  const sim = new Sim(await mockJezeroProvider.load());
  sim.start(false);
  sim.choose(0);
  sim.health.o2g = 0.5;
  for (let i = 0; i < 100 && sim.status === 'active'; i++) sim.update(0.1);
  console.log(sim.status, sim.failReason, sim.health.o2g);
  expect(sim.status).toBe('failed');
});
