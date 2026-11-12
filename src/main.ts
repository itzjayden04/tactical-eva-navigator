import { selectProvider } from './data';
import type { DataBundle } from './data/types';
import { Sim } from './core/sim';
import { World } from './render/scene';
import { Hud, fmtDur, fmtMET, FEATURE_LABEL, km, esc } from './ui/hud';
import { TacticalMap, LayerId, LAYER_INFO } from './ui/map';
import { drawChart } from './ui/chart';
import { Audio } from './ui/audio';
import { Voice, parseCommand, Command, FeatureId } from './ui/voice';
import { GazeTracker } from './ui/gaze';
import { Targeting } from './ui/targets';
import { RESERVE_FRAC } from './core/health';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FEATURES: FeatureId[] = ['mission', 'o2', 'h2o', 'power', 'dose', 'fatigue', 'map', 'route', 'drone', 'sample', 'layers'];

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
  (window as any).__tevan = { sim, world, hud, voice, gaze, targets };

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
  briefMap.layers.fog = false;
  briefMap.layers.radiation = true;
  const chk = (id: string, cls: string, text: string) => {
    const el = $(id);
    el.className = cls;
    el.lastChild!.textContent = text;
  };
  chk('chk-mic', voice.supported ? '' : 'bad', voice.supported ? 'Voice · microphone' : 'Voice needs Chrome or Edge (type with Enter)');
  chk('chk-cam', gaze.supported ? '' : 'bad', gaze.supported ? 'Gaze · camera' : 'No camera API: pointer stands in for gaze');
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
    if (s === 'denied') setCapsule('err', 'Microphone blocked');
    else if (s !== 'hearing' && !capsule.classList.contains('ok') && !capsule.classList.contains('miss')) setCapsule(voiceIdleClass());
    chk('chk-mic', s === 'denied' ? 'bad' : s === 'listening' ? 'ok' : '', s === 'denied' ? 'Microphone blocked' : s === 'listening' ? 'Voice · listening' : 'Voice · microphone');
  };
  voice.onInterim = (t) => {
    if (voice.asleep) return;
    setCapsule('hearing', t);
  };
  voice.onFinal = (t) => {
    const cmd = parseCommand(t);
    if (voice.asleep && cmd?.type !== 'wake') return;
    if (!cmd) {
      setCapsule('miss', t, 1800);
      return;
    }
    const reply = exec(cmd, 'voice');
    setCapsule('ok', reply.text || t, 2600);
    audio.play('voice_ack');
    if (reply.speak) voice.speak(reply.speak);
  };

  // ---------------------------------------------------------------- gaze
  let pointer: { x: number; y: number } | null = null;
  window.addEventListener('pointermove', (e) => (pointer = { x: e.clientX, y: e.clientY }));
  document.addEventListener('pointerleave', () => (pointer = null));
  const gazeLive = () => gaze.state === 'tracking' || gaze.state === 'noface';
  gaze.onState = (s) => {
    chk('chk-cam', s === 'denied' || s === 'error' ? 'bad' : s === 'tracking' ? 'ok' : '', s === 'denied' ? 'Camera blocked: pointer stands in for gaze' : s === 'error' ? 'Gaze unavailable: pointer stands in' : s === 'tracking' ? 'Gaze · face locked' : s === 'starting' ? 'Gaze · starting camera' : s === 'noface' ? 'Gaze · looking for your face' : 'Gaze · camera');
    document.body.classList.toggle('gaze-on', gazeLive());
    if (sim.status === 'active' && (s === 'denied' || s === 'error')) hud.notify('Gaze unavailable: pointer stands in for your eyes', 'visibility_off');
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
  const runCalibration = async (): Promise<number | null> => {
    calibrating = true;
    const scr = $('calib');
    const dot = $('calib-dot');
    const txt = $('calib-text');
    scr.classList.remove('hidden');
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
    while (gaze.state !== 'tracking' && performance.now() - t0 < 15000) {
      if (gaze.state === 'denied' || gaze.state === 'error') break;
      await sleep(100);
    }
    let result: number | null = null;
    if (gaze.state === 'tracking') {
      txt.textContent = 'Follow the dot with your eyes. Keep your head still.';
      const W = window.innerWidth;
      const H = window.innerHeight;
      const pts: [number, number][] = [];
      for (const fy of [0.14, 0.5, 0.86]) for (const fx of [0.1, 0.5, 0.9]) pts.push([fx * W, fy * H]);
      pts.sort(() => 0); // reading order
      gaze.beginCalibration();
      dot.style.opacity = '1';
      for (const [x, y] of pts) {
        dot.style.transform = `translate(${x}px, ${y}px)`;
        dot.classList.remove('collect');
        await sleep(650);
        dot.classList.add('collect');
        const end = performance.now() + 900;
        while (performance.now() < end) {
          gaze.addCalibrationSample(x, y);
          await sleep(33);
        }
      }
      dot.style.opacity = '0';
      result = gaze.finishCalibration();
      $('calib-title').textContent = result === null ? 'Calibration incomplete' : 'Gaze calibrated';
      txt.textContent = result === null ? 'Your face was lost too often. Using head pointing instead. Say “calibrate” to try again.' : `Average error about ${Math.round(result)} px. Look at a feature and say “launch this”.`;
      if (result === null) gaze.recentre();
      await sleep(1600);
    } else {
      $('calib-title').textContent = 'Gaze unavailable';
      txt.textContent = 'No camera or no face found. The pointer will stand in for your eyes.';
      await sleep(1600);
    }
    alive = false;
    scr.classList.add('hidden');
    calibrating = false;
    return result;
  };

  // ---------------------------------------------------------------- egress
  const begin = async (withGaze: boolean) => {
    $('btn-begin').setAttribute('disabled', '');
    $('btn-skip-calib').setAttribute('disabled', '');
    await audio.init();
    audio.play('ui_click');
    voice.start();
    if (withGaze) {
      await gaze.start();
      $('briefing').classList.add('hidden');
      await runCalibration();
    }
    $('briefing').classList.add('hidden');
    $('hud').classList.remove('hidden');
    sim.start(false);
    hud.refreshStatic();
    const hint = $('hint-line');
    hint.innerHTML = voice.supported
      ? 'Say <b>“what can I say”</b> · look at any feature and say <b>“launch this”</b> or <b>“check this feature’s progress”</b>'
      : 'Voice needs Chrome or Edge here. Press <b>Enter</b> to type commands · click a feature to launch it';
    hint.classList.add('show');
    setTimeout(() => hint.classList.remove('show'), 14000);
    hud.notify('Egress complete. Walk with W A S D, drag to look, scroll to zoom.', 'directions_walk', 6);
  };
  $('btn-begin').onclick = () => begin(true);
  $('btn-skip-calib').onclick = () => begin(false);

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
    }
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
    return { text: 'Commands shown above', speak: 'Look at a feature and say launch this, or check this feature’s progress. Or say vitals, reroute, mark sample, or show radiation.' };
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
        const z = cmd.dir === 'reset' ? world.setZoom(1) : world.zoomBy(cmd.dir === 'in' ? 2 : 0.5);
        r = { text: `Zoom ${z.toFixed(1)}×` };
        break;
      }
      case 'calibrate':
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
        voice.sleep(false);
        r = { text: 'Listening' };
        break;
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
      const cmd = parseCommand(input.value);
      setCapsule(cmd ? 'ok' : 'miss', cmd ? exec(cmd, 'typed').text : `Not understood: ${input.value}`, 2600);
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
  const openMap = (open: boolean) => {
    hud.mapExpanded = open;
    hud.map.planning = open;
    $('map-expanded').classList.toggle('hidden', !open);
    if (open) hud.refreshPlanner();
  };
  $('map-canvas-large').addEventListener('click', (ev) => {
    const cv = $('map-canvas-large');
    const r = cv.getBoundingClientRect();
    const p = hud.map.fromPx(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height);
    const node = sim.plannerAdd(p.e, p.n);
    setCapsule(node ? 'ok' : 'miss', node ? `Waypoint ${sim.plannerNodes.length}: ${node.name}` : 'No traverse node near there', 2000);
    hud.refreshPlanner();
  });
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
  const typing = () => document.activeElement === input;
  window.addEventListener('blur', () => held.clear());
  window.addEventListener('keydown', (e) => {
    if (typing() || sim.status !== 'active') return;
    const k = e.key.toLowerCase();
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
  const zoomEl = $('zoom-readout');
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!calibrating) {
      applyInput(dt);
      sim.update(dt);
    }
    world.update(dt);
    world.render($('drone-pip'));
    if (sim.status === 'active') {
      hud.update(dt);
      // gaze → target (pointer stands in when no camera)
      const gp = gaze.state === 'tracking' && gaze.point ? gaze.point : pointer;
      targets.update(calibrating ? null : gp, now);
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
