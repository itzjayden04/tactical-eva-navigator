import { it, expect } from 'vitest';
import { understand, yesNo, phonetic, RUN_AT } from '../src/ui/intent';

const run = (s: string) => {
  const u = understand([s]);
  return u && u.confidence >= RUN_AT ? u.cmd : null;
};

it('understands reworded and misheard commands by intent', () => {
  expect(run('so radiation')).toEqual({ type: 'layer', layer: 'radiation', on: true });
  expect(run('sure the radiation lair')).toEqual({ type: 'layer', layer: 'radiation', on: true });
  expect(run('i want to see the slope')).toEqual({ type: 'layer', layer: 'slope', on: true });
  expect(run('show me steep areas')).toEqual({ type: 'layer', layer: 'slope', on: true });
  expect(run('turn of fog')).toEqual({ type: 'layer', layer: 'fog', on: false });
  expect(run('how much oxy gen left')).toEqual({ type: 'progress', feature: 'o2' });
  expect(run('batry level')).toEqual({ type: 'progress', feature: 'power' });
  expect(run('how much radiation did i get')).toEqual({ type: 'progress', feature: 'dose' });
  expect(run('send the drawn out')).toEqual({ type: 'drone', action: 'launch' });
  expect(run('come back drone')).toEqual({ type: 'drone', action: 'recall' });
  expect(run('we route')).toEqual({ type: 'reroute' });
  expect(run('find me a better way')).toEqual({ type: 'reroute' });
  expect(run('am i okay')).toEqual({ type: 'vitals' });
  expect(run('colect simple here')).toEqual({ type: 'sample' });
  expect(run('bring me to base')).toEqual({ type: 'emergency', action: 'habitat' });
  expect(run('take pitcher')).toEqual({ type: 'photo' });
  expect(run('i am lost')).toEqual({ type: 'where' });
});

it('exact grammar still wins and small talk is ignored', () => {
  expect(understand(['toggle radiation'])?.via).toBe('grammar');
  expect(understand(['the rocks look red'])).toBeNull();
  expect(understand(['i like pizza'])).toBeNull();
  expect(understand(['hello there'])).toBeNull();
  // weather mentioned in conversation: asks instead of acting
  const w = understand(['nice weather today']);
  expect(w && w.confidence < RUN_AT).toBe(true);
});

it('uses the best recogniser alternative', () => {
  const u = understand(['i like pizza', 'show the dust layer']);
  expect(u?.cmd).toEqual({ type: 'layer', layer: 'dust', on: true });
});

it('yes/no answers and phonetic codes', () => {
  expect(yesNo('yeah do it')).toBe('yes');
  expect(yesNo('no thanks')).toBe('no');
  expect(yesNo('show radiation')).toBeNull();
  expect(phonetic('route')).toBe(phonetic('root'));
  expect(phonetic('drone')).toBe(phonetic('drawn'));
});

it('voice lock and voice check commands', async () => {
  const { parseCommand } = await import('../src/ui/voice');
  expect(parseCommand('voice lock off')).toEqual({ type: 'voiceLock', on: false });
  expect(parseCommand('turn on voice lock')).toEqual({ type: 'voiceLock', on: true });
  expect(parseCommand('voice check')).toEqual({ type: 'calibrate', what: 'voice' });
});

it('"open emergency" opens the panel; only distress phrases send a mayday', () => {
  for (const s of ['open emergency', 'open the emergency panel', 'show emergency', 'emergency menu', 'open sos'])
    expect(understand([s])?.cmd).toEqual({ type: 'tool', tool: 'emergency' });
  for (const s of ['mayday', 'help me', 'i need help', 'call for help', 'send help'])
    expect(understand([s])?.cmd).toEqual({ type: 'emergency', action: 'help' });
  // a mayday guessed from loose wording is always confirmed first
  const g = understand(['im in trouble out here']);
  if (g?.cmd.type === 'emergency') expect(g.confidence).toBeLessThan(RUN_AT);
});
