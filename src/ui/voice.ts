/**
 * VOICE: hands-free commands from the astronaut's real microphone.
 *
 * Web Speech API in continuous mode with interim results, auto-restarted, so
 * the astronaut never has to press anything. Recognition is muted while TEVAN
 * is speaking so it doesn't hear itself. The parser is a small deterministic
 * grammar (no LLM): the same text always gives the same command.
 */
export type FeatureId = 'mission' | 'o2' | 'h2o' | 'power' | 'dose' | 'fatigue' | 'map' | 'route' | 'drone' | 'sample' | 'layers';
export type LayerWord = 'radiation' | 'slope' | 'poi' | 'dust' | 'mag' | 'fog';

export type Command =
  | { type: 'launchThis' }
  | { type: 'progressThis' }
  | { type: 'launch'; feature: FeatureId }
  | { type: 'progress'; feature: FeatureId }
  | { type: 'layer'; layer: LayerWord; on?: boolean }
  | { type: 'reroute' }
  | { type: 'accept' }
  | { type: 'dismiss' }
  | { type: 'sample' }
  | { type: 'vitals' }
  | { type: 'drone'; action: 'launch' | 'recall' | 'relay' }
  | { type: 'map'; open: boolean }
  | { type: 'close' }
  | { type: 'option'; n: number }
  | { type: 'pace'; pace?: 'slow' | 'nominal' | 'fast' }
  | { type: 'zoom'; dir: 'in' | 'out' | 'reset' }
  | { type: 'calibrate' }
  | { type: 'commit' }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'mute'; on: boolean }
  | { type: 'sleep' }
  | { type: 'wake' };

const LAYER_WORDS: [RegExp, LayerWord][] = [
  [/\b(radiation|dose map|rad)\b/, 'radiation'],
  [/\b(slopes?|gradient|steepness)\b/, 'slope'],
  [/\b(poi|points? of interest|sites?|landmarks?)\b/, 'poi'],
  [/\b(dust)\b/, 'dust'],
  [/\b(magnetic|mag|field)\b/, 'mag'],
  [/\b(fog|unexplored)\b/, 'fog'],
];

const FEATURE_WORDS: [RegExp, FeatureId][] = [
  [/\b(oxygen|o2|o 2|air)\b/, 'o2'],
  [/\b(water|cooling|h2o|sublimator)\b/, 'h2o'],
  [/\b(battery|power|pwr)\b/, 'power'],
  [/\b(radiation|dose)\b/, 'dose'],
  [/\b(fatigue|exertion|tired)\b/, 'fatigue'],
  [/\b(drone|scout)\b/, 'drone'],
  [/\b(map|radar)\b/, 'map'],
  [/\b(route|traverse|navigation|path|planner)\b/, 'route'],
  [/\b(samples?|science)\b/, 'sample'],
  [/\b(layers?|overlays?)\b/, 'layers'],
  [/\b(mission|objectives?|eva)\b/, 'mission'],
];

const NUM: [RegExp, number][] = [
  [/^(one|won|1|first|wan)$/, 1],
  [/^(two|to|too|2|second)$/, 2],
  [/^(three|tree|free|3|third)$/, 3],
  [/^(four|for|fore|4|fourth)$/, 4],
];
const num = (w?: string) => (w ? NUM.find(([r]) => r.test(w))?.[1] ?? 0 : 0);

