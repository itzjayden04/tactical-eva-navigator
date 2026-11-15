import { it, expect } from 'vitest';
import { align, learnSentence, applyAccent, expand, recall, remember, emptyProfile } from '../src/ui/accent';
import { understand } from '../src/ui/intent';

it('aligns heard words with the sentence that was read', () => {
  const ops = align(['open', 'the', 'mop'], ['open', 'the', 'map']);
  expect(ops.map((o) => o.kind)).toEqual(['same', 'same', 'sub']);
  const merge = align(['check', 'oxy', 'gin', 'level'], ['check', 'oxygen', 'level']);
  expect(merge.find((o) => o.kind === 'sub')).toEqual({ kind: 'sub', heard: ['oxy', 'gin'], meant: ['oxygen'] });
});

it('learns an accent from calibration sentences and applies it to new commands', () => {
  const p = emptyProfile();
  expect(learnSentence(p, 'Open the map', ['open the mop'])).toEqual([['mop', 'map']]);
  expect(learnSentence(p, 'Check oxygen level', ['check oxy gin level'])).toEqual([['oxy gin', 'oxygen']]);
  learnSentence(p, 'Open emergency', ['open emergence']);
  expect(applyAccent(p, 'how much oxy gin do I have')).toBe('how much oxygen do i have');
  // a different command than the ones read, still corrected
  expect(expand(p, ['close the mop'])[0]).toBe('close the map');
  expect(understand(expand(p, ['open mop']))?.cmd).toEqual({ type: 'launch', feature: 'map' });
  expect(understand(expand(p, ['open emergence']))?.cmd).toEqual({ type: 'tool', tool: 'emergency' });
});

it('does not learn from unrelated speech or remap common words', () => {
  const p = emptyProfile();
  expect(learnSentence(p, 'Open the map', ['banana smoothie'])).toEqual([]);
  learnSentence(p, 'Open the map', ['open a map']);
  expect(p.words['a']).toBeUndefined();
});

it('remembers confirmed phrases but never fast-paths a mayday', () => {
  const p = emptyProfile();
  remember(p, 'shoo me the rocks', { type: 'tool', tool: 'emergency' } as never);
  expect(recall(p, ['Shoo me the rocks'])).toEqual({ type: 'tool', tool: 'emergency' });
  remember(p, 'may die', { type: 'emergency', action: 'help' } as never);
  expect(recall(p, ['may die'])).toBeNull();
});

it('every calibration phrase is a real command', async () => {
  const { parseCommand } = await import('../src/ui/voice');
  for (const s of ['Open the map', 'Check oxygen level', 'Open emergency', 'Label this as a hazard', 'Show radiation dose']) expect(parseCommand(s), s).not.toBeNull();
});
