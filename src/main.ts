import { selectProvider } from './data';
import type { DataBundle } from './data/types';
import { toLatLon } from './data/types';
import { Sim } from './core/sim';
import { World } from './render/scene';
import { Hud, fmtDur, fmtMET, FEATURE_LABEL, TAG_ACTS, km, esc } from './ui/hud';
import { TacticalMap, LayerId, LAYER_INFO } from './ui/map';
import { drawChart } from './ui/chart';
import { Audio } from './ui/audio';
import { Voice, MicMeter, parseCommand, normalise, WAKE_ALIASES, Command, FeatureId, VOICE_ERRORS } from './ui/voice';
import { Guardian, TAG_INFO, bearingWord, type Pick, type TagKind } from './core/guardian';
import { GazeTracker } from './ui/gaze';
import { HoloLabels, identifiable } from './ui/holo';
import { MapNav } from './ui/mapnav';
import { enrol, verify, type VoiceFrame, type VoicePrint } from './ui/voiceprint';
import { understand, yesNo, RUN_AT, type Understood } from './ui/intent';
import { Targeting } from './ui/targets';
import { RESERVE_FRAC } from './core/health';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FEATURES: string[] = ['mission', 'o2', 'h2o', 'power', 'dose', 'fatigue', 'map', 'route', 'drone', 'sample', 'layers', 'tools', 'emergency', 'team', 'supplies', 'systems', 'weather', 'tags', 'log'];

