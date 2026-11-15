/**
 * INTENT RECOGNITION: understands what the astronaut MEANS, not just the exact phrase.
 *
 * The strict grammar in voice.ts is precise but brittle: an accent, a reworded
 * request or one misheard word ("so radiation", "how's my air", "send the drawn
 * out") falls through. This module is the safety net. It runs fully in the
 * browser (no API key, no network), and is deterministic.
 *
 *   1. Normalise the transcript and strip the wake word.
 *   2. Map every word or phrase to a CONCEPT (oxygen, show, layer, drone…) using
 *      a synonym lexicon. Words the recogniser misheard are rescued with
 *      phonetic keys (a Metaphone-style sound code, so "lair" ≈ "layer",
 *      "rote" ≈ "route") and Jaro-Winkler spelling similarity.
 *   3. Score the concept bag against example utterances of every intent with an
 *      IDF-weighted cosine: rare, specific concepts (drone, oxygen) count for
 *      more than common ones (show, my). Words that mean nothing to TEVAN lower
 *      the score, so small talk is not mistaken for a command.
 *   4. Fill slots (which layer, which consumable, on/off) and return the command
 *      with a confidence. High confidence runs; medium asks "Did you mean …?".
 *
 * Several recogniser alternatives can be scored at once; the best one wins.
 */
import { normalise, parseCommand, stripWake, type Command, type FeatureId, type LayerWord, type TagWord } from './voice';

// ------------------------------------------------------------------ string similarity

/** Metaphone-style sound code: words that sound alike get the same key ("route"/"root"/"rout" → RT). */
export function phonetic(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w.replace(/^(kn|gn|pn|wr|ae)/, (m) => m[1]).replace(/^x/, 's').replace(/^wh/, 'w');
  const V = 'aeiou';
  const isV = (c?: string) => !!c && V.includes(c);
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const n = w[i + 1];
    const p = w[i - 1];
    if (c === p && c !== 'c') continue;
    let k = '';
    switch (c) {
      case 'a': case 'e': case 'i': case 'o': case 'u':
        k = i === 0 ? 'A' : '';
        break;
      case 'b':
        k = p === 'm' && i === w.length - 1 ? '' : 'B';
        break;
      case 'c':
        if (n === 'h' || (n === 'i' && w[i + 2] === 'a')) k = 'X';
        else if (n === 'i' || n === 'e' || n === 'y') k = 'S';
        else k = 'K';
        break;
      case 'd':
        k = n === 'g' && 'eiy'.includes(w[i + 2] ?? '') ? 'J' : 'T';
        break;
      case 'g':
        if (n === 'h' && !isV(w[i + 2])) k = '';
        else if (n === 'n' && i + 2 >= w.length) k = '';
        else if (n === 'e' || n === 'i' || n === 'y') k = 'J';
        else k = 'K';
        break;
      case 'h':
        k = (isV(p) && !isV(n)) || 'cspgt'.includes(p ?? '_') ? '' : 'H';
        break;
      case 'k':
        k = p === 'c' ? '' : 'K';
        break;
      case 'p':
        k = n === 'h' ? 'F' : 'P';
        break;
      case 'q':
        k = 'K';
        break;
      case 's':
        k = n === 'h' || (n === 'i' && (w[i + 2] === 'o' || w[i + 2] === 'a')) ? 'X' : 'S';
        break;
      case 't':
        if (n === 'i' && (w[i + 2] === 'o' || w[i + 2] === 'a')) k = 'X';
        else if (n === 'h') k = '0';
        else if (n === 'c' && w[i + 2] === 'h') k = '';
        else k = 'T';
        break;
      case 'v':
        k = 'F';
        break;
      case 'w':
      case 'y':
        k = isV(n) ? c.toUpperCase() : '';
        break;
      case 'x':
        k = 'KS';
        break;
      case 'z':
        k = 'S';
        break;
      default:
        k = c.toUpperCase();
    }
    if (k && out.endsWith(k)) continue;
    out += k;
  }
  return out;
}

