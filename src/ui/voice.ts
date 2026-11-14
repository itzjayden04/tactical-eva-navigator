/**
 * VOICE: hands-free commands from the astronaut's real microphone.
 *
 * Web Speech API in continuous mode with interim results, auto-restarted, so
 * the astronaut never has to press anything. Recognition is muted while TEVAN
 * is speaking so it doesn't hear itself. The parser is a small deterministic
 * grammar (no LLM): the same text always gives the same command.
 */
export type FeatureId = 'mission' | 'o2' | 'h2o' | 'power' | 'dose' | 'fatigue' | 'map' | 'route' | 'drone' | 'sample' | 'layers';
export type TagWord = 'teammate' | 'habitat' | 'destination' | 'hazard' | 'sample' | 'resource' | 'note';
export type ToolId = 'tools' | 'team' | 'supplies' | 'systems' | 'weather' | 'tags' | 'log' | 'emergency' | 'rover';
export type LayerWord = 'radiation' | 'slope' | 'poi' | 'dust' | 'mag' | 'fog' | 'rover';

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
  | { type: 'calibrate'; what?: 'voice' }
  | { type: 'commit' }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'mute'; on: boolean }
  | { type: 'sleep' }
  | { type: 'wake' }
  | { type: 'hello' }
  | { type: 'whatThis' }
  | { type: 'labelThis'; kind?: TagWord }
  | { type: 'tagKind'; kind: TagWord }
  | { type: 'removeTag' }
  | { type: 'goTag'; kind?: TagWord }
  | { type: 'goTeammate' }
  | { type: 'emergency'; action: 'help' | 'habitat' | 'shelter' | 'rest' | 'cache' | 'resupply' | 'resume' | 'cancelNav' }
  | { type: 'stability'; on?: boolean }
  | { type: 'tool'; tool: ToolId }
  | { type: 'logPanel'; open: boolean }
  | { type: 'photo' }
  | { type: 'repeat' }
  | { type: 'undo' }
  | { type: 'jump' }
  | { type: 'where' };

