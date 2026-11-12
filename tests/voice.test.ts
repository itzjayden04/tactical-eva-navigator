import { it, expect } from 'vitest';
import { parseCommand } from '../src/ui/voice';

it('parses the TEVAN voice grammar', () => {
  const t = (s: string) => parseCommand(s);
  expect(t('launch this feature')).toEqual({ type: 'launchThis' });
  expect(t('Lunch this feature')).toEqual({ type: 'launchThis' });
  expect(t("check this feature's progress")).toEqual({ type: 'progressThis' });
  expect(t('toggle radiation')).toEqual({ type: 'layer', layer: 'radiation', on: undefined });
  expect(t('hide the slope layer')).toEqual({ type: 'layer', layer: 'slope', on: false });
  expect(t('reroute')).toEqual({ type: 'reroute' });
  expect(t('accept reroute')).toEqual({ type: 'accept' });
  expect(t('mark sample')).toEqual({ type: 'sample' });
  expect(t('vitals')).toEqual({ type: 'vitals' });
  expect(t('check oxygen')).toEqual({ type: 'progress', feature: 'o2' });
  expect(t('launch drone')).toEqual({ type: 'drone', action: 'launch' });
  expect(t('option two')).toEqual({ type: 'option', n: 2 });
  expect(t('take route one')).toEqual({ type: 'option', n: 1 });
  expect(t('zoom in')).toEqual({ type: 'zoom', dir: 'in' });
  expect(t('open map')).toEqual({ type: 'launch', feature: 'map' });
  expect(t('nice weather today')).toBeNull();
});
