/**
 * VOICE COMMANDS (Web Speech API) with a typed fallback.
 * The same parser handles speech and the command bar, so demos never
 * depend on the browser's speech support.
 */
export interface CommandHandlers {
  toggleLayer(layer: string): string;
  reroute(): string;
  markSample(): string;
  vitals(): string;
  drone(): string;
  mode(): string;
  pace(p?: string): string;
  hold(): string;
  map(): string;
  help(): string;
}

const LAYER_WORDS: Record<string, string> = {
  radiation: 'radiation',
  dose: 'radiation',
  slope: 'slope',
  slopes: 'slope',
  poi: 'poi',
  points: 'poi',
  sites: 'poi',
  dust: 'dust',
  magnetic: 'mag',
  mag: 'mag',
  field: 'mag',
  fog: 'fog',
};

export function parseCommand(text: string, h: CommandHandlers): { ok: boolean; reply: string } {
  const t = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, reply: '' };
  const has = (...w: string[]) => w.some((x) => new RegExp(`\\b${x}\\b`).test(t));
  if (has('toggle', 'show', 'hide', 'layer', 'overlay')) {
    for (const [w, id] of Object.entries(LAYER_WORDS)) if (has(w)) return { ok: true, reply: h.toggleLayer(id) };
  }
  if (has('reroute', 're route', 'alternate', 'accept')) return { ok: true, reply: h.reroute() };
  if (has('mark', 'sample', 'collect')) return { ok: true, reply: h.markSample() };
  if (has('vitals', 'status', 'health', 'oxygen', 'how am i')) return { ok: true, reply: h.vitals() };
  if (has('drone', 'scout')) return { ok: true, reply: h.drone() };
  if (has('ar', 'vr', 'augmented', 'mode', 'camera')) return { ok: true, reply: h.mode() };
  if (has('slow', 'fast', 'nominal', 'pace')) return { ok: true, reply: h.pace(has('slow') ? 'slow' : has('fast') ? 'fast' : has('nominal') ? 'nominal' : undefined) };
  if (has('hold', 'stop', 'resume', 'go', 'continue')) return { ok: true, reply: h.hold() };
  if (has('map', 'plan')) return { ok: true, reply: h.map() };
  if (has('help', 'commands')) return { ok: true, reply: h.help() };
  // bare layer names
  for (const [w, id] of Object.entries(LAYER_WORDS)) if (has(w)) return { ok: true, reply: h.toggleLayer(id) };
  return { ok: false, reply: `Not understood: "${text}"` };
}

export class Voice {
  private rec: any = null;
  listening = false;
  supported: boolean;
  onResult: (text: string) => void = () => {};
  onState: (listening: boolean) => void = () => {};

  constructor() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.supported = !!SR;
    if (SR) {
      this.rec = new SR();
      this.rec.lang = 'en-US';
      this.rec.interimResults = false;
      this.rec.maxAlternatives = 3;
      this.rec.onresult = (e: any) => {
        const alts = [...e.results[e.results.length - 1]].map((a: any) => a.transcript);
        this.onResult(alts[0] ?? '');
      };
      this.rec.onend = () => {
        this.listening = false;
        this.onState(false);
      };
      this.rec.onerror = () => {
        this.listening = false;
        this.onState(false);
      };
    }
  }

  start() {
    if (!this.rec || this.listening) return;
    try {
      this.rec.start();
      this.listening = true;
      this.onState(true);
    } catch {
      /* already started */
    }
  }
  stop() {
    if (this.rec && this.listening) this.rec.stop();
  }

  speak(text: string) {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 0.95;
    speechSynthesis.speak(u);
  }
}