const LAYER_WORDS: [RegExp, LayerWord][] = [
  [/\b(radiation|dose map|rad)\b/, 'radiation'],
  [/\b(slopes?|gradient|steepness)\b/, 'slope'],
  [/\b(poi|points? of interest|sites?|landmarks?)\b/, 'poi'],
  [/\b(dust)\b/, 'dust'],
  [/\b(magnetic|mag|field)\b/, 'mag'],
  [/\b(fog|unexplored)\b/, 'fog'],
  [/\b(rover|perseverance|traverse)\b/, 'rover'],
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

const TAG_WORDS: [RegExp, TagWord][] = [
  [/\b(teammates?|team mates?|crewmates?|crew|buddy|partner|astronaut|person)\b/, 'teammate'],
  [/\b(habitat|hab|base|home)\b/, 'habitat'],
  [/\b(destination|waypoint|goal|target)\b/, 'destination'],
  [/\b(hazards?|danger|dangerous|unsafe|obstacle)\b/, 'hazard'],
  [/\b(samples?|specimen|science)\b/, 'sample'],
  [/\b(resources?|supply|supplies|equipment|cache|ice|water)\b/, 'resource'],
  [/\b(notes?|other|interesting|point)\b/, 'note'],
];
const tagWord = (t: string) => TAG_WORDS.find(([r]) => r.test(t))?.[1];

/** How speech recognisers tend to hear "TEVAN". Extra spellings learned in the voice check are added at runtime. */
export const WAKE_ALIASES = ['tevan', 'teven', 'tevin', 'tivan', 'tavan', 'taven', 'tavern', 'kevin', 'devon', 'devin', 'evan', 'seven', 'heaven', 't van', 'tee van', 'tea van', 'the van', 'tehran', 'tevon', 'teban', 'tabon', 'tyvan', 'ti van', 'tv on'];
/** Remove a leading "hi TEVAN," / "TEVAN," so "TEVAN, show radiation" parses as "show radiation". */
export function stripWake(t: string, extra: string[] = []): { text: string; woke: boolean } {
  const names = [...extra, ...WAKE_ALIASES].map((a) => a.replace(/[^a-z0-9 ]/g, '')).filter(Boolean).sort((a, b) => b.length - a.length);
  const m = t.match(new RegExp(`^(?:(?:hi|hey|hello|ok|okay|yo|hay|high) )?(?:${names.join('|')})\\b ?`));
  return m ? { text: t.slice(m[0].length).trim(), woke: true } : { text: t, woke: false };
}

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
export function parseCommand(text: string, aliases: string[] = []): Command | null {
  const w = stripWake(normalise(text), aliases);
  const t = w.text;
  if (!t) return w.woke ? { type: 'hello' } : null;
  const has = (re: RegExp) => re.test(t);
  const feature = () => FEATURE_WORDS.find(([r]) => r.test(t))?.[1];
  const deictic = has(/\b(this|that|it|here|these|those)\b/);

  if (has(/\b(stop|pause) listening\b|\bgo to sleep\b|\bmic off\b/)) return { type: 'sleep' };
  if (has(/\b(resume|start) listening\b|\bwake up\b|\bmic on\b/)) return { type: 'wake' };

  // ---- emergencies first: these must never be mistaken for anything else
  if (has(/\b(mayday|s o s|sos|call (for )?help|i need help|send help|help me|emergency call|call (the )?(habitat|base|team))\b/)) return { type: 'emergency', action: 'help' };
  if (has(/\b(back|return|go|take me|head|route|get me|navigate) (back )?(to )?(the )?(habitat|hab|home|base)\b|\babort (the )?(eva|mission)\b|\bgo home\b/) && !has(/\b(drone|scout)\b/)) return { type: 'emergency', action: 'habitat' };
  if (has(/\b(nearest|closest|find|go to|take me to|navigate to|route to)( a| the)?( nearest| closest)? (shelter|cover)\b|\btake cover\b|^shelter$/)) return { type: 'emergency', action: 'shelter' };
  if (has(/\b(cancel|stop|end) (the )?(navigation|guidance|detour|guiding)\b/)) return { type: 'emergency', action: 'cancelNav' };
  if (has(/\b(resume|continue|back to) (the )?(mission|plan|traverse|objectives?)\b/)) return { type: 'emergency', action: 'resume' };
  if (has(/\b(go to|navigate to|take me to|route to|guide me to|find|nearest|closest)( the| a)?( nearest| closest)?( supply)? (cache|supplies|supply station|station|depot)\b/)) return { type: 'emergency', action: 'cache' };
  if (has(/\b(resupply|re supply|refill|restock|top up|get supplies)\b/)) return { type: 'emergency', action: 'resupply' };
  if (/^(rest|rest here|take a rest|i need (a |to )?rest|take a break|take five|i am tired|im tired)$/.test(t) || has(/\brest for\b/)) return { type: 'emergency', action: 'rest' };
  if (/^(emergency|emergencies|emergency menu|quick actions|panic)$/.test(t)) return { type: 'tool', tool: 'emergency' };
  if (has(/\b(stability|stabili[sz]e|stabili[sz]er|brace|suit assist)\b/)) return { type: 'stability', on: has(/\b(off|disable|release|stop|remove)\b/) ? false : has(/\b(on|enable|engage|start|activate)\b/) ? true : undefined };
  if (/^(jump|hop|jump over)$/.test(t)) return { type: 'jump' };
  if (has(/\b(repeat|say (that |it )?again|come again|pardon|what did you say)\b/)) return { type: 'repeat' };
  if (has(/\b(undo|revert|take that back)\b/)) return { type: 'undo' };

  // ---- tags and "what is this" (use the thing under the astronaut's eyes)
  if (has(/\b(remove|delete|clear|erase) (the |that |this |last |my )*(tags?|labels?|markers?)\b/)) return { type: 'removeTag' };
  if (has(/\b(where is|wheres|where s|locate) (my |the )?(teammate|crewmate|buddy|partner|ev ?2|ev two|e v 2|crew)\b/)) return { type: 'tool', tool: 'team' };
  if (has(/\b(go to|navigate to|take me to|guide me to|find|route to) (my |the )?(teammate|crewmate|buddy|partner|ev ?2|ev two|e v 2)\b/)) return { type: 'goTeammate' };
  if (has(/\b(go|navigate|take me|guide me|route|head|walk) (to )?(the |my |that |this )?(last |latest )?(\w+ )?(tag|marker|label|destination)\b|\b(go|take me|guide me|navigate) there\b/)) return { type: 'goTag', kind: has(/\bdestination\b/) ? undefined : tagWord(t.replace(/\b(tag|marker|label)\b/g, '')) };
  if (has(/\b(what is|whats|what s|what are|identify|describe|scan|analy[sz]e|tell me about)\b/) && deictic) return { type: 'whatThis' };
  if (has(/\bwhat am i (looking at|seeing)\b|\bwhat do i see\b/)) return { type: 'whatThis' };
  if (has(/\b(label|tag|pin|flag)\b/) && !has(/\b(show|list|my|open) tags\b/) && t !== 'tags') return { type: 'labelThis', kind: tagWord(t.replace(/\b(label|tag|pin|flag)\b/g, '')) };
  if (has(/\bmark\b/) && deictic) return { type: 'labelThis', kind: tagWord(t) };
  {
    const k = t.match(/^(?:a |an |its a |its an |it is a |it is an |as a |as an |as |the |call it a |call it )?(.+)$/);
    const tw = k && k[1].split(' ').length <= 2 ? TAG_WORDS.find(([r]) => new RegExp(`^${r.source}$`).test(k[1]))?.[1] : undefined;
    if (tw) return { type: 'tagKind', kind: tw };
  }
  if (has(/\bwhere am i\b|\bmy (position|location|coordinates)\b/)) return { type: 'where' };
  if (has(/\b(take|capture|snap|shoot|grab) (a |the )?(photo|picture|image|snapshot|pic)\b/) || /^(photo|picture|snapshot)$/.test(t)) return { type: 'photo' };

  // ---- visor tools
  if (has(/\b(hide|close) (the )?(mission )?log\b/)) return { type: 'logPanel', open: false };
  if (has(/\b(show|open|display|read) (me )?(the )?(mission |event |comms )?(log|timeline|history)\b|\bwhat happened\b/) || /^(log|timeline|history)$/.test(t)) return { type: 'logPanel', open: true };
  if (has(/\b(team|crew) (status|tracker|tracking|positions?)\b/) || /^(team|crew)$/.test(t)) return { type: 'tool', tool: 'team' };
  if (has(/\b(show |list |check )?(supplies|caches|supply (status|caches|stations))\b/)) return { type: 'tool', tool: 'supplies' };
  if (has(/\b(systems?( status| check)?|diagnostics|sensors?|self test)\b/) && !has(/\bsuit status\b/)) return { type: 'tool', tool: 'systems' };
  if (/^(weather|forecast|space weather|conditions|weather report)$/.test(t) || has(/\b(check|show|whats|what is|hows|how is|any) (the )?(weather|forecast|space weather|conditions|storms?)\b|\bstorm (status|update)\b/)) return { type: 'tool', tool: 'weather' };
  if (has(/\b(show|list|my|open) tags\b/) || t === 'tags') return { type: 'tool', tool: 'tags' };
  if (/^(tools|apps|menu|toolbox|more|all features|open tools|show tools)$/.test(t)) return { type: 'tool', tool: 'tools' };
  if (has(/\b(rover|perseverance) (feed|images?|photos?|pictures?|cameras?|raw images?)\b|\b(latest|newest|new) (rover |perseverance |mars )?(images|photos|pictures)\b|\bwhat (is|has) (the )?(rover|perseverance) (seeing|seen|doing)\b/) || /^(rover feed|rover|perseverance)$/.test(t)) return { type: 'tool', tool: 'rover' };

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
  if (has(/\b(voice|mic|microphone) (check|calibration|test)\b|\b(calibrate|recalibrate|check|test) (my |the )?(voice|mic|microphone)\b/)) return { type: 'calibrate', what: 'voice' };
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

export type VoiceState = 'off' | 'listening' | 'hearing' | 'asleep' | 'denied' | 'unsupported' | 'error';

/** Human-readable explanation of a SpeechRecognition error code. */
export const VOICE_ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone permission denied. Click the icon left of the address bar, allow Microphone, reload.',
  'service-not-allowed': 'This browser blocks speech recognition. Use Google Chrome or Microsoft Edge.',
  'audio-capture': 'No microphone found, or another app is using it. Check Windows sound settings.',
  network: 'Speech service unreachable. Chrome/Edge need internet for voice (Brave, Opera and Chromium builds usually fail here).',
  'language-not-supported': 'English (US) speech is not available in this browser.',
};

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
  /** every transcript the recogniser produces (used by the voice check) */
  onHeard: (text: string, final: boolean) => void = () => {};
  /** extra spellings of "TEVAN" learned from this user's voice check */
  aliases: string[] = [];
  /** last sentence TEVAN spoke (for "repeat that") */
  lastSpoken = '';
  /** pitch of TEVAN's replies, set away from the user's own pitch by the voice check */
  replyPitch = 0.95;
  /** live partial transcript */
  onInterim: (text: string) => void = () => {};
  onState: (s: VoiceState) => void = () => {};
  /** smoothed mic activity 0..1 for the UI (from the recognizer's sound events) */
  level = 0;
  /** last error code from the recognizer, for on-screen diagnostics */
  lastError = '';
  onError: (code: string, message: string) => void = () => {};
  private errorCount = 0;

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
        this.onHeard(text, !!r.isFinal);
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
      const code = String(e.error ?? 'unknown');
      if (code === 'no-speech' || code === 'aborted') return; // normal in continuous mode
      console.warn('[TEVAN voice] recognition error:', code, e.message ?? '');
      this.lastError = code;
      this.errorCount++;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.want = false;
        this.set('denied');
      } else if (this.errorCount >= 3 && (code === 'network' || code === 'audio-capture' || code === 'language-not-supported')) {
        this.want = false; // stop the restart loop; the UI explains why
        this.set('error');
      }
      this.onError(code, VOICE_ERRORS[code] ?? `Speech recognition error: ${code}`);
    };
    rec.onstart = () => {
      console.info('[TEVAN voice] listening');
      this.set(this.asleep ? 'asleep' : 'listening');
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
    } catch {
      /* already running */
    }
  }

  start() {
    if (!this.rec) return;
    this.errorCount = 0;
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
    // timer only: Chrome's speechSynthesis.speaking can get stuck at true, which would mute every command
    return performance.now() < this.speakingUntil;
  }

  /** Speak a reply; the recognizer ignores what it hears while this plays. */
  speak(text: string) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.07;
    u.pitch = this.replyPitch;
    this.lastSpoken = text;
    this.speakingUntil = performance.now() + Math.min(9000, 400 + text.length * 65);
    u.onend = () => (this.speakingUntil = performance.now() + 350);
    speechSynthesis.speak(u);
  }
}