/** Jaro-Winkler similarity 0..1 (typo / mishearing tolerant, rewards a shared start). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const win = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false);
  const mb = new Array(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) {
    for (let j = Math.max(0, i - win); j < Math.min(lb, i + win + 1); j++) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = mb[j] = true;
      m++;
      break;
    }
  }
  if (!m) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const j = (m / la + m / lb + (m - t / 2) / m) / 3;
  let pre = 0;
  while (pre < 4 && a[pre] === b[pre]) pre++;
  return j + pre * 0.1 * (1 - j);
}

// ------------------------------------------------------------------ lexicon (concept ← surface words)

const LEX: Record<string, string[]> = {
  SHOW: ['show', 'open', 'display', 'bring up', 'pull up', 'let me see', 'view', 'see', 'launch', 'lunch', 'start', 'activate', 'turn on', 'switch on', 'enable', 'so', 'sure the', 'chow', 'give me', 'put on', 'visualize', 'visualise', 'reveal', 'expand'],
  HIDE: ['hide', 'close', 'turn off', 'turn of', 'switch of', 'turnoff', 'switch off', 'disable', 'remove', 'get rid of', 'take off', 'clear off', 'shut'],
  TOGGLE: ['toggle', 'flip'],
  CHECK: ['check', 'status', 'how is', 'hows', 'level', 'levels', 'remaining', 'left', 'report', 'how much', 'progress', 'reading', 'readings', 'tell me', 'whats my', 'what is my', 'state', 'percent', 'percentage', 'running low', 'enough'],
  O2: ['oxygen', 'o2', 'o 2', 'air', 'breathing', 'breathable', 'oxi', 'auxygen', 'oxigen'],
  WATER: ['water', 'h2o', 'cooling', 'coolant', 'sublimator', 'hydration', 'drink', 'drinking'],
  POWER: ['battery', 'batteries', 'power', 'charge', 'juice', 'electricity', 'battery life'],
  DOSE: ['dose', 'dosage', 'exposure', 'exposed', 'sievert', 'sieverts', 'absorbed', 'taken', 'did i get', 'have i had', 'received', 'have i got', 'i got'],
  RADIATION: ['radiation', 'rad', 'radioactive', 'radioactivity', 'cosmic rays', 'cosmic', 'gcr', 'irradiation', 'radiations'],
  FATIGUE: ['fatigue', 'tired', 'exhausted', 'exertion', 'stamina', 'worn out', 'energy level', 'sleepy', 'tiredness', 'effort', 'workload'],
  SLOPE: ['slope', 'slopes', 'steep', 'steepness', 'gradient', 'incline', 'inclination', 'terrain angle', 'hills'],
  POI: ['poi', 'points of interest', 'point of interest', 'landmarks', 'landmark', 'sites', 'places', 'markers'],
  DUST: ['dust', 'dusty', 'sand'],
  MAG: ['magnetic', 'magnet', 'magnetism', 'mag field', 'magnetic field', 'compass field'],
  FOG: ['fog', 'fog of war', 'unexplored', 'unknown area', 'explored'],
  ROVER: ['rover', 'perseverance', 'percy', 'rovers'],
  LAYER: ['layer', 'layers', 'overlay', 'overlays', 'heatmap', 'heat map', 'map layer', 'filter', 'lair', 'liar', 'player', 'lear', 'lay er'],
  MAP: ['map', 'maps', 'navigator', 'chart', 'minimap', 'mini map', 'atlas', 'radar', 'top view', 'overview'],
  ROUTE: ['route', 'path', 'way', 'traverse', 'course', 'track', 'trail', 'plan', 'directions', 'navigation'],
  ALT: ['new', 'different', 'another', 'alternative', 'alternate', 'other', 'safer', 'better', 'change', 'avoid', 'around'],
  REROUTE: ['reroute', 're route', 'detour', 'recalculate', 'recompute', 'replan', 're plan', 'reroot', 'we route', 'be route', 'reroute me', 'rear out'],
  DRONE: ['drone', 'drones', 'scout', 'uav', 'quadcopter', 'copter', 'flyer', 'drawn', 'throne'],
  FLY: ['fly', 'send', 'deploy', 'release', 'take off', 'launch', 'lunch', 'explore', 'go out', 'send out'],
  RECALL: ['recall', 'come back', 'return', 'bring back', 'land', 'call back', 'retrieve', 'dock'],
  SAMPLE: ['sample', 'samples', 'specimen', 'core', 'sampling', 'collect', 'bag', 'geology', 'rock sample', 'simple'],
  MARK: ['mark', 'record', 'note', 'save', 'log it', 'register'],
  VITALS: ['vitals', 'vital', 'vital signs', 'health', 'heart rate', 'heart', 'pulse', 'suit status', 'body', 'condition', 'biometrics', 'bpm', 'healthy', 'feeling', 'temperature', 'consumables'],
  HOWAMI: ['how am i', 'am i ok', 'am i okay', 'am i alright', 'how am i doing', 'am i fine'],
  MAYDAY: ['mayday', 'sos', 'help me', 'emergency', 'in trouble', 'i need help', 'send help', 'save me', 'rescue', 'distress', 'injured', 'hurt'],
  HOME: ['habitat', 'hab', 'home', 'base', 'station', 'airlock', 'lander'],
  GO: ['go', 'take me', 'navigate', 'head', 'guide', 'bring me', 'walk', 'lead', 'get me', 'return', 'direct me', 'back to', 'go back', 'move'],
  SHELTER: ['shelter', 'cover', 'safe place', 'bunker', 'hide from', 'protection', 'shield', 'safe spot'],
  CACHE: ['cache', 'supplies', 'supply', 'depot', 'resupply', 're supply', 'refill', 'top up', 'restock', 'replenish', 'stash'],
  REST: ['rest', 'break', 'breather', 'catch my breath', 'relax', 'sit down', 'take five', 'recover'],
  WEATHER: ['weather', 'forecast', 'storm', 'storms', 'wind', 'conditions', 'space weather', 'solar flare', 'flare', 'sky', 'climate'],
  TEAM: ['team', 'teammate', 'crew', 'crewmate', 'buddy', 'partner', 'colleague', 'ev2', 'ev 2', 'friend', 'other astronaut'],
  WHERE: ['where', 'location', 'position', 'coordinates', 'lost', 'whereabouts', 'gps'],
  WHAT: ['what', 'identify', 'describe', 'scan', 'analyse', 'analyze', 'tell me about', 'which', 'recognize', 'recognise', 'explain', 'info', 'information', 'details'],
  THIS: ['this', 'that', 'it', 'thing', 'object', 'rock', 'boulder', 'stone', 'looking at', 'in front of me', 'over there', 'these', 'those'],
  LABEL: ['label', 'tag', 'pin', 'flag', 'name it', 'mark it', 'bookmark'],
  PHOTO: ['photo', 'picture', 'image', 'snapshot', 'pic', 'capture', 'camera', 'shot', 'photograph', 'screenshot', 'selfie', 'pitcher', 'pitchur', 'foto'],
  ZOOMIN: ['zoom in', 'magnify', 'enhance', 'closer', 'enlarge', 'bigger', 'zoom closer'],
  ZOOMOUT: ['zoom out', 'wider', 'smaller', 'pull back', 'zoom back', 'unzoom'],
  ZOOM: ['zoom', 'zoomed', 'zooming'],
  RESET: ['reset', 'normal', 'default', 'original'],
  HELPQ: ['what can i say', 'commands', 'command list', 'help', 'instructions', 'how do i', 'how to use', 'options', 'manual', 'guide me through'],
  MUTE: ['mute', 'silence', 'quiet', 'shut up', 'sound off', 'be quiet', 'stop talking'],
  UNMUTE: ['unmute', 'sound on', 'speak again', 'talk again'],
  REPEAT: ['repeat', 'say again', 'again', 'pardon', 'come again', 'didnt hear', 'didnt catch', 'what did you say', 'sorry'],
  UNDO: ['undo', 'revert', 'take back', 'take that back', 'go back a step', 'cancel last'],
  YES: ['accept', 'confirm', 'approve', 'affirmative', 'roger', 'yes', 'yeah', 'yep', 'do it', 'go ahead', 'agree', 'correct'],
  NO: ['dismiss', 'decline', 'ignore', 'reject', 'negative', 'no', 'nope', 'cancel', 'never mind', 'nevermind', 'forget it'],
  PACE: ['pace', 'speed', 'tempo', 'walking speed'],
  SLOW: ['slow', 'slower', 'slow down', 'easy', 'gently'],
  FAST: ['fast', 'faster', 'speed up', 'quicker', 'hurry', 'quick'],
  JUMP: ['jump', 'hop', 'leap'],
  LOG: ['log', 'logs', 'timeline', 'history', 'what happened', 'events', 'journal', 'mission log'],
  SYSTEMS: ['systems', 'system', 'diagnostics', 'sensors', 'self test', 'hardware', 'microphone status', 'camera status'],
  TOOLS: ['tools', 'apps', 'menu', 'toolbox', 'all features', 'features', 'utilities'],
  STABILITY: ['stability', 'stabilize', 'stabilise', 'stabilizer', 'brace', 'balance', 'suit assist', 'steady'],
  MISSION: ['mission', 'objectives', 'objective', 'eva', 'goals', 'tasks', 'progress overall', 'plan for today'],
  CALIBRATE: ['calibrate', 'recalibrate', 'calibration', 'eye tracking', 'gaze', 'eye tracker'],
  VOICECHK: ['voice check', 'mic check', 'microphone check', 'voice test', 'test my voice'],
  SLEEP: ['stop listening', 'go to sleep', 'mic off', 'sleep', 'pause listening'],
  WAKE: ['start listening', 'resume listening', 'wake up', 'mic on', 'listen'],
  FEED: ['feed', 'images', 'raw images', 'photos from', 'latest images', 'cameras', 'seeing'],
  COMMIT: ['commit', 'lock in', 'finalize', 'finalise', 'save route', 'use this route'],
  CLEARR: ['clear route', 'reset route', 'erase route', 'delete route', 'clear waypoints', 'clear plan'],
  ON: ['on', 'enable', 'enabled', 'activate', 'engage'],
  OFF: ['off', 'disable', 'disabled', 'deactivate', 'release'],
};

/** Common words that carry no meaning for TEVAN (do not count against a command). */
const STOP = new Set(
  'a an the to of for in on at by with and or please can could would will you me my i im is are be do does did it its me us our your hey hi hello tevan just now here there these those find take got quickly some up down about kindly want wanna need like lets let go get give make is was were am very really current currently right yeah um uh er hmm so then also maybe'.split(
    ' ',
  ),
);

