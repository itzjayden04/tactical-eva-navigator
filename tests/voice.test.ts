import { it, expect } from 'vitest';
import { parseCommand } from '../src/ui/voice';

const t = (s: string) => parseCommand(s);

it('parses the TEVAN voice grammar', () => {
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
  expect(t('recall the drone')).toEqual({ type: 'drone', action: 'recall' });
  expect(t('option two')).toEqual({ type: 'option', n: 2 });
  expect(t('take route one')).toEqual({ type: 'option', n: 1 });
  expect(t('zoom in')).toEqual({ type: 'zoom', dir: 'in' });
  expect(t('reset zoom')).toEqual({ type: 'zoom', dir: 'reset' });
  expect(t('open map')).toEqual({ type: 'launch', feature: 'map' });
  expect(t('what can I say')).toEqual({ type: 'help' });
  expect(t('nice weather today')).toBeNull();
  expect(t('the rocks look red')).toBeNull();
});

it('wake word', () => {
  expect(t('Hi Tevan')).toEqual({ type: 'hello' });
  expect(t('hey Kevin, show radiation')).toEqual({ type: 'layer', layer: 'radiation', on: true });
  expect(t('TEVAN what is this')).toEqual({ type: 'whatThis' });
  expect(parseCommand('hi stephan vitals', ['stephan'])).toEqual({ type: 'vitals' });
});

it('emergencies', () => {
  expect(t('mayday')).toEqual({ type: 'emergency', action: 'help' });
  expect(t('call for help')).toEqual({ type: 'emergency', action: 'help' });
  expect(t('I need help')).toEqual({ type: 'emergency', action: 'help' });
  expect(t('back to habitat')).toEqual({ type: 'emergency', action: 'habitat' });
  expect(t('take me home')).toEqual({ type: 'emergency', action: 'habitat' });
  expect(t('nearest shelter')).toEqual({ type: 'emergency', action: 'shelter' });
  expect(t('rest')).toEqual({ type: 'emergency', action: 'rest' });
  expect(t('go to the nearest cache')).toEqual({ type: 'emergency', action: 'cache' });
  expect(t('resupply')).toEqual({ type: 'emergency', action: 'resupply' });
  expect(t('resume mission')).toEqual({ type: 'emergency', action: 'resume' });
  expect(t('cancel navigation')).toEqual({ type: 'emergency', action: 'cancelNav' });
  expect(t('emergency')).toEqual({ type: 'tool', tool: 'emergency' });
  expect(t('stability on')).toEqual({ type: 'stability', on: true });
  expect(t('turn off stability assist')).toEqual({ type: 'stability', on: false });
});

it('tags and what-is-this', () => {
  expect(t("what's this")).toEqual({ type: 'whatThis' });
  expect(t('what is that')).toEqual({ type: 'whatThis' });
  expect(t('what am I looking at')).toEqual({ type: 'whatThis' });
  expect(t('label this')).toEqual({ type: 'labelThis', kind: undefined });
  expect(t('label this as a hazard')).toEqual({ type: 'labelThis', kind: 'hazard' });
  expect(t('tag that as my teammate')).toEqual({ type: 'labelThis', kind: 'teammate' });
  expect(t('mark this as destination')).toEqual({ type: 'labelThis', kind: 'destination' });
  expect(t('hazard')).toEqual({ type: 'tagKind', kind: 'hazard' });
  expect(t("it's a teammate")).toEqual({ type: 'tagKind', kind: 'teammate' });
  expect(t('remove the last tag')).toEqual({ type: 'removeTag' });
  expect(t('go to tag')).toEqual({ type: 'goTag', kind: undefined });
  expect(t('take me there')).toEqual({ type: 'goTag', kind: undefined });
  expect(t('navigate to the hazard tag')).toEqual({ type: 'goTag', kind: 'hazard' });
  expect(t('take me to my teammate')).toEqual({ type: 'goTeammate' });
  expect(t('where is my teammate')).toEqual({ type: 'tool', tool: 'team' });
});

it('tools, log, repeat, undo', () => {
  expect(t('show log')).toEqual({ type: 'logPanel', open: true });
  expect(t('close the log')).toEqual({ type: 'logPanel', open: false });
  expect(t('team status')).toEqual({ type: 'tool', tool: 'team' });
  expect(t('show supplies')).toEqual({ type: 'tool', tool: 'supplies' });
  expect(t('how is the weather')).toEqual({ type: 'tool', tool: 'weather' });
  expect(t('system status')).toEqual({ type: 'tool', tool: 'systems' });
  expect(t('weather')).toEqual({ type: 'tool', tool: 'weather' });
  expect(t('show rover images')).toEqual({ type: 'tool', tool: 'rover' });
  expect(t('latest perseverance photos')).toEqual({ type: 'tool', tool: 'rover' });
  expect(t('rover feed')).toEqual({ type: 'tool', tool: 'rover' });
  expect(t('show rover layer')).toEqual({ type: 'layer', layer: 'rover', on: true });
  expect(t('show tags')).toEqual({ type: 'tool', tool: 'tags' });
  expect(t('tools')).toEqual({ type: 'tool', tool: 'tools' });
  expect(t('take a photo')).toEqual({ type: 'photo' });
  expect(t('repeat that')).toEqual({ type: 'repeat' });
  expect(t('undo')).toEqual({ type: 'undo' });
  expect(t('jump')).toEqual({ type: 'jump' });
  expect(t('where am I')).toEqual({ type: 'where' });
});