async function boot() {
  const provider = selectProvider();
  let data: DataBundle;
  try {
    data = await provider.load();
  } catch (e) {
    $('loading').innerHTML = `<div class="loader">DATA LOAD FAILED<br/><span class="dim">${esc(String(e))}</span></div>`;
    return;
  }
  const sim = new Sim(data);
  const world = new World($('viewport'), data, sim);
  const hud = new Hud(data, sim, world);
  const audio = new Audio();
  const voice = new Voice();
  const gaze = new GazeTracker();
  const targets = new Targeting();
  const guardian = new Guardian(sim);
  const meter = new MicMeter();
  world.attachGuardian(guardian);
  hud.guardian = guardian;
  const holo = new HoloLabels($('holo-layer'), world, guardian);
  hud.map.guardian = guardian;
  (window as any).__tevan = { sim, world, hud, voice, gaze, targets, guardian, meter, get holo() { return holo; } };

  // ---------------------------------------------------------------- pre-egress screen
  const m = data.mission;
  $('brief-title').textContent = m.title;
  $('brief-subtitle').textContent = m.subtitle;
  const habNode = sim.world.nodes.get(m.startNodeId)!;
  $('brief-objectives').innerHTML = m.objectives
    .map((o) => {
      const node = sim.world.nodes.get(o.nodeId)!;
      const d = Math.hypot(node.e - habNode.e, node.n - habNode.n);
      return `<li><span>${esc(o.label)}</span><em>${o.kind === 'return' ? 'before 20% reserve' : km(d)}</em></li>`;
    })
    .join('');
  const c = m.consumables;
  $('brief-consumables').innerHTML = [
    ['O₂', `${c.o2g} g`],
    ['H₂O', `${(c.waterg / 1000).toFixed(1)} kg`],
    ['Battery', `${c.battWh} Wh`],
    ['Dose budget', `${c.doseBudgetmSv} mSv`],
  ]
    .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
    .join('');
  const cond = data.conditions;
  const lm = `${String(Math.floor(m.startLmstH)).padStart(2, '0')}:${String(Math.round((m.startLmstH % 1) * 60)).padStart(2, '0')}`;
  $('brief-conditions').textContent = `Sol ${m.sol} · ${lm} LMST · ${cond.surfaceTempC} °C · dust τ ${cond.dustTau} · GCR ${cond.gcrDoseRateuSvH} µSv/h · SPE watch`;
  const briefMap = new TacticalMap(data, sim);
  briefMap.guardian = guardian;
  briefMap.layers.fog = false;
  briefMap.layers.radiation = data.source !== 'nasa'; // real data: show the HiRISE photo + rover route instead
  briefMap.onBase = () => briefMap.draw($('brief-map') as HTMLCanvasElement, { t: 0, large: true });
  const chk = (id: string, cls: string, text: string) => {
    const el = $(id);
    el.className = cls;
    el.lastChild!.textContent = text;
  };
  chk('chk-mic', voice.supported ? '' : 'bad', voice.supported ? 'Voice · microphone' : 'Voice needs Chrome or Edge (type with Enter)');
  chk('chk-cam', gaze.supported ? '' : 'bad', gaze.supported ? 'Gaze · camera' : 'No camera API: pointer stands in for gaze');
  if (!window.isSecureContext) {
    chk('chk-mic', 'bad', 'Open via http://localhost or https:// for mic');
    chk('chk-cam', 'bad', 'Open via http://localhost or https:// for camera');
  }
  console.info('[TEVAN] secure context:', window.isSecureContext, '· speech API:', voice.supported, '· camera API:', gaze.supported, '·', navigator.userAgent);
  $('loading').classList.add('hidden');
  $('briefing').classList.remove('hidden');
  requestAnimationFrame(() => briefMap.draw($('brief-map') as HTMLCanvasElement, { t: 0, large: true }));

  // ---------------------------------------------------------------- voice capsule (secondary island)
  const capsule = $('voice-capsule');
  const transcript = $('voice-transcript');
  let capsuleTimer = 0;
  const setCapsule = (cls: string, text = '', ttl = 0) => {
    capsule.className = cls;
    transcript.textContent = text;
    clearTimeout(capsuleTimer);
    if (ttl) capsuleTimer = window.setTimeout(() => setCapsule(voiceIdleClass()), ttl);
  };
  const voiceIdleClass = () => (voice.state === 'denied' ? 'err' : voice.state === 'asleep' ? 'asleep' : voice.state === 'listening' || voice.state === 'hearing' ? 'listening' : 'idle');
  voice.onState = (s) => {
    if (s === 'denied') setCapsule('err', VOICE_ERRORS[voice.lastError] ?? 'Microphone blocked');
    else if (s === 'error') setCapsule('err', VOICE_ERRORS[voice.lastError] ?? 'Voice unavailable');
    else if (s !== 'hearing' && !capsule.classList.contains('ok') && !capsule.classList.contains('miss')) setCapsule(voiceIdleClass());
    if (s !== 'denied' && s !== 'error') chk('chk-mic', s === 'listening' ? 'ok' : '', s === 'listening' ? 'Voice · listening' : 'Voice · microphone');
  };
  voice.onError = (code, msg) => {
    setCapsule('err', msg, code === 'network' || code === 'audio-capture' ? 0 : 6000);
    chk('chk-mic', 'bad', msg);
    if (sim.status === 'active') hud.notify(msg, 'mic_off', 8);
  };
  voice.onInterim = (t) => {
    if (voice.asleep) return;
    setCapsule('hearing', t);
  };
  /** TEVAN answers out loud; every spoken line is also written to the log (traceability, "repeat that"). */
  const speak = (text: string) => {
    guardian.record('tevan', text);
    guardian.lastSaid = text;
    voice.speak(text);
  };
  sim.on('say', (m: { text: string; who: string }) => voice.speak(m.text));
  // alarms and chimes are not speech: don't let the recogniser turn them into words
  audio.onPlay = (slot) => voice.ignoreFor(slot.startsWith('alert') ? 1400 : 700);
  // ---------------------------------------------------------------- understanding speech (grammar first, then intent)
  // ---------------------------------------------------------------- voice match (only the enrolled astronaut's voice)
  /** voiced mic frames of the last few seconds (never frames captured while TEVAN talks) */
  const vframes: VoiceFrame[] = [];
  let vprint: VoicePrint | null = null;
  let voiceLock = true;
  let voiceRejects = 0;
  let lastPitchAt = 0;
  const captureVoice = (now: number) => {
    if (!meter.ready) return;
    meter.sample();
    while (vframes.length && now - vframes[0].t > 6000) vframes.shift();
    if (voice.isSpeaking() || meter.db < meter.noiseDb + 10) return;
    const shape = meter.shape();
    if (!shape) return;
    let pitch: number | null = null;
    if (now - lastPitchAt > 45) {
      lastPitchAt = now;
      pitch = meter.pitch();
    }
    vframes.push({ t: now, shape, pitch });
  };
  /** true when this spoken command may run (sounds like the enrolled voice, or nothing to compare) */
  const voiceAllowed = (t: string): boolean => {
    if (!voiceLock || !vprint) return true;
    const now = performance.now();
    const m = verify(vprint, vframes.filter((f) => now - f.t < 4000));
    console.info(`[TEVAN voice match] "${t}" ${m.accept ? 'accepted' : 'REJECTED'} · timbre ${m.timbre.toFixed(2)} · pitch ${m.semitones === null ? 'n/a' : m.semitones.toFixed(1) + ' st'} · ${m.frames} frames · ${m.reason}`);
    if (m.accept) {
      voiceRejects = 0;
      return true;
    }
    voiceRejects++;
    setCapsule('miss', voiceRejects >= 3 ? `Ignored, ${m.reason}. Not you? Type “voice check” to re-enrol, or “voice lock off”` : `Ignored “${t}”: ${m.reason}`, voiceRejects >= 3 ? 7000 : 2600);
    if (sim.status === 'active') sim.addLog({ kind: 'info', title: 'Voice command ignored', severity: 'info', outcome: `“${t}”: ${m.reason}` });
    return false;
  };
  /** a "Did you mean …?" question waiting for yes / no */
  let pendingIntent: { u: Understood; until: number } | null = null;
  const runUnderstood = (u: Understood, source: 'voice' | 'typed') => {
    if (sim.status === 'active') guardian.record('you', u.heard);
    const reply = exec(u.cmd, source);
    // show what TEVAN understood when it went by meaning, so the astronaut can trust (or correct) it
    setCapsule('ok', u.via === 'intent' ? `≈ ${u.label} · ${reply.text || u.heard}` : reply.text || u.heard, 2800);
    if (u.via === 'intent') console.info(`[TEVAN intent] "${u.heard}" → ${u.intent} (${Math.round(u.confidence * 100)}%)${u.fixes.length ? ' fixed: ' + u.fixes.join(', ') : ''}`);
    audio.play('voice_ack');
    if (reply.speak) speak(reply.speak);
    else if (reply.text && sim.status === 'active') guardian.record('tevan', reply.text);
  };
  const handleUtterance = (alts: string[], source: 'voice' | 'typed') => {
    const t = alts[0] ?? '';
    // typed commands are always trusted; spoken ones must sound like the enrolled astronaut
    if (source === 'voice' && !voiceAllowed(t)) return;
    if (pendingIntent && performance.now() < pendingIntent.until) {
      const yn = yesNo(t);
      if (yn) {
        const p = pendingIntent;
        pendingIntent = null;
        if (yn === 'yes') runUnderstood(p.u, source);
        else {
          setCapsule('miss', 'Cancelled', 1600);
          if (source === 'voice') voice.speak('Okay.');
        }
        return;
      }
    }
    pendingIntent = null;
    const u = understand(alts, voice.aliases);
    if (source === 'voice' && voice.asleep && u?.cmd.type !== 'wake') return;
    if (!u) {
      setCapsule('miss', source === 'typed' ? `Not understood: ${t}` : t, 1800);
      return;
    }
    if (u.confidence < RUN_AT) {
      pendingIntent = { u, until: performance.now() + 12000 };
      const q = u.runnerUp ? `Did you mean “${u.label}” or “${u.runnerUp.label}”?` : `Did you mean “${u.label}”?`;
      setCapsule('ask', `${q} Say yes or no`, 12000);
      if (source === 'voice') voice.speak(`Did you mean ${u.label.toLowerCase()}?`);
      return;
    }
    runUnderstood(u, source);
  };
  voice.onFinal = (t, alts) => {
    if (voiceCheck) return; // the "Hi TEVAN" check is listening, not the command parser
    handleUtterance(alts.length ? alts : [t], 'voice');
  };

  // ---------------------------------------------------------------- gaze
  let pointer: { x: number; y: number } | null = null;
  window.addEventListener('pointermove', (e) => (pointer = { x: e.clientX, y: e.clientY }));
  document.addEventListener('pointerleave', () => (pointer = null));
  const gazeLive = () => gaze.state === 'tracking' || gaze.state === 'noface';
  gaze.onState = (s) => {
    chk('chk-cam', s === 'denied' || s === 'error' ? 'bad' : s === 'tracking' ? 'ok' : '', s === 'denied' || s === 'error' ? gaze.lastError || 'Gaze unavailable: pointer stands in' : s === 'tracking' ? 'Gaze · face locked' : s === 'starting' ? 'Gaze · starting camera' : s === 'noface' ? 'Gaze · looking for your face' : 'Gaze · camera');
    document.body.classList.toggle('gaze-on', gazeLive());
    if (sim.status === 'active' && (s === 'denied' || s === 'error')) hud.notify(gaze.lastError || 'Gaze unavailable: pointer stands in for your eyes', 'visibility_off', 8);
  };
  let lastLockSound = 0;
  targets.onLock = (t) => {
    if (t && performance.now() - lastLockSound > 250) {
      audio.play('gaze_lock');
      lastLockSound = performance.now();
    }
  };

  // ---------------------------------------------------------------- calibration
  let calibrating = false;
  const preview = $('calib-preview') as HTMLCanvasElement;
  const drawPreview = () => {
    const g = preview.getContext('2d')!;
    g.save();
    g.scale(-1, 1);
    g.drawImage(gaze.video, -preview.width, 0, preview.width, preview.height);
    g.restore();
    const lmk = gaze.landmarks;
    if (lmk) {
      g.fillStyle = '#7ef9c1';
      for (const i of [468, 473, 33, 133, 362, 263, 1]) {
        const p = lmk[i];
        g.beginPath();
        g.arc((1 - p.x) * preview.width, p.y * preview.height, i >= 468 ? 2.6 : 1.4, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
  let skipCalib = false;
  let voiceCheck = false;
  $('calib-skip').onclick = () => (skipCalib = true);
  const FAST = new URLSearchParams(location.search).has('skipchecks');
  const med = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] ?? 0;
  /** wait, but return early (true) if the person pressed Skip */
  const waitOrSkip = async (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end && !skipCalib) await sleep(30);
    return skipCalib;
  };
  const countdown = async () => {
    const c = $('calib-count');
    for (const n of ['3', '2', '1']) {
      c.textContent = n;
      c.classList.remove('tick');
      void c.offsetWidth;
      c.classList.add('tick');
      audio.play('ui_click');
      if (await waitOrSkip(1000)) break;
    }
    c.textContent = '';
    c.classList.remove('tick');
  };
  const runCalibration = async (): Promise<number | null> => {
    calibrating = true;
    skipCalib = false;
    const scr = $('calib');
    const dot = $('calib-dot');
    const txt = $('calib-text');
    scr.classList.remove('hidden', 'running');
    $('calib-voice').classList.add('hidden');
    $('calib-cam').classList.remove('hidden');
    let alive = true;
    const pv = () => {
      if (!alive) return;
      if (gaze.video.readyState >= 2) drawPreview();
      requestAnimationFrame(pv);
    };
    pv();
    dot.style.opacity = '0';
    $('calib-title').textContent = 'Gaze calibration';
    txt.textContent = 'Looking for your face. Sit about an arm’s length from the screen, face lit from the front.';
    const t0 = performance.now();
    while (gaze.state !== 'tracking' && performance.now() - t0 < 15000 && !skipCalib) {
      if (gaze.state === 'denied' || gaze.state === 'error') break;
      await sleep(100);
    }
    let result: number | null = null;
    if (gaze.state === 'tracking' && !skipCalib) {
      $('calib-title').textContent = 'Get ready';
      txt.textContent = 'Face found. Keep your head still and follow the dot with your eyes only. 13 dots, about 25 seconds.';
      await countdown();
    }
    if (gaze.state === 'tracking' && !skipCalib) {
      $('calib-title').textContent = 'Follow the dot';
      txt.textContent = 'Eyes only. Blinking is fine.';
      scr.classList.add('running');
      const W = window.innerWidth;
      const H = window.innerHeight;
      // centre first, then the rim, with four inner points: 13 dots
      const F: [number, number][] = [[0.5, 0.5], [0.08, 0.12], [0.5, 0.1], [0.92, 0.12], [0.72, 0.3], [0.93, 0.5], [0.92, 0.88], [0.72, 0.7], [0.5, 0.9], [0.08, 0.88], [0.28, 0.7], [0.07, 0.5], [0.28, 0.3]];
      gaze.beginCalibration();
      dot.style.opacity = '1';
      for (const [fx, fy] of F) {
        if (skipCalib) break;
        const x = fx * W;
        const y = fy * H;
        dot.style.transform = `translate(${x}px, ${y}px)`;
        dot.classList.remove('collect');
        await sleep(720); // let the eyes land and settle before sampling
        dot.classList.add('collect');
        const end = performance.now() + 880;
        while (performance.now() < end) {
          gaze.addCalibrationSample(x, y);
          await sleep(30);
        }
      }
      result = skipCalib ? null : gaze.finishCalibration();
      let line = '';
      if (result !== null) {
        // validation: three dots it has not seen; their mean miss is removed as a constant offset
        $('calib-title').textContent = 'Checking accuracy';
        const res: [number, number][] = [];
        for (const [fx, fy] of [[0.3, 0.42], [0.7, 0.58], [0.5, 0.76]] as [number, number][]) {
          if (skipCalib) break;
          const x = fx * W;
          const y = fy * H;
          dot.style.transform = `translate(${x}px, ${y}px)`;
          dot.classList.remove('collect');
          await sleep(700);
          dot.classList.add('collect');
          const xs: number[] = [];
          const ys: number[] = [];
          const end = performance.now() + 650;
          while (performance.now() < end) {
            const r = gaze.rawPoint();
            if (r) {
              xs.push(r.x);
              ys.push(r.y);
            }
            await sleep(30);
          }
          if (xs.length > 4) res.push([med(xs) - x, med(ys) - y]);
        }
        if (res.length >= 2) {
          const mx = res.reduce((a, r) => a + r[0], 0) / res.length;
          const my = res.reduce((a, r) => a + r[1], 0) / res.length;
          gaze.applyBias(mx, my);
          result = res.reduce((a, r) => a + Math.hypot(r[0] - mx, r[1] - my), 0) / res.length;
          gaze.accuracyPx = result;
        }
        const q = result < 90 ? 'Good' : result < 170 ? 'Fair' : 'Low';
        line = `${q} accuracy: about ${Math.round(result)} px on unseen points.${q === 'Low' ? ' Light your face from the front, keep your head still, then say “calibrate” to redo.' : ' Look at a feature and say “launch this”.'}`;
      }
      dot.style.opacity = '0';
      scr.classList.remove('running');
      $('calib-title').textContent = result === null ? 'Calibration incomplete' : 'Gaze calibrated';
      txt.textContent = result === null ? 'Not enough clean samples. Using head pointing instead. Say “calibrate” to try again.' : line;
      if (result === null) gaze.recentre();
      await waitOrSkip(2200);
    } else if (!skipCalib) {
      $('calib-title').textContent = 'Gaze unavailable';
      txt.textContent = gaze.lastError || (gaze.state === 'noface' ? 'Camera is on but no face was found. Face the camera with light in front of you, then say “calibrate”.' : gaze.state === 'starting' ? 'The eye-tracking model is still loading. Say “calibrate” in a moment.' : 'The pointer will stand in for your eyes.');
      await waitOrSkip(4000);
    }
    alive = false;
    scr.classList.add('hidden');
    calibrating = false;
    return result;
  };

  /**
   * Voice check: "Hi TEVAN". Measures the room noise and the person's speaking level and pitch
   * from the real microphone, and learns how the browser's recogniser spells "TEVAN" for this
   * voice, so the wake word works for them. (Browsers do not allow training the recogniser itself.)
   */
  const runVoiceCheck = async () => {
    calibrating = true;
    voiceCheck = true;
    skipCalib = false;
    const scr = $('calib');
    const txt = $('calib-text');
    scr.classList.remove('hidden', 'running');
    $('calib-dot').style.opacity = '0';
    $('calib-cam').classList.add('hidden');
    $('calib-voice').classList.remove('hidden');
    $('calib-heard').textContent = '';
    $('calib-title').textContent = 'Voice check';
    txt.textContent = 'Stay quiet for a moment while TEVAN measures the room noise.';
    const ok = await meter.start();
    const bar = $('calib-meter').firstElementChild as HTMLElement;
    const mark = $('calib-meter').lastElementChild as HTMLElement;
    const pct = (db: number) => `${Math.max(0, Math.min(1, (db + 75) / 65)) * 100}%`;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      meter.sample();
      bar.style.width = ok ? pct(meter.db) : '0%';
      requestAnimationFrame(loop);
    };
    loop();
    const noise: number[] = [];
    let t0 = performance.now();
    while (performance.now() - t0 < 1100 && !skipCalib) {
      noise.push(meter.db);
      await sleep(40);
    }
    if (ok && noise.length > 5) meter.noiseDb = med(noise);
    mark.style.left = pct(meter.noiseDb + 10);
    txt.textContent = 'Now say “Hi TEVAN” in your normal voice.';
    let heard = '';
    let finalAt = 0;
    voice.onHeard = (t, f) => {
      heard = t;
      $('calib-heard').innerHTML = `Heard: <b>${esc(t)}</b>`;
      if (f) finalAt = performance.now();
    };
    const speech: number[] = [];
    const pitches: number[] = [];
    const enrolFrames: VoiceFrame[] = [];
    let lastLoud = 0;
    t0 = performance.now();
    while (performance.now() - t0 < 9000 && !skipCalib) {
      const now = performance.now();
      if (ok && meter.db > meter.noiseDb + 10) {
        speech.push(meter.db);
        const p = meter.pitch();
        if (p) pitches.push(p);
        const shape = meter.shape();
        if (shape) enrolFrames.push({ t: now, shape, pitch: p });
        lastLoud = now;
      }
      if (finalAt && now - finalAt > 450) break;
      const noText = !voice.supported || voice.state === 'denied' || voice.state === 'error';
      if (noText && speech.length > 12 && now - lastLoud > 900) break;
      await sleep(30);
    }
    voice.onHeard = () => {};
    const speechDb = speech.length > 6 ? [...speech].sort((a, b) => a - b)[Math.floor(speech.length * 0.8)] : null;
    const snr = speechDb !== null ? speechDb - meter.noiseDb : null;
    const pitch = pitches.length >= 4 ? med(pitches) : null;
    let learned = '';
    const name = normalise(heard).replace(/^(hi|hey|hello|high|hay|ok|okay|hi there) /, '').trim();
    if (name && name.split(' ').length <= 2 && !WAKE_ALIASES.includes(name) && !parseCommand(name)) {
      voice.aliases.push(name);
      learned = name;
    }
    if (pitch) voice.replyPitch = pitch < 165 ? 1.2 : 0.8;
    const vp = enrol(enrolFrames);
    if (vp) vprint = vp;
    const lines: string[] = [];
    if (heard) lines.push(`Heard “${heard}”.${learned ? ` TEVAN will also answer to “${learned}” for your voice.` : ''}`);
    else if (!voice.supported) lines.push('This browser has no speech recognition. Use Chrome or Edge, or press Enter to type commands.');
    else lines.push(VOICE_ERRORS[voice.lastError] ?? 'No words came back from the recogniser. The bubble beside the top pill shows what TEVAN hears during the EVA.');
    if (snr !== null) lines.push(`Your voice is ${snr.toFixed(0)} dB above the room noise: ${snr >= 20 ? 'clear' : snr >= 12 ? 'usable, speak up a little' : 'weak, move closer or use a headset'}.`);
    else if (!ok) lines.push('Could not read the microphone level.');
    if (vp) lines.push('Voiceprint saved: spoken commands are now only taken in your voice (typed commands always work).');
    if (pitch) lines.push(`Pitch about ${pitch.toFixed(0)} Hz, so TEVAN replies in a ${pitch < 165 ? 'higher' : 'lower'} voice that is easy to tell apart from yours.`);
    $('calib-title').textContent = heard ? 'Voice check complete' : speechDb !== null ? 'Voice level measured' : 'No voice detected';
    txt.textContent = lines.join(' ');
    const profile = { heard, learnedAlias: learned, noiseDb: Math.round(meter.noiseDb), speechDb: speechDb === null ? null : Math.round(speechDb), pitchHz: pitch ? Math.round(pitch) : null, voiceprintFrames: vp?.frames ?? 0 };
    sim.extra.voiceCheck = profile;
    console.info('[TEVAN voice check]', profile);
    if (heard) voice.speak('Hi. I hear you. Voice check complete.');
    await waitOrSkip(heard ? 3200 : 4200);
    alive = false;
    scr.classList.add('hidden');
    $('calib-voice').classList.add('hidden');
    $('calib-cam').classList.remove('hidden');
    calibrating = false;
    voiceCheck = false;
  };

  // ---------------------------------------------------------------- egress
  /** withMic = false: no microphone at all (typed commands and clicks only); say/type “voice check” later to turn it on */
  const begin = async (withGaze: boolean, withMic = true) => {
    $('btn-begin').setAttribute('disabled', '');
    $('btn-skip-calib').setAttribute('disabled', '');
    // start mic + camera inside the click (user gesture) so the permission prompts appear right away
    if (withMic) voice.start();
    const gazeReady = withGaze ? gaze.start() : Promise.resolve();
    await audio.init();
    audio.play('ui_click');
    if (withGaze) {
      await gazeReady;
      $('briefing').classList.add('hidden');
      if (!FAST) await runCalibration();
    }
    $('briefing').classList.add('hidden');
    if (withMic) {
      if (!FAST) await runVoiceCheck();
      else void meter.start();
    }
    $('hud').classList.remove('hidden');
    sim.start(false);
    hud.refreshStatic();
    const hint = $('hint-line');
    hint.innerHTML = !withMic
      ? 'Mic off: press <b>Enter</b> to type commands (try <b>“voice check”</b> to turn the mic on) · click a feature to launch it · <b>Space</b> jumps'
      : voice.supported
      ? 'Say <b>“what can I say”</b> · look at anything and say <b>“what is this”</b> or <b>“label this”</b> · <b>Space</b> jumps'
      : 'Voice needs Chrome or Edge here. Press <b>Enter</b> to type commands · click a feature to launch it · <b>Space</b> jumps';
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 16000);
    hud.notify('Egress complete. Follow the ground arrows. W A S D to walk, Space to jump, drag to look.', 'directions_walk', 7);
  };
  $('btn-begin').onclick = () => begin(true);
  $('btn-skip-calib').onclick = () => begin(false, false);

  // ---------------------------------------------------------------- sim events → audio
  sim.on('incident', (def: any) => audio.play(def.severity === 'emergency' ? 'alert_emergency' : def.severity === 'warning' ? 'alert_warning' : 'alert_caution'));
  sim.on('incident', (def: any) => voice.speak(`${def.severity === 'emergency' ? 'Emergency.' : 'Caution.'} ${def.title}.`));
  sim.on('advisory', () => {
    audio.play('reroute_chime');
    const a = sim.advisory;
    if (a) voice.speak(`Reroute advised. ${a.reason.split('.')[0]}.`);
  });
  sim.on('log', () => {
    const last = sim.log[sim.log.length - 1];
    if (last?.kind === 'sample') audio.play('sample_collect');
    if (last?.kind === 'hazard') audio.play('alert_caution');
  });
  sim.on('end', () => showDebrief());
  sim.on('trip', (t: { kind: string }) => audio.play(t.kind === 'fall' ? 'body_thud' : 'ui_click'));
  sim.on('jump', () => audio.play('jump'));
  sim.on('obstacles', () => audio.play('alert_warning'));
  hud.onIslandOpen = () => audio.play('island_open');

  // ---------------------------------------------------------------- features: launch / progress
  const featureLabel = (id: string) => FEATURE_LABEL[id] ?? (id.startsWith('layer:') ? `${LAYER_INFO[id.slice(6) as LayerId]?.label ?? id} layer` : id);
  const showProgress = (id: string): Reply => {
    if ((FEATURES as string[]).includes(id)) {
      const d = hud.featureDetail(id);
      hud.showDetail(id, () => hud.featureDetail(id), 9);
      return { text: `${d.title}: ${d.big}`, speak: d.speech };
    }
    if (id.startsWith('opt:')) {
      const i = Number(id.slice(4));
      if (sim.incident) {
        const o = sim.incident.def.options[i];
        return o ? { text: `Option ${i + 1}: ${o.label}`, speak: `Option ${i + 1}. ${o.label}. ${o.consequence}` } : { text: 'No such option' };
      }
      const ch = sim.choices[i];
      if (ch) return { text: `Route ${i + 1}: ${ch.name}`, speak: `Route ${i + 1}, ${ch.name}. ${km(ch.metrics.distance)}, about ${fmtDur(ch.forecast.timeS)} to the goal, peak fatigue ${ch.forecast.peakFatigue.toFixed(0)}, oxygen at the end ${(ch.forecast.o2End * 100).toFixed(0)} percent.` };
    }
    if (id.startsWith('layer:')) {
      const l = id.slice(6) as LayerId;
      return { text: `${LAYER_INFO[l].label}: ${hud.map.layers[l] ? 'on' : 'off'}`, speak: `${LAYER_INFO[l].label} layer is ${hud.map.layers[l] ? 'on' : 'off'}. ${LAYER_INFO[l].legend}.` };
    }
    if (id.startsWith('reroute') && sim.advisory) return { text: sim.advisory.reason, speak: sim.advisory.reason };
    return showProgress('mission');
  };
  const launch = (id: string): Reply => {
    switch (id) {
      case 'mission':
      case 'o2':
      case 'h2o':
      case 'power':
      case 'dose':
      case 'fatigue':
        return showProgress(id);
      case 'map':
      case 'layers':
        openMap(true);
        return { text: 'Navigator open' };
      case 'route':
        openMap(true);
        return { text: 'Route planner open: click the map to add waypoints', speak: 'Route planner open.' };
      case 'drone':
        if (sim.drone.active) {
          sim.recallDrone();
          return { text: 'Drone recalled', speak: 'Drone returning.' };
        }
        return say(sim.launchDrone('scout'));
      case 'sample':
        return say(sim.markSample());
      case 'reroute-accept':
        return say(sim.acceptAdvisory());
      case 'reroute-dismiss':
        sim.dismissAdvisory();
        return { text: 'Advisory dismissed' };
      case 'plan-commit':
        return sim.plannerCommit() ? (openMap(false), say('Planned route committed')) : { text: 'Add waypoints first' };
      case 'plan-clear':
        sim.plannerClear();
        return { text: 'Route cleared' };
      case 'map-close':
        openMap(false);
        return { text: 'Navigator closed' };
      case 'log':
        hud.setLog(true);
        return { text: 'Mission log open' };
      case 'log-close':
        hud.setLog(false);
        return { text: 'Log closed' };
    }
    if (['tools', 'emergency', 'team', 'supplies', 'systems', 'weather', 'tags'].includes(id)) return tool(id);
    if (id.startsWith('tool:')) return id === 'tool:log' ? (hud.setLog(true), { text: 'Mission log open' }) : tool(id.slice(5));
    if (id.startsWith('act:')) return act(id.slice(4));
    if (id.startsWith('tagkind:')) return finishTag(id.slice(8) as TagKind);
    if (id.startsWith('opt:')) return option(Number(id.slice(4)) + 1);
    if (id.startsWith('layer:')) return layer(id.slice(6) as LayerId);
    return { text: `Nothing to launch on ${featureLabel(id)}` };
  };
  type Reply = { text: string; speak?: string };
  const say = (text: string, speakIt = true): Reply => ({ text, speak: speakIt ? text : undefined });
  const option = (n: number): Reply => {
    if (sim.incident) {
      const o = sim.incident.def.options[n - 1];
      if (!o) return { text: `No option ${n}` };
      sim.resolveIncident(n - 1);
      return say(`Option ${n}: ${o.label}`);
    }
    if (sim.awaitingChoice && sim.choices[n - 1]) {
      const ch = sim.choices[n - 1];
      sim.choose(n - 1);
      return say(`Route ${n}: ${ch.name}`);
    }
    return { text: 'No choice to make right now' };
  };
  const layer = (l: LayerId, on?: boolean): Reply => {
    const v = hud.toggleLayer(l, on);
    return say(`${LAYER_INFO[l].label} layer ${v ? 'on' : 'off'}`, false);
  };
  const vitalsReply = (): Reply => {
    const h = sim.health;
    hud.showDetail('vitals', () => {
      const hh = sim.health;
      return {
        icon: 'ecg_heart',
        title: 'Vitals',
        big: `${hh.hr.toFixed(0)} bpm`,
        rows: [
          ['Oxygen', `${((hh.o2g / hh.o2Cap) * 100).toFixed(0)}%`],
          ['Cooling water', `${((hh.waterg / hh.waterCap) * 100).toFixed(0)}%`],
          ['Battery', `${((hh.battWh / hh.battCap) * 100).toFixed(0)}%`],
          ['Fatigue', hh.fatigue.toFixed(0)],
          ['Dose', `${hh.doseMSv.toFixed(2)} mSv`],
          ['Core temp', `${hh.coreC.toFixed(1)} °C`],
        ],
        speech: '',
      };
    });
    return {
      text: 'Vitals',
      speak: `Heart rate ${h.hr.toFixed(0)}. Oxygen ${((h.o2g / h.o2Cap) * 100).toFixed(0)} percent. Water ${((h.waterg / h.waterCap) * 100).toFixed(0)} percent. Battery ${((h.battWh / h.battCap) * 100).toFixed(0)} percent. Fatigue ${h.fatigue.toFixed(0)}. Dose ${h.doseMSv.toFixed(2)} millisievert.`,
    };
  };
  const helpReply = (): Reply => {
    hud.showDetail(
      'help',
      () => ({
        icon: 'record_voice_over',
        title: 'Say…',
        big: '',
        rows: [
          ['Speak naturally', 'TEVAN understands meaning, not exact words, and asks “did you mean…?” when unsure'],
          ['Voice lock', 'only your enrolled voice runs spoken commands · type “voice lock off” to disable'],
          ['Just look at a rock', 'its ID card appears and stays 3.5 s'],
          ['Look + “what is this”', 'TEVAN identifies it'],
          ['Look + “label this (as hazard)”', 'coloured tag, follows movers'],
          ['“Call for help” · “back to habitat”', 'emergency (or the SOS icon)'],
          ['“Nearest shelter” · “go to cache” · “rest”', 'emergency actions'],
          ['“Show log” · “repeat that” · “undo”', 'traceability'],
          ['“Tools” · “team” · “weather” · “systems”', 'more features'],
          ['Look + “launch this”', 'open / run what you look at'],
          ['Look + “check this feature’s progress”', 'live status card'],
          ['“Show / hide radiation”', 'slope · POI · dust · magnetic'],
          ['“Reroute” · “accept” · “dismiss”', 'alternate route'],
          ['“Mark sample”', 'collect at a sample site'],
          ['“Vitals”', 'read life support aloud'],
          ['“Launch / recall drone”', 'scout ahead'],
          ['“Option two” · “route one”', 'decisions'],
          ['“Open map” · “close”', 'navigator + planner'],
          ['“Zoom in / out”', 'or scroll the mouse wheel'],
          ['“Calibrate”', 'redo gaze calibration'],
          ['“Stop listening” · “resume listening”', 'mic'],
        ],
        speech: '',
      }),
      14,
    );
    return { text: 'Commands shown above', speak: 'Look at anything and say what is this, or label this. Say call for help or back to habitat in an emergency. Say tools for everything else.' };
  };

  // ---------------------------------------------------------------- v2: tools, emergency actions, tags, "what is this"
  const tool = (id: string): Reply => {
    const d = hud.featureDetail(id);
    hud.showDetail(id, () => hud.featureDetail(id), id === 'tools' || id === 'emergency' ? 14 : 10);
    return { text: d.title + (d.big ? `: ${d.big}` : ''), speak: d.speech };
  };
  const act = (a: string): Reply => {
    switch (a) {
      case 'help':
        hud.closeDetail();
        audio.play('mayday');
        return say(guardian.callHelp());
      case 'habitat':
        hud.closeDetail();
        return say(guardian.backToHabitat());
      case 'shelter':
        hud.closeDetail();
        return say(guardian.toShelter());
      case 'cache':
        hud.closeDetail();
        return say(guardian.goToCache());
      case 'resupply':
        return say(guardian.resupply());
      case 'rest':
        hud.closeDetail();
        return say(guardian.rest());
      case 'resume':
        return say(guardian.resumeMission());
      case 'cancelNav':
        sim.clearDetour();
        return say('Navigation cancelled. Back on the mission plan.');
      case 'stability':
        return say(guardian.stability());
      case 'photo':
        return photo();
      case 'what':
        return whatIsThis();
    }
    return { text: `Unknown action ${a}` };
  };
  /** what the eyes (or pointer) are on in the WORLD right now, remembered briefly like feature targets */
  let lastPick: { p: Pick; at: number } | null = null;
  const worldPick = (): Pick | null => {
    const gp = gaze.state === 'tracking' && gaze.point ? gaze.point : pointer ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const p = world.pick(gp.x, gp.y);
    if (p.type !== 'sky') return p;
    if (lastPick && performance.now() - lastPick.at < 2500) return lastPick.p;
    return p;
  };
  const whatIsThis = (): Reply => {
    const p = worldPick();
    if (!p) return { text: 'Look at something first' };
    hud.focus = p;
    hud.confirmFocus();
    focusHoldUntil = performance.now() + 3000;
    const card = guardian.describe(p);
    const sol = card.roverSol;
    // real data: show what Perseverance's Navcam saw when it drove past this spot
    const build = () => {
      if (sol === undefined) return card;
      const imgs = hud.feed.forSol(sol);
      if (imgs === 'error') return { ...card, hint: `No Navcam frames from sol ${sol} in NASA's feed.` };
      if (imgs === 'loading') return { ...card, hint: `Fetching Perseverance's Navcam frames from sol ${sol}…` };
      return { ...card, gallery: imgs.slice(0, 3).map((i) => ({ src: i.thumb, caption: `Sol ${i.sol} · ${i.date}`, href: i.link })) };
    };
    hud.showDetail('what', build, sol === undefined ? 10 : 16);
    return { text: card.title, speak: card.speech };
  };
  let pendingTag: Pick | null = null;
  const labelThis = (kind?: TagKind): Reply => {
    const p = worldPick();
    if (!p || p.type === 'sky') return say('Look at something on the ground first, then say label this.');
    if (p.type === 'tag') return say(`That is already tagged as ${p.name}.`);
    hud.focus = p;
    hud.confirmFocus();
    const k = kind ?? guardian.suggestKind(p);
    if (k) {
      pendingTag = p;
      return finishTag(k);
    }
    pendingTag = p;
    hud.showDetail('tagkind', () => ({ icon: 'sell', title: `Label ${p.type === 'boulder' ? p.name.toLowerCase() : 'this spot'} as…`, big: km(p.dist), rows: [], acts: TAG_ACTS, cols: 4, speech: '', hint: 'Say the type (“hazard”, “destination”…), or look at one and say “launch this”.' }), 15);
    return { text: 'What is it?', speak: 'What is it? Teammate, habitat, destination, hazard, sample, resource, or note?' };
  };
  const finishTag = (k: TagKind): Reply => {
    const p = pendingTag;
    if (!p) return labelThis(k);
    pendingTag = null;
    const t = guardian.addTag(k, p);
    audio.play('tag_set');
    hud.closeDetail();
    const me = sim.position();
    const pos = guardian.tagPos(t);
    return say(`Tagged ${TAG_INFO[k].label.toLowerCase()}: ${t.label}, ${Math.round(Math.hypot(pos.e - me.e, pos.n - me.n))} metres ${bearingWord(pos.e - me.e, pos.n - me.n)}.${t.follow ? ' The tag follows it as it moves.' : ''}${k === 'destination' ? ' Say go to tag to navigate there.' : ''}`);
  };
  const photo = (): Reply => {
    const img = world.snapshot();
    const p = sim.position();
    const hd = world.heading();
    const caption = `Photo ${guardian.photos.length + 1}`;
    guardian.photos.push({ met: sim.met, e: p.e, n: p.n, headingDeg: Math.round(hd), caption, thumb: img });
    sim.addLog({ kind: 'info', title: `${caption} taken`, severity: 'info', outcome: `E${p.e.toFixed(0)} N${p.n.toFixed(0)} · heading ${hd.toFixed(0)}°` });
    audio.play('camera_shutter');
    const fl = $('photo-flash');
    fl.classList.remove('go');
    void fl.offsetWidth;
    fl.classList.add('go');
    hud.showDetail('photo', () => ({ icon: 'photo_camera', title: caption, big: `${hd.toFixed(0)}°`, rows: [['Position', `E${p.e.toFixed(0)} N${p.n.toFixed(0)}`], ['Mission time', fmtMET(sim.met)]], img, speech: '' }), 5);
    return { text: `${caption} saved to the log`, speak: 'Photo saved.' };
  };

  const exec = (cmd: Command, source: 'voice' | 'typed'): Reply => {
    if (sim.status !== 'active' && !['wake', 'sleep', 'help'].includes(cmd.type)) return { text: 'EVA not active' };
    let r: Reply;
    switch (cmd.type) {
      case 'launchThis':
      case 'progressThis': {
        const t = targets.resolve();
        if (!t) {
          r = { text: gazeLive() ? 'Look at a feature first' : 'Point at a feature first', speak: 'Look at a feature first.' };
          break;
        }
        t.el.classList.add('fired');
        setTimeout(() => t.el.classList.remove('fired'), 500);
        r = cmd.type === 'launchThis' ? launch(t.id) : showProgress(t.id);
        r.text = `${featureLabel(t.id)} · ${r.text}`;
        break;
      }
      case 'launch':
        r = launch(cmd.feature);
        break;
      case 'progress':
        r = showProgress(cmd.feature);
        break;
      case 'layer':
        r = layer(cmd.layer, cmd.on);
        break;
      case 'reroute':
        r = say(sim.advisory ? sim.acceptAdvisory() : sim.requestReroute());
        break;
      case 'accept':
        r = sim.advisory ? say(sim.acceptAdvisory()) : sim.incident ? option(sim.incident.def.options.findIndex((o) => o.recommended) + 1) : { text: 'Nothing to accept' };
        break;
      case 'dismiss':
        if (sim.advisory) {
          sim.dismissAdvisory();
          r = { text: 'Advisory dismissed' };
        } else if (hud.mapExpanded) r = launch('map-close');
        else {
          hud.closeDetail();
          r = { text: 'Cleared' };
        }
        break;
      case 'sample':
        r = say(sim.markSample());
        break;
      case 'vitals':
        r = vitalsReply();
        break;
      case 'drone':
        if (cmd.action === 'recall') {
          sim.recallDrone();
          r = say('Drone returning');
        } else if (cmd.action === 'relay') r = say(sim.launchDrone('relay'));
        else r = say(sim.drone.active ? 'Drone already airborne' : sim.launchDrone('scout'));
        break;
      case 'map':
        openMap(cmd.open);
        r = { text: cmd.open ? 'Navigator open' : 'Navigator closed' };
        break;
      case 'close':
        if (hud.mapExpanded) openMap(false);
        else hud.closeDetail();
        r = { text: 'Closed' };
        break;
      case 'option':
        r = option(cmd.n);
        break;
      case 'pace':
        if (cmd.pace) {
          sim.pace = cmd.pace;
          (sim as any).planDirty = true;
          sim.emit('change');
        } else sim.cyclePace();
        r = say(`Pace ${sim.pace}`);
        break;
      case 'zoom': {
        if (hud.mapExpanded) {
          if (cmd.dir === 'reset') mapNav.fitAll();
          else mapNav.zoomAt(cmd.dir === 'in' ? 2 : 0.5);
          r = { text: cmd.dir === 'in' ? 'Map zoomed in' : cmd.dir === 'out' ? 'Map zoomed out' : 'Whole map' };
          break;
        }
        const z = cmd.dir === 'reset' ? world.setZoom(1) : world.zoomBy(cmd.dir === 'in' ? 2 : 0.5);
        r = { text: `Zoom ${z.toFixed(1)}×` };
        break;
      }
      case 'calibrate':
        if (cmd.what === 'voice') {
          if (voice.state === 'off') voice.start();
          void runVoiceCheck();
          r = { text: 'Voice check' };
          break;
        }
        if (gaze.state === 'off' || gaze.state === 'denied' || gaze.state === 'error') void gaze.start().then(runCalibration);
        else void runCalibration();
        r = { text: 'Calibrating gaze' };
        break;
      case 'commit':
        r = launch('plan-commit');
        break;
      case 'clear':
        r = launch('plan-clear');
        break;
      case 'help':
        r = helpReply();
        break;
      case 'mute':
        audio.setMuted(cmd.on);
        r = { text: cmd.on ? 'Sound muted' : 'Sound on' };
        break;
      case 'sleep':
        voice.sleep(true);
        r = { text: 'Mic asleep. Say “resume listening”.' };
        break;
      case 'wake':
        if (voice.state === 'off') voice.start();
        voice.sleep(false);
        r = { text: 'Listening' };
        break;
      case 'hello':
        r = say('Hi. I’m listening. Say what can I say for the commands.');
        break;
      case 'whatThis':
        r = whatIsThis();
        break;
      case 'labelThis':
        r = labelThis(cmd.kind);
        break;
      case 'tagKind':
        r = pendingTag ? finishTag(cmd.kind) : labelThis(cmd.kind);
        break;
      case 'removeTag': {
        const t = guardian.removeTag();
        r = say(t ? `Removed tag ${t.label}` : 'No tags to remove');
        break;
      }
      case 'goTag':
        r = say(guardian.goToTag(cmd.kind));
        break;
      case 'goTeammate':
        r = say(guardian.goToTeammate());
        break;
      case 'emergency':
        r = act(cmd.action);
        break;
      case 'stability':
        r = say(guardian.stability(cmd.on));
        break;
      case 'tool':
        r = tool(cmd.tool);
        break;
      case 'logPanel':
        hud.setLog(cmd.open);
        r = { text: cmd.open ? 'Mission log open' : 'Log closed' };
        break;
      case 'photo':
        r = photo();
        break;
      case 'repeat':
        r = { text: guardian.lastSaid || voice.lastSpoken || 'Nothing to repeat', speak: guardian.lastSaid || voice.lastSpoken || 'Nothing to repeat yet.' };
        break;
      case 'undo':
        r = say(guardian.undo());
        break;
      case 'jump':
        r = { text: sim.jump() ? 'Jump' : 'Can’t jump right now' };
        break;
      case 'voiceLock':
        voiceLock = cmd.on ?? !voiceLock;
        voiceRejects = 0;
        r = say(!vprint ? 'No voiceprint yet. Say or type voice check to record one.' : voiceLock ? 'Voice lock on. I only take spoken commands in your voice.' : 'Voice lock off. I take spoken commands from any voice.');
        break;
      case 'where': {
        const p = sim.position();
        const hab = sim.world.nodes.get(m.startNodeId)!;
        const d = Math.hypot(hab.e - p.e, hab.n - p.n);
        const ll = data.geo ? toLatLon(data.geo, p.e, p.n) : null;
        r = say(`You are at ${ll ? `${ll.lat.toFixed(4)} degrees north, ${ll.lon.toFixed(4)} degrees east` : `east ${p.e.toFixed(0)}, north ${p.n.toFixed(0)}`}, ${Math.round(d)} metres ${bearingWord(p.e - hab.e, p.n - hab.n)} of the habitat${sim.pos.leg ? `, on the ${sim.world.edges.get(sim.pos.leg.edgeId)!.edge.name}` : ''}.`);
        break;
      }
      default:
        r = { text: 'Not understood' };
    }
    hud.refreshStatic();
    if (source === 'typed') r.speak = undefined;
    return r;
  };

  // clicking a feature is the same as looking at it and saying "launch this"
  document.addEventListener('click', (e) => {
    if (sim.status !== 'active') return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-gaze]');
    if (!el || el.id === 'island') return;
    const r = launch(el.dataset.gaze!);
    audio.play('ui_click');
    setCapsule('ok', r.text, 2200);
    hud.refreshStatic();
  });
  $('island').addEventListener('click', (e) => {
    if (e.target === $('island') || (e.target as HTMLElement).closest('.i-idle')) {
      const r = showProgress('mission');
      setCapsule('ok', r.text, 2200);
    }
  });

  // ---------------------------------------------------------------- typed fallback
  const input = $('cmd-input') as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      handleUtterance([input.value], 'typed');
      input.value = '';
      input.classList.add('hidden');
      input.blur();
    }
    if (e.key === 'Escape') {
      input.classList.add('hidden');
      input.blur();
    }
  });

  // ---------------------------------------------------------------- navigator panel
  const mapNav = new MapNav(hud.map, sim, data, guardian, $('map-canvas-large') as HTMLCanvasElement, {
    stage: $('mx-stage'),
    search: $('mx-search') as HTMLInputElement,
    results: $('mx-results'),
    card: $('mx-card'),
    coords: $('mx-coords'),
    zin: $('mx-zin'),
    zout: $('mx-zout'),
    locate: $('mx-locate'),
    fit: $('mx-fit'),
    modes: $('mx-modes'),
    clearSearch: $('mx-search-x'),
    chips: $('mx-chips'),
  });
  hud.mapNav = mapNav;
  mapNav.onPlan = (e, n) => {
    const node = sim.plannerAdd(e, n);
    hud.refreshPlanner();
    return node ? `${sim.plannerNodes.length}. ${node.name}` : null;
  };
  mapNav.onSay = (t) => {
    setCapsule('ok', t, 2600);
    if (sim.status === 'active') guardian.record('tevan', t);
  };
  const openMap = (open: boolean) => {
    hud.mapExpanded = open;
    hud.map.planning = open;
    $('map-expanded').classList.toggle('hidden', !open);
    if (open) {
      hud.refreshPlanner();
      mapNav.opened();
    }
  };
  mapNav.onClose = () => openMap(false);
  $('map-expanded').addEventListener('click', (e) => {
    if (e.target === $('map-expanded')) openMap(false);
  });

  // ---------------------------------------------------------------- mouse: look + zoom
  let dragging = false;
  let lx = 0;
  let ly = 0;
  const vp = $('viewport');
  vp.addEventListener('pointerdown', (e) => {
    dragging = true;
    lx = e.clientX;
    ly = e.clientY;
    vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const k = 1 / world.zoom;
    sim.lookYaw += (e.clientX - lx) * 0.004 * k;
    world.pitch = Math.max(-1.2, Math.min(0.9, world.pitch - (e.clientY - ly) * 0.003 * k));
    lx = e.clientX;
    ly = e.clientY;
  });
  vp.addEventListener('pointerup', () => (dragging = false));
  vp.addEventListener('dblclick', () => world.setZoom(1));
  let zoomShownUntil = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (sim.status !== 'active' || hud.mapExpanded || calibrating) return;
      e.preventDefault();
      world.zoomBy(Math.exp(-e.deltaY * 0.0015));
      zoomShownUntil = performance.now() + 1500;
    },
    { passive: false },
  );

  // ---------------------------------------------------------------- keyboard: movement only
  const held = new Set<string>();
  const typing = () => document.activeElement === input || document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
  window.addEventListener('blur', () => held.clear());
  window.addEventListener('keydown', (e) => {
    if (typing() || sim.status !== 'active') return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat && !hud.mapExpanded) sim.jump();
      return;
    }
    if (['w', 'a', 's', 'd', 'shift', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) {
      held.add(k);
      if (k.startsWith('arrow')) e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      // accessibility fallback when no microphone is available
      e.preventDefault();
      input.classList.remove('hidden');
      input.focus();
    } else if (e.key === 'Escape') {
      if (hud.mapExpanded) openMap(false);
      else hud.closeDetail();
    } else if (e.key === '[') sim.warp = Math.max(1, Math.round(sim.warp / 2)); // demo operator: time warp
    else if (e.key === ']') sim.warp = Math.min(120, sim.warp * 2);
  });
  window.addEventListener('keyup', (e) => {
    held.delete(e.key.toLowerCase());
    if (e.key === 'Shift') held.delete('shift');
  });
  const applyInput = (dt: number) => {
    const blocked = typing() || hud.mapExpanded || !!sim.incident || sim.status !== 'active';
    const h = (k: string) => (!blocked && held.has(k) ? 1 : 0);
    sim.input.f = h('w') - h('s');
    sim.input.r = h('d') - h('a');
    sim.input.sprint = !!h('shift');
    sim.lookYaw += ((h('arrowright') - h('arrowleft')) * 1.6 * dt) / world.zoom;
    world.pitch = Math.max(-1.2, Math.min(0.9, world.pitch + ((h('arrowup') - h('arrowdown')) * 0.9 * dt) / world.zoom));
  };

  // ---------------------------------------------------------------- debrief
  const showDebrief = () => {
    $('hud').classList.add('hidden');
    $('map-expanded').classList.add('hidden');
    voice.stop();
    gaze.stop();
    $('debrief').classList.remove('hidden');
    const h = sim.health;
    const failed = sim.status === 'failed';
    const aborted = sim.status === 'aborted';
    const out = $('debrief-outcome');
    out.className = failed ? 'fail' : aborted ? 'abort' : '';
    out.textContent = sim.status === 'success' ? 'EVA COMPLETE · ASTRONAUT RECOVERED' : aborted ? 'EVA ABORTED · CREW SAFE IN HABITAT' : `EVA TERMINATED · ${sim.failReason.toUpperCase()}`;
    const tag = $('debrief-tag');
    tag.className = `d-tag ${failed ? 'fail' : aborted ? 'abort' : ''}`;
    tag.textContent = failed ? '● CRITICAL SIMULATION EVENT // ABORT RECORDED' : aborted ? 'MISSION ABORTED' : '✓ RECOVERY SUCCESSFUL';
    $('debrief-sub').textContent = `${m.title} // MET ${fmtMET(sim.met)} // SOL ${m.sol}${failed ? ' // crew member recovered by rover rescue in simulation' : ' // airlock pressurised'}`;
    const samples = m.objectives.filter((o) => o.kind === 'sample');
    const got = samples.filter((o) => sim.objectivesDone.has(o.id)).length;
    const pct = (v: number) => `${(v * 100).toFixed(0)}<small style="font-size:14px">%</small>`;
    const tile = (k: string, v: string, sub: string, cls = '') => `<div class="dtile ${cls}"><span class="lbl">${k}</span><b>${v}</b><span class="sub">${sub}</span></div>`;
    const o2f = h.o2g / h.o2Cap;
    $('debrief-summary').innerHTML = [
      tile('DISTANCE', `${(sim.stats.distance / 1000).toFixed(2)}<small style="font-size:14px"> km</small>`, 'walked on foot'),
      tile('OBJECTIVES', `${got} / ${samples.length}`, `${got === samples.length ? 'all' : 'some'} samples secured`, got === samples.length ? 'good' : ''),
      tile('O2 REMAINING', pct(o2f), o2f < RESERVE_FRAC ? 'BELOW RESERVE' : 'above 20% reserve', o2f <= 0.01 ? 'bad' : o2f >= RESERVE_FRAC ? 'good' : ''),
      tile('H2O REMAINING', pct(h.waterg / h.waterCap), 'sublimator feedwater'),
      tile('BATTERY', pct(h.battWh / h.battCap), `${h.battWh.toFixed(0)} Wh left`, h.battWh <= 1 ? 'bad' : ''),
      tile('MISSION DOSE', `${h.doseMSv.toFixed(2)}<small style="font-size:14px"> mSv</small>`, `budget ${m.consumables.doseBudgetmSv} mSv`),
    ].join('');
    const incidents = sim.log.filter((l) => l.kind === 'incident');
    const recommendedTaken = incidents.filter((l) => {
      const def = m.incidents.find((d) => d.title === l.title);
      return def && l.decision && def.options.find((o) => o.recommended)?.label === l.decision.replace('[timeout] ', '');
    }).length;
    const speAvoided = sim.log.some((l) => l.title.startsWith('Sheltering'));
    const row = (k: string, v: string) => `<div><span>${k}</span><b>${v}</b></div>`;
    $('debrief-impact').innerHTML = [
      row('Navigator recommendations followed', `${recommendedTaken} / ${incidents.length}`),
      row('Reroute advisories accepted', `${sim.stats.advisoriesAccepted} / ${sim.stats.advisoriesShown}`),
      row('Peak dose rate', sim.dosePeakRate >= 1000 ? `${(sim.dosePeakRate / 1000).toFixed(1)} mSv/h` : `${sim.dosePeakRate.toFixed(0)} µSv/h`),
      row('Peak fatigue', Math.max(...sim.history.map((p) => p.fatigue), h.fatigue).toFixed(0)),
      row('Lowest O2', `${(Math.min(...sim.history.map((p) => p.o2), o2f) * 100).toFixed(0)}%`),
      row('Footing', `${sim.stats2.stumbles} stumbles · ${sim.stats2.falls} falls · ${sim.stats2.jumps} jumps`),
      row('Tags · photos · caches used', `${guardian.tags.length} · ${guardian.photos.length} · ${guardian.cachesUsed.size}`),
      row('Mayday', guardian.helpCalled ? 'Called' : 'Not needed'),
    ].join('') + `<p>${speAvoided ? 'Sheltered during the solar particle event. ' : ''}Geography decided the risk: slope and surface drove metabolic cost and O2, open sky drove dose, and every route choice was shown with its forecast cost before it was taken.</p>`;
    $('debrief-rc-title').textContent = failed ? 'Root cause' : 'Navigator impact';
    if (failed) {
      const chain = sim.log.filter((l) => l.kind === 'incident' || (l.kind === 'decision' && l.decision?.includes('not recommended')) || (l.kind === 'reroute' && l.decision === 'Dismissed')).slice(-3);
      $('debrief-rootcause').innerHTML = `<div class="rc-chain">${chain.map((l, i) => `<div class="rc-step"><span class="lbl">STEP ${String(i + 1).padStart(2, '0')} · MET ${fmtMET(l.met)}</span><b>${esc(l.title)}</b>${l.decision ? `<div class="sub">${esc(l.decision)}</div>` : ''}</div>`).join('')}<div class="rc-step"><span class="lbl warning-t">FAILURE · MET ${fmtMET(sim.met)}</span><b>${esc(sim.failReason)}</b></div></div>`;
    } else $('debrief-rootcause').innerHTML = '';
    $('debrief-log').innerHTML =
      '<tr><th>MET</th><th>EVENT</th><th>SEVERITY</th><th>DECISION</th><th>OUTCOME</th></tr>' +
      sim.log
        .filter((l) => l.kind !== 'info' || l.severity !== 'info' || /Shelter|Drone|ended|onset/.test(l.title))
        .map((l) => `<tr class="${l.severity === 'emergency' || l.kind === 'failure' ? 'emergency' : ''}"><td class="mono">${fmtMET(l.met)}</td><td>${esc(l.title)}</td><td><span class="sev ${l.severity}">${l.severity.toUpperCase()}</span></td><td>${esc(l.decision ?? '')}</td><td>${esc(l.outcome ?? '')}</td></tr>`)
        .join('');
    requestAnimationFrame(() => {
      const dm = new TacticalMap(data, sim);
      dm.layers.fog = false;
      dm.draw($('debrief-map') as HTMLCanvasElement, { t: 0, large: true });
      drawChart($('debrief-chart') as HTMLCanvasElement, { met: sim.met, history: sim.history, now: { o2: o2f, fatigue: h.fatigue, batt: h.battWh / h.battCap, dose: h.doseMSv }, large: true });
    });
  };
  $('btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify(sim.exportLog(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${m.id}-log.json`;
    a.click();
  };
  $('btn-new').onclick = () => location.reload();

  // ---------------------------------------------------------------- loop
  const cursor = $('gaze-cursor');
  const camInd = $('cam-ind');
  const micInd = $('mic-ind');
  let lastPickT = 0;
  let focusHoldUntil = 0;
  void focusHoldUntil;
  const zoomEl = $('zoom-readout');
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!calibrating) {
      applyInput(dt);
      sim.update(dt);
      guardian.update(dt);
    }
    world.quake = guardian.quakeT > 0 ? Math.min(1, guardian.quakeT / 3) : 0;
    audio.setLevel('quake_rumble', world.quake * 0.6);
    world.update(dt);
    world.render($('drone-pip'));
    if (!voiceCheck) captureVoice(now);
    if (sim.status === 'active') {
      hud.update(dt);
      // gaze → target (pointer stands in when no camera)
      const gp = gaze.state === 'tracking' && gaze.point ? gaze.point : pointer;
      targets.update(calibrating ? null : gp, now);
      // world focus: outline what the eyes rest on in the world (only when no visor feature is locked)
      if (now - lastPickT > 70) {
        lastPickT = now;
        const p = !calibrating && gp && !targets.current && !hud.mapExpanded ? world.pick(gp.x, gp.y) : null;
        const named = identifiable(p);
        if (p && p.type !== 'sky') lastPick = { p, at: now };
        if (now > focusHoldUntil) hud.focus = named ? p : null;
        // mixed-reality ID card: appears the moment the eyes land on it, holds 3.5 s after they leave
        holo.observe(named ? p : null, now);
      }
      holo.update(now);
      // camera + mic indicators: green only when actually working, dim grey otherwise
      const camOn = gaze.state === 'tracking';
      camInd.dataset.state = camOn ? 'on' : gaze.state === 'denied' || gaze.state === 'error' ? 'err' : '';
      camInd.title = camOn ? 'Camera: tracking your eyes' : gaze.state === 'noface' ? 'Camera on, no face found' : gaze.lastError || 'Camera off: pointer stands in for gaze';
      const micOn = voice.state === 'listening' || voice.state === 'hearing';
      micInd.dataset.state = voice.state === 'hearing' ? 'hearing' : micOn ? 'on' : '';
      micInd.title = micOn ? 'Microphone: listening' : voice.state === 'asleep' ? 'Microphone asleep: say “resume listening”' : VOICE_ERRORS[voice.lastError] ?? 'Microphone off';
      hud.sensors = {
        mic: micOn ? 'Listening' : voice.state === 'asleep' ? 'Asleep' : voice.supported ? (voice.state === 'denied' ? 'Blocked' : 'Off') : 'Not supported',
        micOk: micOn,
        cam: camOn ? 'Tracking face' : gaze.state === 'noface' ? 'No face' : gaze.state === 'starting' ? 'Starting' : gaze.state === 'off' ? 'Off' : 'Unavailable',
        camOk: camOn,
        gaze: gaze.calibrated ? `Calibrated · ±${Math.round(gaze.accuracyPx)} px` : camOn ? 'Head pointing' : 'Mouse pointer',
      };
      if (gaze.state === 'tracking' && gp) {
        cursor.style.transform = `translate(${gp.x}px, ${gp.y}px)`;
        cursor.classList.add('on');
      } else cursor.classList.remove('on');
      const z = world.zoomTarget;
      zoomEl.textContent = z > 1.01 ? `${z.toFixed(1)}×` : '';
      zoomEl.classList.toggle('show', z > 1.01 || now < zoomShownUntil);
      // audio mix follows state
      const agg = sim.agg();
      audio.setLevel('ambient_wind', 0.15);
      audio.setLevel('music_bed', 0.05);
      audio.setLevel('plss_hum', 0.05);
      audio.setLevel('suit_breathing', 0.12 + Math.min(0.25, sim.health.metW / 2400), Math.max(0.15, sim.health.hr / 240));
      audio.setLevel('dust_storm', Math.min(0.5, agg.dust * 0.2));
      audio.setLevel('spe_geiger', Math.min(1, sim.rates.doseRate / 4000));
      audio.setLevel('drone_rotor', sim.drone.active ? 0.04 : 0);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  void fmtMET;
}

boot();