type Bag = Map<string, number>;

interface Entry {
  surface: string;
  words: string[];
  concept: string;
}
const ENTRIES: Entry[] = [];
const SINGLE = new Map<string, string[]>(); // single word → concepts
for (const [concept, surfaces] of Object.entries(LEX)) {
  for (const s of surfaces) {
    const n = normalise(s);
    const words = n.split(' ');
    ENTRIES.push({ surface: n, words, concept });
    if (words.length === 1) SINGLE.set(n, [...(SINGLE.get(n) ?? []), concept]);
  }
}
// multi-word phrases first (longest first), so "turn off" wins over "off"
ENTRIES.sort((a, b) => b.words.length - a.words.length || b.surface.length - a.surface.length);
const VOCAB = [...SINGLE.keys()];
const VOCAB_PH = VOCAB.map((w) => ({ w, ph: phonetic(w) }));

/** Best vocabulary word for a word the recogniser may have misheard, with match quality. */
function fuzzyWord(w: string): { word: string; q: number } | null {
  if (w.length < 4 || /\d/.test(w)) return null;
  const ph = phonetic(w);
  let best: { word: string; q: number } | null = null;
  for (const v of VOCAB_PH) {
    if (v.w.length < 3) continue;
    const lenOk = Math.abs(v.w.length - w.length) <= Math.max(2, Math.floor(v.w.length * 0.4));
    if (!lenOk) continue;
    const jw = jaroWinkler(w, v.w);
    // spelling: very close, stricter for short words
    let q = jw >= (w.length <= 5 ? 0.92 : 0.9) ? jw : 0;
    // sound: same phonetic code (long enough to be specific) and a similar spelling
    if (ph.length >= 3 && ph === v.ph && jw >= 0.72) q = Math.max(q, 0.9);
    if (!best || q > best.q) best = { word: v.w, q };
  }
  return best && best.q >= 0.88 ? best : null;
}

