import { it, expect } from 'vitest';
import { BANDS, enrol, verify, frameShape, correlation, type VoiceFrame } from '../src/ui/voiceprint';

/** synthetic voice: formant-like bumps at given band positions, plus a little noise */
function voice(formants: number[], pitch: number, n: number, seed = 1): VoiceFrame[] {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647 - 0.5);
  return Array.from({ length: n }, (_, k) => {
    const shape = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) shape[b] = formants.reduce((s, f) => s + 18 * Math.exp(-((b - f) ** 2) / 6), 0) - b * 0.6 + rnd() * 4;
    return { t: k * 30, shape, pitch: pitch * (1 + rnd() * 0.06) };
  });
}

it('accepts the enrolled voice and rejects a clearly different one', () => {
  const me = enrol(voice([4, 11, 17], 120, 20))!;
  expect(me).not.toBeNull();
  expect(verify(me, voice([4, 11, 17], 128, 30, 7)).accept).toBe(true);
  // different timbre and an octave higher (like a synthetic reply voice or another person)
  expect(verify(me, voice([8, 20], 240, 30, 3)).accept).toBe(false);
  // same timbre but much higher pitch
  expect(verify(me, voice([4, 11, 17], 260, 30, 5)).accept).toBe(false);
});

it('fails open when there is too little audio, and needs enough audio to enrol', () => {
  const me = enrol(voice([4, 11, 17], 120, 20))!;
  expect(verify(me, voice([8, 20], 240, 3)).accept).toBe(true);
  expect(enrol(voice([4, 11, 17], 120, 5))).toBeNull();
});

it('frame shape ignores loudness', () => {
  const quiet = new Float32Array(1024).map((_, i) => -90 - i * 0.02);
  const loud = quiet.map((v) => v + 30);
  expect(correlation(frameShape(quiet, 48000), frameShape(loud, 48000))).toBeCloseTo(1, 5);
});
