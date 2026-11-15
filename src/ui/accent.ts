/**
 * ACCENT PROFILE: how the browser's recogniser hears THIS astronaut.
 *
 * TEVAN does not judge who is speaking (no pitch or voiceprint gate). It adapts
 * to how the person pronounces things instead:
 *
 * 1. Calibration. In the voice check the astronaut reads a few short commands.
 *    Each heard sentence is aligned word by word with the sentence they were
 *    asked to read, and every word the recogniser got "wrong" for this accent is
 *    learned as a substitution: "oxy gin" → "oxygen", "mop" → "map", "emergence"
 *    → "emergency". Two-to-one and one-to-two splits are learned too.
 * 2. Learning while working. When TEVAN asks "Did you mean …?" and the astronaut
 *    says yes, the exact heard phrase is remembered with its command, so the
 *    next time it runs straight away without asking.
 *
 * Commands are always read with the learned spellings applied first, then the
 * grammar and the meaning-based matcher (intent.ts) do the rest. The profile is
 * stored in this browser only (localStorage) and "forget my accent" clears it.
 */
import { normalise, type Command } from './voice';

export interface AccentProfile {
  /** heard word(s) → meant word(s), e.g. { "mop": "map", "oxy gin": "oxygen" } */
  words: Record<string, string>;
  /** a whole heard phrase that the astronaut confirmed → its command */
  phrases: Record<string, Command>;
  /** calibration sentences read so far */
  samples: number;
}

const KEY = 'tevan.accent.v1';
const MAX_PHRASES = 80;

/** words too short or too common to remap safely */
const KEEP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'it', 'is', 'my', 'me', 'i', 'and', 'or', 'this', 'that', 'yes', 'no', 'not', 'off', 'up', 'out']);

export const emptyProfile = (): AccentProfile => ({ words: {}, phrases: {}, samples: 0 });

type Op = { kind: 'same' | 'sub' | 'del' | 'ins'; heard: string[]; meant: string[] };

/** Word-level alignment (edit distance with 2:1 and 1:2 merges). */
export function align(heard: string[], meant: string[]): Op[] {
  const H = heard.length;
  const M = meant.length;
  const INF = 1e9;
  const cost: number[][] = Array.from({ length: H + 1 }, () => new Array(M + 1).fill(INF));
  const back: [number, number, Op['kind']][][] = Array.from({ length: H + 1 }, () => new Array(M + 1));
  cost[0][0] = 0;
  const sim = (a: string, b: string) => (a === b ? 0 : 1);
  for (let i = 0; i <= H; i++) {
    for (let j = 0; j <= M; j++) {
      const c = cost[i][j];
      if (c >= INF) continue;
      const relax = (ni: number, nj: number, add: number, kind: Op['kind']) => {
        if (ni > H || nj > M) return;
        if (c + add < cost[ni][nj]) {
          cost[ni][nj] = c + add;
          back[ni][nj] = [i, j, kind];
        }
      };
      if (i < H && j < M) relax(i + 1, j + 1, sim(heard[i], meant[j]), heard[i] === meant[j] ? 'same' : 'sub');
      relax(i + 2, j + 1, 1.2, 'sub'); // "oxy gin" → "oxygen"
      relax(i + 1, j + 2, 1.2, 'sub'); // "mayday" → "may day"
      relax(i + 1, j, 1, 'del'); // extra heard word
      relax(i, j + 1, 1, 'ins'); // missed word
    }
  }
  const ops: Op[] = [];
  let i = H;
  let j = M;
  while (i > 0 || j > 0) {
    const [pi, pj, kind] = back[i][j];
    ops.unshift({ kind, heard: heard.slice(pi, i), meant: meant.slice(pj, j) });
    i = pi;
    j = pj;
  }
  return ops;
}

/** Learn what this accent turns `meant` into. Returns the substitutions learned. */
export function learnSentence(p: AccentProfile, meant: string, heardAlts: string[]): [string, string][] {
  const m = normalise(meant).split(' ').filter(Boolean);
  const learned: [string, string][] = [];
  // the top guess carries most weight; only it teaches substitutions
  const h = normalise(heardAlts[0] ?? '').split(' ').filter(Boolean);
  if (!h.length || !m.length) return learned;
  const ops = align(h, m);
  // a sentence that came back mostly unrelated (wrong thing said, noise) teaches nothing
  const same = ops.filter((o) => o.kind === 'same').length;
  if (same === 0 && m.length > 1) return learned;
  for (const o of ops) {
    if (o.kind !== 'sub') continue;
    const from = o.heard.join(' ');
    const to = o.meant.join(' ');
    if (!from || from === to || (o.heard.length === 1 && KEEP.has(from))) continue;
    p.words[from] = to;
    learned.push([from, to]);
  }
  p.samples++;
  return learned;
}

/** Rewrite a heard sentence with the learned spellings (longest match first). */
export function applyAccent(p: AccentProfile, text: string): string {
  const keys = Object.keys(p.words);
  if (!keys.length) return text;
  const w = normalise(text).split(' ').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < w.length; ) {
    const two = i + 1 < w.length ? `${w[i]} ${w[i + 1]}` : '';
    if (two && p.words[two]) {
      out.push(p.words[two]);
      i += 2;
    } else {
      out.push(p.words[w[i]] ?? w[i]);
      i++;
    }
  }
  return out.join(' ');
}

/** The recogniser's alternatives, with accent-corrected versions tried first. */
export function expand(p: AccentProfile, alts: string[]): string[] {
  const out: string[] = [];
  for (const a of alts) {
    const fixed = applyAccent(p, a);
    if (fixed && fixed !== normalise(a)) out.push(fixed);
  }
  for (const a of alts) out.push(a);
  return [...new Set(out)];
}

/** A phrase the astronaut confirmed earlier ("Did you mean …?" → yes). */
export function recall(p: AccentProfile, alts: string[]): Command | null {
  for (const a of alts) {
    const c = p.phrases[normalise(a)];
    if (c) return c;
  }
  return null;
}

export function remember(p: AccentProfile, heard: string, cmd: Command) {
  const k = normalise(heard);
  if (!k || cmd.type === 'emergency') return; // never fast-path a distress call from a guess
  delete p.phrases[k];
  p.phrases[k] = cmd;
  const ks = Object.keys(p.phrases);
  if (ks.length > MAX_PHRASES) delete p.phrases[ks[0]];
}

export function loadProfile(): AccentProfile {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return { ...emptyProfile(), ...JSON.parse(s) };
  } catch {
    /* private window or blocked storage: start fresh */
  }
  return emptyProfile();
}

export function saveProfile(p: AccentProfile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* not persisted; still works for this session */
  }
}

export function clearProfile(p: AccentProfile) {
  p.words = {};
  p.phrases = {};
  p.samples = 0;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