export interface Analysis {
  bag: Bag;
  /** words that mean nothing to TEVAN */
  unknown: string[];
  /** human-readable list of rescued words, e.g. "lair→layer" */
  fixes: string[];
  text: string;
}

/** Turn an utterance into a weighted concept bag. */
export function analyse(raw: string, aliases: string[] = []): Analysis {
  const text = stripWake(normalise(raw), aliases).text;
  const toks = text ? text.split(' ') : [];
  const used = new Array(toks.length).fill(false);
  const bag: Bag = new Map();
  const add = (c: string, q: number) => bag.set(c, Math.max(bag.get(c) ?? 0, q));
  // 1. exact phrases and words
  for (const e of ENTRIES) {
    const L = e.words.length;
    for (let i = 0; i + L <= toks.length; i++) {
      if (used.slice(i, i + L).some(Boolean) && L > 1) continue;
      let ok = true;
      for (let j = 0; j < L; j++) if (toks[i + j] !== e.words[j]) ok = false;
      if (!ok) continue;
      add(e.concept, 1);
      for (let j = 0; j < L; j++) used[i + j] = true;
    }
  }
  // 2. split words the recogniser joined or broke apart ("oxy gen", "re route", "vitalsigns")
  const fixes: string[] = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    if (used[i] || used[i + 1]) continue;
    const joined = toks[i] + toks[i + 1];
    const cs = SINGLE.get(joined);
    if (cs) {
      cs.forEach((c) => add(c, 0.95));
      used[i] = used[i + 1] = true;
      fixes.push(`${toks[i]} ${toks[i + 1]}→${joined}`);
    }
  }
  // 3. sound-alike / misspelt words
  const unknown: string[] = [];
  toks.forEach((w, i) => {
    if (used[i] || STOP.has(w)) return;
    const f = fuzzyWord(w);
    if (f) {
      SINGLE.get(f.word)!.forEach((c) => add(c, f.q * 0.95));
      fixes.push(`${w}→${f.word}`);
    } else if (!/^\d+$/.test(w)) unknown.push(w);
  });
  return { bag, unknown, fixes, text };
}

// ------------------------------------------------------------------ intents

interface IntentDef {
  id: string;
  /** what TEVAN will say it understood ("Show radiation layer") */
  label: (a: Analysis) => string;
  /** at least one of these concepts must be present */
  need: string[];
  /** example utterances (any wording) */
  ex: string[];
  build: (a: Analysis) => Command | null;
}