/**
 * MIC METER: reads the real microphone level and pitch (Web Audio), independent of the
 * speech recogniser. Used by the "Hi TEVAN" voice check and to drive the live mic indicator.
 */
export class MicMeter {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buf = new Float32Array(2048);
  private stream: MediaStream | null = null;
  /** current level in dBFS (about -90 silence .. 0 clipping) */
  db = -90;
  /** 0..1 for UI meters */
  level = 0;
  /** room noise floor measured by the voice check, dBFS */
  noiseDb = -60;
  ready = false;
  error = '';

  async start(): Promise<boolean> {
    if (this.ready) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AC();
      const src = this.ctx!.createMediaStreamSource(this.stream);
      this.analyser = this.ctx!.createAnalyser();
      this.analyser.fftSize = 2048;
      src.connect(this.analyser);
      this.ready = true;
      return true;
    } catch (e: any) {
      this.error = String(e?.name ?? e);
      return false;
    }
  }
  /** Call once per frame. */
  sample() {
    if (!this.analyser) return this.db;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    this.db = 20 * Math.log10(Math.max(rms, 1e-5));
    const l = Math.max(0, Math.min(1, (this.db - this.noiseDb - 4) / 30));
    this.level += (l - this.level) * 0.35;
    return this.db;
  }
  /** Fundamental frequency of the current frame (autocorrelation), or null when unvoiced. */
  pitch(): number | null {
    if (!this.ctx || !this.analyser) return null;
    const b = this.buf;
    const sr = this.ctx.sampleRate;
    const n = b.length;
    let e0 = 0;
    for (let i = 0; i < n; i++) e0 += b[i] * b[i];
    if (e0 / n < 1e-5) return null;
    const minLag = Math.floor(sr / 400);
    const maxLag = Math.min(n - 1, Math.floor(sr / 70));
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i < n - lag; i++) c += b[i] * b[i + lag];
      c /= e0;
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    return best > 0.45 && bestLag ? sr / bestLag : null;
  }
  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ready = false;
    this.analyser = null;
  }
}
