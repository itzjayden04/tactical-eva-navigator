/**
 * AUDIO: named sound slots. Drop Suno-generated files into
 * `public/audio/<slot>.mp3` and they replace the synthesized placeholder.
 * See AUDIO.md for the Suno prompt for each slot.
 */
export type Slot =
  | 'music_bed'
  | 'ambient_wind'
  | 'suit_breathing'
  | 'plss_hum'
  | 'dust_storm'
  | 'spe_geiger'
  | 'drone_rotor'
  | 'alert_caution'
  | 'alert_warning'
  | 'alert_emergency'
  | 'reroute_chime'
  | 'sample_collect'
  | 'ui_click'
  | 'voice_ack'
  | 'gaze_lock'
  | 'island_open'
  | 'quake_rumble'
  | 'body_thud'
  | 'jump'
  | 'tag_set'
  | 'camera_shutter'
  | 'mayday';

const LOOPS: Slot[] = ['music_bed', 'ambient_wind', 'suit_breathing', 'plss_hum', 'dust_storm', 'spe_geiger', 'drone_rotor', 'quake_rumble'];

export class Audio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private buffers = new Map<Slot, AudioBuffer>();
  private loops = new Map<Slot, { gain: GainNode; src: AudioScheduledSourceNode | null; rate?: AudioParam }>();
  muted = false;

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(this.ctx.destination);
    await Promise.all(
      ([...LOOPS, 'alert_caution', 'alert_warning', 'alert_emergency', 'reroute_chime', 'sample_collect', 'ui_click', 'voice_ack', 'gaze_lock', 'island_open', 'body_thud', 'jump', 'tag_set', 'camera_shutter', 'mayday'] as Slot[]).map(async (s) => {
        try {
          const r = await fetch(`./audio/${s}.mp3`);
          if (!r.ok || !(r.headers.get('content-type') ?? '').includes('audio')) return;
          this.buffers.set(s, await this.ctx!.decodeAudioData(await r.arrayBuffer()));
        } catch {
          /* fall back to synth */
        }
      }),
    );
    for (const s of LOOPS) this.startLoop(s);
  }

  private noiseBuffer(seconds = 2) {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  private startLoop(slot: Slot) {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    const file = this.buffers.get(slot);
    if (file) {
      const src = ctx.createBufferSource();
      src.buffer = file;
      src.loop = true;
      src.connect(gain);
      src.start();
      this.loops.set(slot, { gain, src, rate: src.playbackRate });
      return;
    }
    // synthesized placeholders
    if (slot === 'ambient_wind' || slot === 'dust_storm' || slot === 'suit_breathing') {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = slot === 'suit_breathing' ? 'bandpass' : 'lowpass';
      f.frequency.value = slot === 'ambient_wind' ? 380 : slot === 'dust_storm' ? 900 : 1200;
      f.Q.value = slot === 'suit_breathing' ? 0.8 : 0.5;
      src.connect(f);
      if (slot === 'suit_breathing') {
        const amp = ctx.createGain();
        amp.gain.value = 0;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.25;
        const lg = ctx.createGain();
        lg.gain.value = 0.5;
        lfo.connect(lg).connect(amp.gain);
        lfo.start();
        f.connect(amp).connect(gain);
        this.loops.set(slot, { gain, src, rate: lfo.frequency });
      } else {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.07;
        const lg = ctx.createGain();
        lg.gain.value = 160;
        lfo.connect(lg).connect(f.frequency);
        lfo.start();
        f.connect(gain);
        this.loops.set(slot, { gain, src });
      }
      src.start();
      return;
    }
    if (slot === 'plss_hum' || slot === 'drone_rotor' || slot === 'music_bed' || slot === 'quake_rumble') {
      const freqs = slot === 'quake_rumble' ? [27, 33, 41] : slot === 'plss_hum' ? [58, 116] : slot === 'drone_rotor' ? [92, 184] : [55, 82.4, 110, 164.8];
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = slot === 'music_bed' ? 600 : 500;
      f.connect(gain);
      for (const fr of freqs) {
        const o = ctx.createOscillator();
        o.type = slot === 'drone_rotor' ? 'sawtooth' : slot === 'music_bed' ? 'triangle' : 'sine';
        o.frequency.value = fr;
        o.detune.value = (Math.random() - 0.5) * 12;
        const og = ctx.createGain();
        og.gain.value = 1 / freqs.length;
        o.connect(og).connect(f);
        o.start();
      }
      this.loops.set(slot, { gain, src: null });
      return;
    }
    if (slot === 'spe_geiger') {
      // random clicks via a script-free scheduled approach
      const g2 = gain;
      const tick = () => {
        if (!this.ctx) return;
        const level = g2.gain.value;
        if (level > 0.01) {
          const o = ctx.createOscillator();
          const e = ctx.createGain();
          o.type = 'square';
          o.frequency.value = 2400;
          e.gain.setValueAtTime(0.6, ctx.currentTime);
          e.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.01);
          o.connect(e).connect(g2);
          o.start();
          o.stop(ctx.currentTime + 0.02);
        }
        setTimeout(tick, 20 + Math.random() * (level > 0.01 ? 120 / (level * 4 + 0.2) : 300));
      };
      tick();
      this.loops.set(slot, { gain, src: null });
    }
  }

  setLevel(slot: Slot, level: number, rate?: number) {
    const l = this.loops.get(slot);
    if (!l || !this.ctx) return;
    l.gain.gain.setTargetAtTime(this.muted ? 0 : level, this.ctx.currentTime, 0.4);
    if (rate !== undefined && l.rate) l.rate.setTargetAtTime(rate, this.ctx.currentTime, 0.5);
  }

  play(slot: Slot) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const file = this.buffers.get(slot);
    if (file) {
      const s = ctx.createBufferSource();
      s.buffer = file;
      s.connect(this.master);
      s.start();
      return;
    }
    const beep = (freq: number, at: number, dur: number, type: OscillatorType = 'sine', vol = 0.25) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, ctx.currentTime + at);
      g.gain.linearRampToValueAtTime(vol, ctx.currentTime + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + dur);
      o.connect(g).connect(this.master);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + dur + 0.05);
    };
    if (slot === 'alert_caution') [0, 0.25].forEach((t) => beep(880, t, 0.18));
    else if (slot === 'alert_warning') [0, 0.18, 0.36].forEach((t) => beep(1046, t, 0.14, 'triangle'));
    else if (slot === 'alert_emergency') for (let i = 0; i < 6; i++) beep(i % 2 ? 740 : 1180, i * 0.16, 0.14, 'square', 0.15);
    else if (slot === 'reroute_chime') {
      beep(660, 0, 0.3);
      beep(990, 0.15, 0.45);
    } else if (slot === 'sample_collect') {
      beep(523, 0, 0.2);
      beep(659, 0.12, 0.2);
      beep(784, 0.24, 0.35);
    } else if (slot === 'ui_click') beep(1600, 0, 0.04, 'square', 0.06);
    else if (slot === 'voice_ack') beep(1250, 0, 0.07, 'sine', 0.08);
    else if (slot === 'gaze_lock') beep(2100, 0, 0.025, 'sine', 0.035);
    else if (slot === 'island_open') beep(520, 0, 0.14, 'sine', 0.07);
    else if (slot === 'body_thud') {
      beep(70, 0, 0.35, 'sine', 0.6);
      beep(45, 0.03, 0.4, 'triangle', 0.4);
    } else if (slot === 'jump') beep(180, 0, 0.12, 'sine', 0.12);
    else if (slot === 'tag_set') {
      beep(1320, 0, 0.08, 'triangle', 0.14);
      beep(1760, 0.07, 0.16, 'triangle', 0.14);
    } else if (slot === 'camera_shutter') {
      beep(3200, 0, 0.03, 'square', 0.08);
      beep(2100, 0.06, 0.04, 'square', 0.08);
    } else if (slot === 'mayday') for (let i = 0; i < 3; i++) beep(1400, i * 0.3, 0.22, 'square', 0.14);
  }

  setMuted(m: boolean) {
    if (m !== this.muted) this.toggleMute();
    return this.muted;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.7, this.ctx.currentTime, 0.1);
    return this.muted;
  }
}