const LAYER_OF: [string, LayerWord, string][] = [
  ['RADIATION', 'radiation', 'radiation'],
  ['SLOPE', 'slope', 'slope'],
  ['POI', 'poi', 'points of interest'],
  ['DUST', 'dust', 'dust'],
  ['MAG', 'mag', 'magnetic field'],
  ['FOG', 'fog', 'fog of war'],
  ['ROVER', 'rover', 'rover route'],
];
const FEAT_OF: [string, FeatureId, string][] = [
  ['O2', 'o2', 'oxygen'],
  ['WATER', 'h2o', 'water'],
  ['POWER', 'power', 'battery'],
  ['DOSE', 'dose', 'radiation dose'],
  ['FATIGUE', 'fatigue', 'fatigue'],
];
const TAG_OF: [string, TagWord][] = [
  ['TEAM', 'teammate'],
  ['HOME', 'habitat'],
  ['SAMPLE', 'sample'],
  ['CACHE', 'resource'],
];
const has = (a: Analysis, c: string) => a.bag.has(c);
const onOff = (a: Analysis): boolean | undefined => (has(a, 'HIDE') || has(a, 'OFF') ? false : has(a, 'SHOW') || has(a, 'ON') ? true : undefined);
const pickLayer = (a: Analysis) => {
  let best: [string, LayerWord, string] | undefined;
  for (const l of LAYER_OF) if (has(a, l[0]) && (!best || a.bag.get(l[0])! > a.bag.get(best[0])!)) best = l;
  return best;
};
const pickFeat = (a: Analysis) => {
  if (has(a, 'RADIATION') && !has(a, 'DOSE')) return FEAT_OF[3];
  let best: [string, FeatureId, string] | undefined;
  for (const f of FEAT_OF) if (has(a, f[0]) && (!best || a.bag.get(f[0])! > a.bag.get(best[0])!)) best = f;
  return best;
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

const INTENTS: IntentDef[] = [
  {
    id: 'layer',
    need: ['RADIATION', 'SLOPE', 'POI', 'DUST', 'MAG', 'FOG', 'ROVER'],
    label: (a) => {
      const l = pickLayer(a);
      const on = onOff(a);
      return `${on === false ? 'Hide' : on ? 'Show' : 'Toggle'} ${l?.[2] ?? ''} layer`;
    },
    ex: LAYER_OF.flatMap(([, , w]) => [`show ${w} layer`, `${w} overlay`, `hide ${w}`, `turn on ${w} map`, `display the ${w}`, `toggle ${w}`, `${w} layer off`, `where is the ${w} on the map`]),
    build: (a) => {
      const l = pickLayer(a);
      return l ? { type: 'layer', layer: l[1], on: onOff(a) } : null;
    },
  },
  {
    id: 'progress',
    need: ['O2', 'WATER', 'POWER', 'DOSE', 'FATIGUE'],
    label: (a) => `Check ${pickFeat(a)?.[2] ?? 'consumable'}`,
    ex: [
      ...FEAT_OF.flatMap(([, , w]) => [`how much ${w} do i have`, `${w} level`, `check my ${w}`, `${w} status`, `whats my ${w}`, `${w} remaining`, `am i running low on ${w}`]),
      'how much radiation have i taken',
      'my radiation exposure',
      'how tired am i',
      'am i exhausted',
    ],
    build: (a) => {
      const f = pickFeat(a);
      return f ? { type: 'progress', feature: f[1] } : null;
    },
  },
  { id: 'vitals', need: ['VITALS', 'HOWAMI'], label: () => 'Read vitals', ex: ['how am i doing', 'my vitals', 'check my health', 'heart rate', 'suit status', 'what is my pulse', 'body condition', 'am i ok', 'vital signs please'], build: () => ({ type: 'vitals' }) },
  { id: 'reroute', need: ['REROUTE', 'ALT'], label: () => 'Find another route', ex: ['reroute', 'find another route', 'give me a safer path', 'new route please', 'change the route', 'alternative path', 'take a detour', 'avoid this way', 'route around it', 'recalculate route'], build: () => ({ type: 'reroute' }) },
  { id: 'droneUp', need: ['DRONE'], label: () => 'Launch the scout drone', ex: ['launch drone', 'send the drone', 'deploy the scout', 'fly the drone', 'drone scout ahead', 'send out the drone', 'drone go explore', 'drone up'], build: () => ({ type: 'drone', action: 'launch' }) },
  { id: 'droneBack', need: ['RECALL'], label: () => 'Recall the drone', ex: ['recall drone', 'bring the drone back', 'drone come back', 'land the drone', 'call back the scout', 'drone return'], build: () => ({ type: 'drone', action: 'recall' }) },
  { id: 'sample', need: ['SAMPLE'], label: () => 'Mark a sample', ex: ['mark sample', 'collect a sample', 'take a sample here', 'bag this rock sample', 'record a specimen', 'sample here', 'log sample'], build: () => ({ type: 'sample' }) },
  { id: 'mapOpen', need: ['MAP'], label: () => 'Open the map', ex: ['open map', 'show me the map', 'map please', 'bring up the navigator', 'let me see the map', 'open maps', 'show the chart'], build: (a) => (has(a, 'HIDE') ? { type: 'map', open: false } : { type: 'map', open: true }) },
  { id: 'layersPanel', need: ['LAYER'], label: () => 'Open map layers', ex: ['layers', 'show layers', 'open the layers', 'map layers', 'overlays'], build: () => ({ type: 'launch', feature: 'layers' }) },
  { id: 'routePanel', need: ['ROUTE'], label: () => 'Show the route', ex: ['show route', 'my route', 'route status', 'how far is my route', 'navigation', 'show me the way', 'directions'], build: (a) => (has(a, 'CHECK') ? { type: 'progress', feature: 'route' } : { type: 'launch', feature: 'route' }) },
  { id: 'mayday', need: ['MAYDAY'], label: () => 'Call for help (mayday)', ex: ['mayday', 'i need help', 'help me', 'emergency', 'send help now', 'i am in trouble', 'call for rescue', 'i am injured'], build: () => ({ type: 'emergency', action: 'help' }) },
  { id: 'home', need: ['HOME'], label: () => 'Navigate back to the habitat', ex: ['back to habitat', 'take me home', 'go back to base', 'return to the hab', 'head home', 'navigate to habitat', 'guide me to the base'], build: () => ({ type: 'emergency', action: 'habitat' }) },
  { id: 'shelter', need: ['SHELTER'], label: () => 'Navigate to the nearest shelter', ex: ['find shelter', 'take cover', 'nearest shelter', 'go to shelter', 'i need cover', 'get me to a safe place'], build: () => ({ type: 'emergency', action: 'shelter' }) },
  { id: 'cache', need: ['CACHE'], label: () => 'Navigate to the nearest supply cache', ex: ['go to cache', 'nearest supply cache', 'i need supplies', 'resupply', 'refill my oxygen at the depot', 'take me to the supplies', 'top up'], build: (a) => (has(a, 'GO') ? { type: 'emergency', action: 'cache' } : { type: 'emergency', action: 'resupply' }) },
  { id: 'rest', need: ['REST'], label: () => 'Rest here', ex: ['rest', 'take a break', 'i need a rest', 'let me catch my breath', 'sit down for a bit', 'take five'], build: () => ({ type: 'emergency', action: 'rest' }) },
  { id: 'weather', need: ['WEATHER'], label: () => 'Weather report', ex: ['weather', 'how is the weather', 'any storms', 'weather forecast', 'check conditions', 'is a dust storm coming', 'space weather'], build: () => ({ type: 'tool', tool: 'weather' }) },
  { id: 'team', need: ['TEAM'], label: () => 'Team status', ex: ['where is my teammate', 'team status', 'crew positions', 'find my buddy', 'how is my partner', 'show the crew'], build: (a) => (has(a, 'GO') ? { type: 'goTeammate' } : { type: 'tool', tool: 'team' }) },
  { id: 'where', need: ['WHERE'], label: () => 'Report my position', ex: ['where am i', 'my location', 'my coordinates', 'i am lost', 'what is my position'], build: (a) => (has(a, 'TEAM') ? { type: 'tool', tool: 'team' } : { type: 'where' }) },
  { id: 'what', need: ['WHAT'], label: () => 'Identify what I am looking at', ex: ['what is this', 'what is that rock', 'identify this', 'tell me about that boulder', 'what am i looking at', 'scan this object', 'describe that', 'info on this'], build: () => ({ type: 'whatThis' }) },
  { id: 'label', need: ['LABEL'], label: () => 'Label what I am looking at', ex: ['label this', 'tag that rock', 'pin this', 'flag that', 'bookmark this place', 'mark it'], build: (a) => ({ type: 'labelThis', kind: TAG_OF.find(([c]) => has(a, c))?.[1] }) },
  { id: 'photo', need: ['PHOTO'], label: () => 'Take a photo', ex: ['take a photo', 'take a picture', 'capture this', 'snapshot', 'photograph that', 'camera shot'], build: () => ({ type: 'photo' }) },
  { id: 'zoomIn', need: ['ZOOMIN', 'ZOOM'], label: () => 'Zoom in', ex: ['zoom in', 'zoom closer', 'magnify', 'enhance', 'get closer', 'make it bigger'], build: (a) => (has(a, 'ZOOMOUT') ? { type: 'zoom', dir: 'out' } : has(a, 'RESET') ? { type: 'zoom', dir: 'reset' } : { type: 'zoom', dir: 'in' }) },
  { id: 'zoomOut', need: ['ZOOMOUT'], label: () => 'Zoom out', ex: ['zoom out', 'wider view', 'pull back', 'make it smaller'], build: () => ({ type: 'zoom', dir: 'out' }) },
  { id: 'help', need: ['HELPQ'], label: () => 'List voice commands', ex: ['what can i say', 'help', 'show commands', 'how do i use this', 'instructions please', 'what are my options'], build: () => ({ type: 'help' }) },
  { id: 'mute', need: ['MUTE'], label: () => 'Mute sound', ex: ['mute', 'be quiet', 'silence please', 'sound off', 'stop talking'], build: () => ({ type: 'mute', on: true }) },
  { id: 'unmute', need: ['UNMUTE'], label: () => 'Sound on', ex: ['unmute', 'sound on', 'talk again'], build: () => ({ type: 'mute', on: false }) },
  { id: 'repeat', need: ['REPEAT'], label: () => 'Repeat the last message', ex: ['repeat that', 'say again', 'pardon', 'i didnt catch that', 'come again', 'what did you say'], build: () => ({ type: 'repeat' }) },
  { id: 'undo', need: ['UNDO'], label: () => 'Undo', ex: ['undo', 'undo that', 'take that back', 'revert'], build: () => ({ type: 'undo' }) },
  { id: 'pace', need: ['PACE', 'SLOW', 'FAST'], label: (a) => (has(a, 'SLOW') ? 'Slow pace' : has(a, 'FAST') ? 'Fast pace' : 'Change pace'), ex: ['slow down', 'slower pace', 'speed up', 'faster pace', 'change my pace', 'walk slower', 'go faster'], build: (a) => ({ type: 'pace', pace: has(a, 'SLOW') ? 'slow' : has(a, 'FAST') ? 'fast' : undefined }) },
  { id: 'log', need: ['LOG'], label: () => 'Open the mission log', ex: ['show the log', 'mission log', 'what happened', 'open history', 'event timeline'], build: (a) => ({ type: 'logPanel', open: !has(a, 'HIDE') }) },
  { id: 'systems', need: ['SYSTEMS'], label: () => 'Systems check', ex: ['systems check', 'run diagnostics', 'sensor status', 'check my systems'], build: () => ({ type: 'tool', tool: 'systems' }) },
  { id: 'tools', need: ['TOOLS'], label: () => 'Open tools', ex: ['open tools', 'show menu', 'all features', 'toolbox'], build: () => ({ type: 'tool', tool: 'tools' }) },
  { id: 'stability', need: ['STABILITY'], label: () => 'Stability assist', ex: ['stability assist', 'stabilize me', 'brace', 'turn on stability', 'help me balance', 'keep me steady'], build: (a) => ({ type: 'stability', on: has(a, 'OFF') || has(a, 'HIDE') ? false : has(a, 'ON') || has(a, 'SHOW') ? true : undefined }) },
  { id: 'mission', need: ['MISSION'], label: () => 'Mission progress', ex: ['mission status', 'how is the mission going', 'objectives', 'what are my tasks', 'eva progress'], build: () => ({ type: 'progress', feature: 'mission' }) },
  { id: 'calibrate', need: ['CALIBRATE'], label: () => 'Calibrate gaze', ex: ['calibrate', 'recalibrate eye tracking', 'fix the gaze', 'calibrate my eyes'], build: () => ({ type: 'calibrate' }) },
  { id: 'voicecheck', need: ['VOICECHK'], label: () => 'Voice check', ex: ['voice check', 'test my voice', 'mic check'], build: () => ({ type: 'calibrate', what: 'voice' }) },
  { id: 'rover', need: ['ROVER'], label: () => 'Show the Perseverance feed', ex: ['rover feed', 'what is the rover seeing', 'perseverance images', 'latest rover photos', 'show the rover cameras'], build: () => ({ type: 'tool', tool: 'rover' }) },
  { id: 'jump', need: ['JUMP'], label: () => 'Jump', ex: ['jump', 'jump over it', 'hop over'], build: () => ({ type: 'jump' }) },
  { id: 'commit', need: ['COMMIT'], label: () => 'Commit the planned route', ex: ['commit route', 'lock in the plan', 'use this route', 'finalize route'], build: () => ({ type: 'commit' }) },
  { id: 'clearRoute', need: ['CLEARR'], label: () => 'Clear the planned route', ex: ['clear route', 'erase the waypoints', 'reset route'], build: () => ({ type: 'clear' }) },
  { id: 'accept', need: ['YES'], label: () => 'Accept', ex: ['accept', 'yes do it', 'confirm', 'go ahead', 'affirmative', 'okay accept that'], build: () => ({ type: 'accept' }) },
  { id: 'dismiss', need: ['NO'], label: () => 'Dismiss', ex: ['dismiss', 'no thanks', 'ignore it', 'cancel that', 'never mind'], build: () => ({ type: 'dismiss' }) },
  { id: 'sleep', need: ['SLEEP'], label: () => 'Stop listening', ex: ['stop listening', 'go to sleep', 'mic off'], build: () => ({ type: 'sleep' }) },
  { id: 'wake', need: ['WAKE'], label: () => 'Resume listening', ex: ['start listening', 'wake up', 'mic on'], build: () => ({ type: 'wake' }) },
];

// ------------------------------------------------------------------ scoring model (built once)

const EX_BAGS = INTENTS.map((it) => it.ex.map((e) => analyse(e).bag));
/** inverse "intent frequency" of each concept: specific concepts matter more */
const IDF = new Map<string, number>();
{
  const df = new Map<string, number>();
  EX_BAGS.forEach((bags) => {
    const seen = new Set<string>();
    bags.forEach((b) => b.forEach((_, c) => seen.add(c)));
    seen.forEach((c) => df.set(c, (df.get(c) ?? 0) + 1));
  });
  const N = INTENTS.length;
  for (const c of Object.keys(LEX)) IDF.set(c, Math.log(1 + N / (df.get(c) ?? 1)));
}
const wOf = (c: string) => IDF.get(c) ?? 1;
/** how much an unrecognised word dilutes the match (small talk penalty) */
const UNKNOWN_W = 1.8;

function cosine(u: Analysis, e: Bag): number {
  let dot = 0;
  let nu = 0;
  let ne = 0;
  u.bag.forEach((q, c) => {
    const w = wOf(c) * q;
    nu += w * w;
    if (e.has(c)) dot += w * wOf(c);
  });
  e.forEach((_, c) => (ne += wOf(c) ** 2));
  nu += u.unknown.length * UNKNOWN_W ** 2;
  return nu && ne ? dot / Math.sqrt(nu * ne) : 0;
}

export interface Understood {
  cmd: Command;
  /** 0..1 */
  confidence: number;
  /** 'grammar' = exact phrase, 'intent' = understood by meaning */
  via: 'grammar' | 'intent';
  /** what TEVAN understood, in words */
  label: string;
  intent: string;
  /** the recogniser alternative that was used */
  heard: string;
  /** misheard words that were rescued, e.g. ["lair→layer"] */
  fixes: string[];
  /** a close second guess, when ambiguous */
  runnerUp?: { label: string; confidence: number };
}

/** concepts that make an utterance a request rather than conversation */
const ACTION = ['SHOW', 'HIDE', 'TOGGLE', 'CHECK', 'GO', 'WHAT', 'WHERE', 'FLY', 'RECALL', 'MARK', 'LABEL', 'HOWAMI', 'MAYDAY', 'YES', 'NO', 'ZOOMIN', 'ZOOMOUT', 'HELPQ', 'REPEAT', 'UNDO', 'REROUTE'];

/** Confidence at or above which a guessed intent runs without asking. */
export const RUN_AT = 0.6;
/** Between ASK_AT and RUN_AT, TEVAN asks "Did you mean …?". Below, it is ignored. */
export const ASK_AT = 0.4;

/** Classify one utterance by meaning (ignores the strict grammar). */
export function classify(text: string, aliases: string[] = []): Understood | null {
  const a = analyse(text, aliases);
  if (!a.bag.size) return null;
  const scored: { it: IntentDef; s: number }[] = [];
  INTENTS.forEach((it, i) => {
    if (!it.need.some((c) => a.bag.has(c))) return;
    let s = 0;
    for (const b of EX_BAGS[i]) s = Math.max(s, cosine(a, b));
    scored.push({ it, s });
  });
  scored.sort((x, y) => y.s - x.s);
  for (let k = 0; k < scored.length; k++) {
    const top = scored[k];
    const cmd = top.it.build(a);
    if (!cmd) continue;
    const second = scored.find((x, j) => j !== k && x.it.id !== top.it.id);
    // ambiguity: a close runner-up lowers confidence so TEVAN asks instead of guessing
    const margin = second ? top.s - second.s : 1;
    let conf = Math.max(0, Math.min(1, top.s - (margin < 0.06 ? 0.12 : 0)));
    // mostly unrelated words and no request verb: probably talk, not a command, so ask first
    if (a.unknown.length >= 2 && !ACTION.some((c) => a.bag.has(c))) conf = Math.min(conf, RUN_AT - 0.05);
    return { cmd, confidence: conf, via: 'intent', label: top.it.label(a), intent: top.it.id, heard: text, fixes: a.fixes, runnerUp: second && margin < 0.1 ? { label: second.it.label(a), confidence: second.s } : undefined };
  }
  return null;
}

/** Human label for a command produced by the strict grammar. */
function grammarLabel(c: Command): string {
  switch (c.type) {
    case 'layer':
      return `${c.on === false ? 'Hide' : c.on ? 'Show' : 'Toggle'} ${c.layer} layer`;
    case 'progress':
      return `Check ${c.feature}`;
    case 'launch':
      return `Open ${c.feature}`;
    default:
      return cap(c.type.replace(/([A-Z])/g, ' $1').toLowerCase());
  }
}

/**
 * Understand what was said. Tries every recogniser alternative: an exact grammar
 * match wins outright; otherwise the best intent guess across alternatives.
 */
export function understand(alternatives: string[], aliases: string[] = []): Understood | null {
  const alts = alternatives.map((s) => s.trim()).filter(Boolean);
  for (const t of alts) {
    const c = parseCommand(t, aliases);
    if (c) return { cmd: c, confidence: 1, via: 'grammar', label: grammarLabel(c), intent: c.type, heard: t, fixes: [] };
  }
  let best: Understood | null = null;
  alts.forEach((t, i) => {
    const u = classify(t, aliases);
    if (!u) return;
    u.confidence *= 1 - i * 0.04; // later alternatives are the recogniser's weaker guesses
    if (!best || u.confidence > best.confidence) best = u;
  });
  const b = best as Understood | null;
  return b && b.confidence >= ASK_AT ? b : null;
}

/** "yes" / "no" answers to a "Did you mean …?" question. */
export function yesNo(text: string): 'yes' | 'no' | null {
  const t = normalise(text);
  if (/^(yes|yeah|yep|yup|ya|yah|yes please|correct|right|affirmative|confirm|do it|go ahead|sure|ok|okay|that s right|thats right|exactly|roger|yes it is|yes i did|uh huh)\b/.test(t)) return 'yes';
  if (/^(no|nope|nah|negative|cancel|never mind|nevermind|wrong|not that|no thanks|forget it)\b/.test(t)) return 'no';
  return null;
}
