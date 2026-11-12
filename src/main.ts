import { selectProvider } from './data';
import type { DataBundle } from './data/types';
import { Sim, WARP } from './core/sim';
import { World } from './render/scene';
import { Hud, fmtDur, fmtMET } from './ui/hud';
import { TacticalMap, LayerId } from './ui/map';
import { drawChart } from './ui/chart';
import { Audio } from './ui/audio';
import { Voice, parseCommand } from './ui/voice';
import { RESERVE_FRAC } from './core/health';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function boot() {
  const provider = selectProvider();
  let data: DataBundle;
  try {
    data = await provider.load();
  } catch (e) {
    $('loading').innerHTML = `<div class="loader mono">DATA LOAD FAILED<br/><span class="muted">${esc(String(e))}</span></div>`;
    return;
  }
  const sim = new Sim(data);
  const world = new World($('viewport'), data, sim);
  const hud = new Hud(data, sim, world);
  const audio = new Audio();
  const voice = new Voice();
  (window as any).__eva = { sim, world, hud };

  // ---------------------------------------------------------------- controls (briefing footer + H help share one list)
  const CONTROLS: [string[], string][] = [
    [['W', 'A', 'S', 'D'], 'walk / strafe'],
    [['Shift'], 'sprint (hold)'],
    [['Drag', '←', '→'], 'look / turn'],
    [['1', '2', '3'], 'choose traverse or incident option'],
    [['R'], 'accept / request reroute'],
    [['X'], 'dismiss advisory'],
    [['F'], 'collect sample'],
    [['G'], 'cycle pace'],
    [['Q'], 'launch / recall drone scout'],
    [['V'], 'read vitals aloud'],
    [['M'], 'map + route planner'],
    [['Tab'], 'full navigator / minimal visor'],
    [['Space'], 'push to talk'],
    [['Enter'], 'type a command'],
    [['[', ']'], 'time warp'],
    [['K'], 'mute audio'],
    [['H'], 'this help'],
  ];
  const kbd = (k: string) => `<kbd>${esc(k)}</kbd>`;
  $('help-keys').innerHTML = CONTROLS.map(([ks, v]) => `<div><span>${ks.map(kbd).join('')}</span><span>${v}</span></div>`).join('');
  $('brief-controls').innerHTML =
    '<span class="lbl">CONTROLS</span>' +
    CONTROLS.filter(([ks]) => ['W', 'Drag', '1', 'R', 'F', 'Q', 'M', 'Tab', 'Space', 'H'].includes(ks[0]))
      .map(([ks, v]) => `<span>${ks.map(kbd).join('')} ${v}</span>`)
      .join('');

  // ---------------------------------------------------------------- briefing
  const m = data.mission;
  $('brief-title').textContent = m.title;
  $('brief-subtitle').textContent = `${m.subtitle} · Operational avionics flight plan`;
  $('brief-datasource').innerHTML = `DATA SOURCE: <b>${esc(data.label)}</b>`;
  const habNode = sim.world.nodes.get(m.startNodeId)!;
  const objHtml = m.objectives
    .map((o, i) => {
      const node = sim.world.nodes.get(o.nodeId)!;
      const poi = data.pois.find((q) => q.name === node.name);
      const d = Math.hypot(node.e - habNode.e, node.n - habNode.n) / 1000;
      const isRet = o.kind === 'return';
      return `<div class="obj"><span class="ms">${isRet ? 'schedule' : 'check_box'}</span><div><b>${i + 1}. ${esc(o.label)}</b><p>${esc(isRet ? 'Cycle the airlock before primary O2 or suit battery drops to the 20% flight safety reserve.' : poi?.note ?? '')}</p></div>
        <span class="tag ${isRet ? 'green' : i ? 'amber' : ''}">${isRet ? 'RTB HARD LIMIT' : `${o.nodeId} · ${d.toFixed(1)} km`}</span></div>`;
    })
    .join('');
  $('brief-objectives').innerHTML = `<h3><span><i class="sqd"></i>MISSION OBJECTIVES</span><span class="muted">PRIORITY ORDER</span></h3>${objHtml}
    <div class="obj-foot"><span>ABORT CRITERIA: O2 &lt; 20% · DOSE &gt; BUDGET · FATIGUE 100</span><b>RESERVE LINE ${RESERVE_FRAC * 100}%</b></div>`;
  const c = m.consumables;
  const bcons = (name: string, val: string, lo: string, res: string, hi: string) =>
    `<div class="bcons"><div class="row"><span><i class="dot ok"></i>${name}</span><span><b>${val}</b> <span class="ok-g">100%</span></span></div><b class="cbar"><i></i><em class="reserve" style="left:${RESERVE_FRAC * 100}%"></em></b><div class="scale"><span>${lo}</span><span class="r">▲ 20% RESERVE (${res})</span><span>${hi}</span></div></div>`;
  $('brief-consumables').innerHTML = `<h3><span><i class="sqd" style="background:var(--ok)"></i>CONSUMABLES AT EGRESS</span><span class="ok-g" style="font-size:10px">ALL SYSTEMS NOMINAL</span></h3>
    ${bcons('PRIMARY OXYGEN (O2)', `${c.o2g} g`, '0 g', `${(c.o2g * RESERVE_FRAC).toFixed(0)} g`, `${c.o2g} g`)}
    ${bcons('SUBLIMATOR COOLING WATER (H2O)', `${(c.waterg / 1000).toFixed(1)} kg`, '0 kg', `${((c.waterg * RESERVE_FRAC) / 1000).toFixed(2)} kg`, `${(c.waterg / 1000).toFixed(1)} kg`)}
    ${bcons('PLSS BATTERY', `${c.battWh} Wh`, '0 Wh', `${(c.battWh * RESERVE_FRAC).toFixed(0)} Wh`, `${c.battWh} Wh`)}
    ${bcons('RADIATION DOSE BUDGET (GCR + SPE)', `${c.doseBudgetmSv} mSv`, '0 mSv', `${(c.doseBudgetmSv * RESERVE_FRAC).toFixed(0)} mSv`, `${c.doseBudgetmSv} mSv`)}`;
  const cond = data.conditions;
  const lm = `${String(Math.floor(m.startLmstH)).padStart(2, '0')}:${String(Math.round((m.startLmstH % 1) * 60)).padStart(2, '0')}`;
  const ct = (k: string, v: string, u: string, frac: number, sub: string, col = 'var(--accent)') =>
    `<div class="cond"><span class="lbl">${k}</span><b>${v}<small>${u}</small></b><b class="cbar"><i style="width:${frac * 100}%;background:${col}"></i></b><span class="sub">${sub}</span></div>`;
  $('brief-conditions').innerHTML = `<h3><span><i class="sqd"></i>SPACE WEATHER &amp; CONDITIONS</span><span class="muted">ORBITAL METEOROLOGY SYNCED</span></h3><div class="cond-tiles">
    ${ct('SURFACE TEMP', String(cond.surfaceTempC), '°C', 0.35, 'SUIT HEATERS NOMINAL')}
    ${ct('DUST OPACITY (τ)', String(cond.dustTau), 'tau', Math.min(1, cond.dustTau / 3), 'CLEAR · VIS &gt; 10 km', 'var(--ok)')}
    ${ct('GCR DOSE RATE', String(cond.gcrDoseRateuSvH), 'µSv/h', 0.2, 'SPE WATCH ISSUED', 'var(--caution)')}
    ${ct('MISSION SOL', String(m.sol), 'MTC', 0.6, 'JEZERO CRATER')}
    ${ct('LOCAL SOLAR TIME', lm, 'LMST', m.startLmstH / 24, 'EGRESS WINDOW OPEN')}</div>`;
  const briefMap = new TacticalMap(data, sim);
  briefMap.layers.fog = false;
  briefMap.layers.radiation = true;
  $('loading').classList.add('hidden');
  $('briefing').classList.remove('hidden');
  requestAnimationFrame(() => briefMap.draw($('brief-map') as HTMLCanvasElement, { t: 0, large: true }));

  const begin = async (training: boolean) => {
    $('briefing').classList.add('hidden');
    $('hud').classList.remove('hidden');
    await audio.init();
    audio.play('ui_click');
    sim.start(training);
    hud.refreshStatic();
    hud.toast('Walk with W A S D · drag or arrow keys to look · H for help');
  };
  $('btn-begin').onclick = () => begin(false);
  $('btn-training').onclick = () => begin(true);

  // ---------------------------------------------------------------- sim events → audio/HUD
  sim.on('incident', (def: any) => audio.play(def.severity === 'emergency' ? 'alert_emergency' : def.severity === 'warning' ? 'alert_warning' : 'alert_caution'));
  sim.on('advisory', () => audio.play('reroute_chime'));
  sim.on('log', () => {
    const last = sim.log[sim.log.length - 1];
    if (last?.kind === 'sample') audio.play('sample_collect');
    if (last?.kind === 'hazard') audio.play('alert_caution');
  });
  sim.on('end', () => showDebrief());

  // ---------------------------------------------------------------- commands (voice + typed + keys share these)
  const say = (text: string, speak = false) => {
    $('cmd-feedback').textContent = `> ${text}`;
    if (speak) voice.speak(text);
  };
  const handlers = {
    toggleLayer: (l: string) => {
      const on = hud.toggleLayer(l as LayerId);
      return `${l.toUpperCase()} layer ${on ? 'on' : 'off'}`;
    },
    reroute: () => sim.requestReroute(),
    markSample: () => sim.markSample(),
    vitals: () => {
      const h = sim.health;
      return `Heart rate ${h.hr.toFixed(0)}. Oxygen ${((h.o2g / h.o2Cap) * 100).toFixed(0)} percent. Water ${((h.waterg / h.waterCap) * 100).toFixed(0)} percent. Battery ${((h.battWh / h.battCap) * 100).toFixed(0)} percent. Fatigue ${h.fatigue.toFixed(0)}. Dose ${h.doseMSv.toFixed(2)} millisievert. Core ${h.coreC.toFixed(1)} degrees.`;
    },
    drone: () => sim.launchDrone('scout'),
    mode: () => toggleVisor(),
    pace: (p?: string) => {
      if (p) {
        sim.pace = p as any;
        (sim as any).planDirty = true;
        return `Pace ${p}`;
      }
      sim.cyclePace();
      return `Pace ${sim.pace}`;
    },
    hold: () => 'Release W to hold position',
    map: () => {
      toggleMap();
      return hud.mapExpanded ? 'Map open' : 'Map closed';
    },
    help: () => 'Commands: toggle radiation, slope, POI, dust or magnetic layer; reroute; mark sample; vitals; launch drone; minimal visor; slow pace.',
  };
  const runCommand = (text: string, fromVoice: boolean) => {
    const r = parseCommand(text, handlers);
    const speakIt = fromVoice || /vitals|status|health/.test(text.toLowerCase());
    say(r.ok ? `${text} ✓ ${r.reply}` : r.reply, speakIt && r.ok && /Heart rate|Commands|Reroute|alternate/i.test(r.reply));
    if (r.ok) audio.play('ui_click');
    hud.refreshStatic();
  };
  voice.onResult = (t) => runCommand(t, true);
  voice.onState = (l) => $('btn-voice').classList.toggle('listening', l);
  $('btn-voice').onclick = () => (voice.supported ? (voice.listening ? voice.stop() : voice.start()) : say('Speech recognition not supported here; type a command instead'));
  const input = $('cmd-input') as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      runCommand(input.value, false);
      input.value = '';
      input.blur();
    }
    if (e.key === 'Escape') input.blur();
  });

  // ---------------------------------------------------------------- visor modes (AR only: full navigator vs minimal visor)
  const toggleVisor = (): string => {
    const min = document.body.classList.toggle('minimal');
    hud.refreshStatic();
    hud.updateTelemetry();
    return min ? 'Minimal visor: vitals strip only' : 'Full navigator';
  };
  const toggleHelp = (show?: boolean) => $('help').classList.toggle('hidden', show === undefined ? undefined : !show);
  $('btn-help').onclick = () => toggleHelp();
  $('help').onclick = () => toggleHelp(false);

  const toggleMap = () => {
    hud.mapExpanded = !hud.mapExpanded;
    $('map-expanded').classList.toggle('hidden', !hud.mapExpanded);
    hud.map.planning = hud.mapExpanded || hud.planning;
    hud.refreshPlanner();
  };
  $('btn-map-expand').onclick = toggleMap;
  $('btn-map-close').onclick = toggleMap;
  $('btn-plan').onclick = () => {
    hud.planning = !hud.planning;
    hud.map.planning = hud.planning;
    $('btn-plan').classList.toggle('on', hud.planning);
    if (!hud.planning) sim.plannerClear();
    say(hud.planning ? 'Planner on: click map to add waypoints' : 'Planner off');
  };
  const mapClick = (canvas: HTMLCanvasElement, requirePlanning: boolean) => (ev: MouseEvent) => {
    if (requirePlanning && !hud.planning) return;
    const r = canvas.getBoundingClientRect();
    const p = hud.map.fromPx(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height);
    const node = sim.plannerAdd(p.e, p.n);
    say(node ? `Waypoint ${sim.plannerNodes.length}: ${node.name}` : 'No traverse node near that point');
    hud.refreshPlanner();
  };
  $('map-canvas').addEventListener('click', mapClick($('map-canvas') as HTMLCanvasElement, true));
  $('map-canvas-large').addEventListener('click', mapClick($('map-canvas-large') as HTMLCanvasElement, false));
  $('btn-plan-commit').onclick = () => {
    if (sim.plannerCommit()) {
      say('Planned route committed');
      if (hud.mapExpanded) toggleMap();
      hud.planning = false;
      $('btn-plan').classList.remove('on');
    }
  };
  $('btn-plan-clear').onclick = () => sim.plannerClear();
  $('btn-reroute-accept').onclick = () => say(sim.acceptAdvisory());
  $('ar-reroute').onclick = () => say(sim.acceptAdvisory());
  $('btn-reroute-dismiss').onclick = () => sim.dismissAdvisory();
  const droneToggle = () => {
    if (sim.drone.active) {
      sim.recallDrone();
      return 'Drone recalled';
    }
    return sim.launchDrone('scout');
  };
  $('btn-drone').onclick = () => say(sim.launchDrone('scout'));
  $('btn-drone-recall').onclick = () => sim.recallDrone();
  const mute = () => ($('btn-mute').innerHTML = `<span class="ms">${audio.toggleMute() ? 'volume_off' : 'volume_up'}</span>`);
  $('btn-mute').onclick = mute;

  // ---------------------------------------------------------------- look controls (drag)
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
    sim.lookYaw += (e.clientX - lx) * 0.004;
    world.pitch = Math.max(-1.2, Math.min(0.9, world.pitch - (e.clientY - ly) * 0.003));
    lx = e.clientX;
    ly = e.clientY;
  });
  vp.addEventListener('pointerup', () => (dragging = false));
  vp.addEventListener('dblclick', () => (world.pitch = -0.05));

  // ---------------------------------------------------------------- keyboard
  const held = new Set<string>();
  const typing = () => document.activeElement === input;
  window.addEventListener('blur', () => held.clear());
  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    if (sim.status !== 'active') return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'shift', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) {
      held.add(k);
      if (k.startsWith('arrow')) e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      say(toggleVisor());
      return;
    }
    if (sim.incident && ['1', '2', '3', '4'].includes(k)) {
      sim.resolveIncident(Number(k) - 1);
      audio.play('ui_click');
      return;
    }
    if (['1', '2', '3', '4'].includes(k)) {
      sim.choose(Number(k) - 1);
      audio.play('ui_click');
      hud.refreshStatic();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      if (voice.supported) voice.start();
      else say('Speech not supported in this browser; press Enter to type');
      return;
    }
    switch (k) {
      case 'r':
        say(sim.advisory ? sim.acceptAdvisory() : sim.requestReroute());
        break;
      case 'x':
        sim.dismissAdvisory();
        break;
      case 'f':
        say(sim.markSample());
        break;
      case 'g':
        sim.cyclePace();
        say(`Pace ${sim.pace}`);
        break;
      case 'q':
        say(droneToggle());
        break;
      case 'v':
        say(handlers.vitals(), true);
        break;
      case 'm':
        toggleMap();
        break;
      case 'h':
        toggleHelp();
        break;
      case 'k':
        mute();
        break;
      case 'c':
        world.pitch = -0.05;
        break;
      case 'enter':
        e.preventDefault();
        input.focus();
        break;
      case '[':
        sim.warp = Math.max(1, Math.round(sim.warp / 2));
        break;
      case ']':
        sim.warp = Math.min(120, sim.warp * 2);
        break;
      case '0':
        sim.warp = WARP;
        break;
      case 'escape':
        if (!$('help').classList.contains('hidden')) toggleHelp(false);
        else if (hud.mapExpanded) toggleMap();
        break;
      default:
        return;
    }
    if (['r', 'x', 'f', 'g', 'q'].includes(k)) audio.play('ui_click');
    hud.refreshStatic();
  });
  window.addEventListener('keyup', (e) => {
    held.delete(e.key.toLowerCase());
    if (e.key === 'Shift') held.delete('shift');
    if (e.code === 'Space' && !typing()) setTimeout(() => voice.stop(), 400);
  });
  const applyInput = (dt: number) => {
    const blocked = typing() || hud.mapExpanded || !!sim.incident || sim.status !== 'active';
    const h = (k: string) => (!blocked && held.has(k) ? 1 : 0);
    sim.input.f = h('w') - h('s');
    sim.input.r = h('d') - h('a');
    sim.input.sprint = !!h('shift');
    sim.lookYaw += (h('arrowright') - h('arrowleft')) * 1.6 * dt;
    world.pitch = Math.max(-1.2, Math.min(0.9, world.pitch + (h('arrowup') - h('arrowdown')) * 0.9 * dt));
  };

  // ---------------------------------------------------------------- debrief
  const showDebrief = () => {
    $('hud').classList.add('hidden');
    $('incident-modal').classList.add('hidden');
    $('help').classList.add('hidden');
    $('map-expanded').classList.add('hidden');
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
    $('debrief-sub').textContent = `${m.title} // MET ${fmtMET(sim.met)} // SOL ${m.sol}${sim.training ? ' // TRAINING MODE' : ''}${failed ? ' // crew member recovered by rover rescue in simulation' : ' // airlock pressurised'}`;
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
    $('debrief-rc-title').innerHTML = `<i class="sqd" style="background:${failed ? 'var(--warning)' : 'var(--accent)'}"></i>${failed ? 'ROOT CAUSE TRAJECTORY FAILURE' : 'NAVIGATOR IMPACT'}`;
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
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const wasIncident = !!sim.incident;
    applyInput(dt);
    sim.update(dt);
    if (wasIncident && !sim.incident) hud.refreshStatic();
    world.update(dt);
    world.render($('drone-pip'));
    if (sim.status === 'active') {
      hud.update(dt);
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
  void fmtDur;
}

boot();