export function normalise(text: string) {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse one utterance. Returns null when it isn't a command (ignored silently). */
export function parseCommand(text: string): Command | null {
  const t = normalise(text);
  if (!t) return null;
  const has = (re: RegExp) => re.test(t);
  const feature = () => FEATURE_WORDS.find(([r]) => r.test(t))?.[1];
  const deictic = has(/\b(this|that|it|here|these|those)\b/);

  if (has(/\b(stop|pause) listening\b|\bgo to sleep\b|\bmic off\b/)) return { type: 'sleep' };
  if (has(/\b(resume|start) listening\b|\bwake up\b|\bmic on\b/)) return { type: 'wake' };

  // gaze-targeted ("deictic") commands: "launch this feature", "check this feature's progress"
  if (deictic && has(/\b(progress|status|state|check|how is|hows|report)\b/)) return { type: 'progressThis' };
  if (deictic && has(/\b(launch|lunch|launched|open|activate|start|run|select|deploy|engage|toggle|do)\b/)) return { type: 'launchThis' };

  // numbered choices: "option two", "take route one", "choose the second"
  const m = t.match(/\b(?:option|choice|choose|number|route|select|take|pick|go with|traverse)(?: the| route| option)? (\w+)/);
  if (m && num(m[1])) return { type: 'option', n: num(m[1]) };
  if (/^(one|two|three|four|first|second|third)$/.test(t)) return { type: 'option', n: num(t) };

  // layers
  if (has(/\b(toggle|show|hide|display|enable|disable|turn on|turn off|switch on|switch off|layer|overlay)\b/)) {
    const lw = LAYER_WORDS.find(([r]) => r.test(t));
    if (lw) {
      const on = has(/\b(hide|disable|turn off|switch off|remove)\b/) ? false : has(/\b(show|display|enable|turn on|switch on)\b/) ? true : undefined;
      return { type: 'layer', layer: lw[1], on };
    }
  }

  if (has(/\b(accept|confirm|approve|affirmative|roger)\b/)) return { type: 'accept' };
  if (has(/\b(dismiss|decline|ignore|reject|negative|cancel)\b/)) return { type: 'dismiss' };
  if (has(/\b(reroute|re route|alternate|alternative|another route|new route|safer route|detour)\b/)) return { type: 'reroute' };
  if (has(/\b(commit|lock in|confirm) (the )?(route|plan)\b/)) return { type: 'commit' };
  if (has(/\b(clear|reset|erase) (the )?(route|plan|waypoints)\b/)) return { type: 'clear' };

  if (has(/\bzoom in\b|\bmagnify\b|\benhance\b/)) return { type: 'zoom', dir: 'in' };
  if (has(/\bzoom out\b/)) return { type: 'zoom', dir: 'out' };
  if (has(/\b(reset|normal) zoom\b|\bzoom (reset|normal)\b/)) return { type: 'zoom', dir: 'reset' };
  if (has(/\b(calibrate|recalibrate)\b/)) return { type: 'calibrate' };

  if (has(/\b(close|exit|hide) (the )?(map|planner|panel)\b/) || /^(close|back|exit|done)$/.test(t)) return { type: 'close' };
  if (has(/\b(recall|return|bring back|land) (the )?(drone|scout)\b/)) return { type: 'drone', action: 'recall' };
  if (has(/\b(relay)\b/)) return { type: 'drone', action: 'relay' };

  if (has(/\b(mark|collect|take|grab|bag) (a |the )?(sample|specimen|core)\b/) || has(/\bmark sample\b|\bfield note\b/)) return { type: 'sample' };

  // named features: "check oxygen progress", "drone status", "how is the route"
  const f = feature();
  if (f && has(/\b(progress|status|check|how is|hows|report|level|remaining|left)\b/)) return { type: 'progress', feature: f };
  if (f && has(/\b(launch|lunch|open|activate|start|deploy|show|bring up)\b/)) return f === 'drone' ? { type: 'drone', action: 'launch' } : { type: 'launch', feature: f };

  if (has(/\b(vitals|vital signs|health|how am i|heart rate|suit status|consumables)\b/)) return { type: 'vitals' };
  if (has(/\b(slow|slower|fast|faster|nominal) ?(pace|down|up)?\b/) && has(/\b(pace|slow|fast|faster|slower)\b/))
    return { type: 'pace', pace: has(/\bslow/) ? 'slow' : has(/\bfast/) ? 'fast' : 'nominal' };
  if (has(/\bpace\b/)) return { type: 'pace' };
  if (has(/\b(help|what can i say|commands)\b/)) return { type: 'help' };
  if (has(/\bunmute\b|\bsound on\b/)) return { type: 'mute', on: false };
  if (has(/\bmute\b|\bsound off\b|\bsilence\b/)) return { type: 'mute', on: true };
  if (/^(map|open map)$/.test(t)) return { type: 'map', open: true };
  return null;
}

export type VoiceState = 'off' | 'listening' | 'hearing' | 'asleep' | 'denied' | 'unsupported';

export class Voice {
  private rec: any = null;
  state: VoiceState = 'off';
  supported: boolean;
  asleep = false;
  private want = false;
  private speakingUntil = 0;
  private restartTimer = 0;
  /** final transcript (already filtered while TEVAN speaks) */
  onFinal: (text: string) => void = () => {};
  /** live partial transcript */
  onInterim: (text: string) => void = () => {};
  onState: (s: VoiceState) => void = () => {};
  /** smoothed mic activity 0..1 for the UI (from the recognizer's sound events) */
  level = 0;

  constructor() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.supported = !!SR;
    if (!SR) {
      this.state = 'unsupported';
      return;
    }
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      if (this.isSpeaking()) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = String(r[0]?.transcript ?? '').trim();
        if (!text) continue;
        if (r.isFinal) {
          this.level = 0;
          this.set(this.asleep ? 'asleep' : 'listening');
          this.onFinal(text);
        } else {
          this.level = 1;
          if (!this.asleep) this.set('hearing');
          this.onInterim(text);
        }
      }
    };
    rec.onspeechstart = () => (this.level = 1);
    rec.onspeechend = () => (this.level = 0);
    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false;
        this.set('denied');
      }
    };
    rec.onend = () => {
      // Chrome ends continuous sessions after silence/timeouts: keep the mic hot.
      if (this.want) {
        clearTimeout(this.restartTimer);
        this.restartTimer = window.setTimeout(() => this.startRec(), 250);
      } else if (this.state !== 'denied') this.set('off');
    };
    this.rec = rec;
  }

  private set(s: VoiceState) {
    if (s === this.state) return;
    this.state = s;
    this.onState(s);
  }

  private startRec() {
    if (!this.rec || !this.want) return;
    try {
      this.rec.start();
      this.set(this.asleep ? 'asleep' : 'listening');
    } catch {
      /* already running */
    }
  }

  start() {
    if (!this.rec) return;
    this.want = true;
    this.startRec();
  }
  stop() {
    this.want = false;
    try {
      this.rec?.stop();
    } catch {
      /* noop */
    }
    this.set('off');
  }
  sleep(on: boolean) {
    this.asleep = on;
    if (this.state !== 'denied' && this.state !== 'unsupported' && this.state !== 'off') this.set(on ? 'asleep' : 'listening');
  }

  isSpeaking() {
    return performance.now() < this.speakingUntil || (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking);
  }

  /** Speak a reply; the recognizer ignores what it hears while this plays. */
  speak(text: string) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.07;
    u.pitch = 0.95;
    this.speakingUntil = performance.now() + 400 + text.length * 70;
    u.onend = () => (this.speakingUntil = performance.now() + 350);
    speechSynthesis.speak(u);
  }
}
