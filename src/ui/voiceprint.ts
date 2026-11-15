/**
 * VOICEPRINT: a light, in-browser check that a command sounds like the enrolled astronaut.
 *
 * Enrolment happens in the "Hi TEVAN" voice check. Each voiced 30 ms frame gives
 * - a spectral shape: log energy in 24 bands spaced on the mel scale (150–4000 Hz),
 *   with the frame's average removed so loudness doesn't matter (a coarse timbre,
 *   similar in spirit to MFCCs), and
 * - the pitch (fundamental frequency).
 * The voiceprint is the average shape plus the median pitch.
 *
 * A command is accepted when the frames heard while it was spoken match the shape
 * (correlation) and sit within a few semitones of the enrolled pitch.
 *
 * Honest limits: this is not security-grade speaker verification. It reliably tells
 * apart clearly different voices (TEVAN's synthetic voice, a much higher/lower
 * voice), but a similar voice can pass, and a different mic, headset or a very
 * noisy room can lower the match. When there is too little audio to judge, it
 * accepts (fail-open), and typed commands are never voice-checked.
 */
export const BANDS = 24;
const F_LO = 150;
const F_HI = 4000;

export interface VoiceFrame {
  t: number;
  shape: Float32Array;
  pitch: number | null;
}
export interface VoicePrint {
  shape: number[];
  pitchHz: number | null;
  frames: number;
}
export interface VoiceMatch {
  accept: boolean;
  /** 0..1 combined similarity */
  score: number;
  /** spectral-shape correlation -1..1 */
  timbre: number;
  /** pitch difference in semitones (null = no pitch) */
  semitones: number | null;
  /** frames that were compared */
  frames: number;
  reason: string;
}

/** thresholds (tuned conservatively so the user isn't locked out) */
export const MATCH = { minFrames: 6, minTimbre: 0.55, maxSemitones: 6, minScore: 0.5 };

const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const imel = (m: number) => 700 * (10 ** (m / 2595) - 1);

/** Band edges (Hz) of the mel-spaced filter bank. */
export function bandEdges(): number[] {
  const a = mel(F_LO);
  const b = mel(F_HI);
  return Array.from({ length: BANDS + 1 }, (_, i) => imel(a + ((b - a) * i) / BANDS));
}
const EDGES = bandEdges();

/**
 * Spectral shape of one frame from FFT magnitudes in dB (AnalyserNode.getFloatFrequencyData).
 * Returns mean-removed band energies (dB), so overall loudness cancels out.
 */
export function frameShape(freqDb: Float32Array, sampleRate: number): Float32Array {
  const binHz = sampleRate / 2 / freqDb.length;
  const out = new Float32Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const i0 = Math.max(1, Math.floor(EDGES[b] / binHz));
    const i1 = Math.max(i0 + 1, Math.ceil(EDGES[b + 1] / binHz));
    let sum = 0;
    let n = 0;
    for (let i = i0; i < i1 && i < freqDb.length; i++) {
      const v = freqDb[i];
      if (Number.isFinite(v)) {
        sum += Math.max(v, -140);
        n++;
      }
    }
    out[b] = n ? sum / n : -140;
  }
  let m = 0;
  for (let b = 0; b < BANDS; b++) m += out[b];
  m /= BANDS;
  for (let b = 0; b < BANDS; b++) out[b] -= m;
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
function meanShape(frames: VoiceFrame[]): number[] {
  const acc = new Array(BANDS).fill(0);
  for (const f of frames) for (let b = 0; b < BANDS; b++) acc[b] += f.shape[b];
  return acc.map((v) => v / frames.length);
}
/** Pearson correlation of two shapes. */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Build a voiceprint from the voiced frames of the enrolment phrase. */
export function enrol(frames: VoiceFrame[]): VoicePrint | null {
  if (frames.length < 8) return null;
  const pitches = frames.map((f) => f.pitch).filter((p): p is number => !!p);
  return { shape: meanShape(frames), pitchHz: pitches.length >= 4 ? median(pitches) : null, frames: frames.length };
}

/** Does this speech sound like the enrolled voice? */
export function verify(vp: VoicePrint, frames: VoiceFrame[]): VoiceMatch {
  if (frames.length < MATCH.minFrames) return { accept: true, score: 1, timbre: 1, semitones: null, frames: frames.length, reason: 'too little audio to judge (accepted)' };
  const timbre = correlation(vp.shape, meanShape(frames));
  const pitches = frames.map((f) => f.pitch).filter((p): p is number => !!p);
  const semitones = vp.pitchHz && pitches.length >= 3 ? 12 * Math.log2(median(pitches) / vp.pitchHz) : null;
  const pitchScore = semitones === null ? 0.7 : Math.max(0, 1 - Math.abs(semitones) / (MATCH.maxSemitones * 1.5));
  const score = Math.max(0, timbre) * 0.6 + pitchScore * 0.4;
  let reason = 'matches your voice';
  let accept = true;
  if (timbre < MATCH.minTimbre) {
    accept = false;
    reason = 'voice colour differs from yours';
  } else if (semitones !== null && Math.abs(semitones) > MATCH.maxSemitones) {
    accept = false;
    reason = `pitch is ${Math.abs(semitones).toFixed(0)} semitones ${semitones > 0 ? 'higher' : 'lower'} than yours`;
  } else if (score < MATCH.minScore) {
    accept = false;
    reason = 'does not sound like you';
  }
  return { accept, score, timbre, semitones, frames: frames.length, reason };
}
