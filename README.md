# TEVAN · Tactical EVA Navigator

A helmet navigator for astronauts on a Marswalk, built for NASA Space Apps 2026 ("Interplanetary Survival Guide: Martian Map"). The screen is the inside of the helmet: you see Jezero Crater through a curved visor, and TEVAN draws on the glass.

**Thesis:** on Mars, an astronaut's health risk is a function of geography. The map causes the risk, the health model measures it, and the route engine changes the route to avoid it.

There are no modes. There's no training mode, VR mode or AR mode, only the astronaut on an EVA.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (camera + mic work on localhost)
npm run build      # static site in dist/
npm test           # engine tests (full mission autoplay) + voice grammar
```

Use **Chrome or Edge**. Voice uses the Web Speech API, which Firefox and Safari don't fully support. Camera and microphone only work on `https://` or `localhost`.

## How the astronaut uses it

| Input | Does |
|---|---|
| **Voice** (always listening) | Every command, hands-free. Say "what can I say" to list them. |
| **Eyes** (webcam gaze) | Look at a feature, then say **"launch this feature"** or **"check this feature's progress"** |
| W A S D, Shift | Walk, strafe, sprint |
| Mouse drag, arrow keys | Look around |
| Mouse wheel | Optical zoom, 1–6× (double-click resets) |
| Click a feature | Same as looking at it and saying "launch this" (fallback) |
| Enter | Type a command if no microphone is available |

### Voice commands

- **Gaze-targeted:** "launch this (feature)", "check this feature's progress"
- **Layers:** "show / hide / toggle radiation · slope · POI · dust · magnetic · fog"
- **Route:** "reroute", "accept", "dismiss", "open map", "commit route", "clear route", "close"
- **Decisions:** "option one / two / three", "route two", "take route one"
- **Suit:** "vitals", "check oxygen", "battery status", "how is my fatigue", "slow pace"
- **Drone:** "launch drone", "recall drone", "drone relay", "check drone progress"
- **Science:** "mark sample"
- **Visor:** "zoom in / out", "reset zoom", "calibrate", "mute", "stop listening" / "resume listening"

The parser (`src/ui/voice.ts`) is a deterministic grammar, so the same words always give the same command. No LLM or API key is needed.

### Gaze

`src/ui/gaze.ts` runs MediaPipe Face Landmarker in the browser, tracking one face (`numFaces: 1`). It uses iris position inside each eye opening, plus head yaw and pitch, as features. A 9-dot calibration before egress fits a ridge regression from those features to screen position, and a One Euro filter smooths the result. Without calibration, TEVAN falls back to head pointing. `src/ui/targets.ts` snaps the gaze point to the nearest `data-gaze` element. A target has to hold for 160 ms before it locks, and "this" refers to whatever was locked while you were speaking, up to 2.5 s earlier. No video leaves the device.

The WASM runtime is copied from `node_modules` into `public/mediapipe/` on `predev` and `prebuild`. The face model is in `public/models/`. If either is missing, the app loads them from the official CDN.

## Visor layout

- **Dynamic island** (top centre). In its compact form it shows MET, the next waypoint with a direction arrow, and local solar time. It expands for incidents, reroute advisories, junction choices, holds, and feature status cards, so only one thing asks for attention at a time. The **voice capsule** next to it shows what TEVAN hears and what it did.
- **Halo vitals** (left). Rings for O₂, H₂O, power, dose and fatigue, with heart rate, speed and pace underneath.
- **Radar** (right). A heading-up minimap showing the route, the advisory alternate, hazards, fog of war, and the active layers.
- **Feature dock** (bottom). Route, Drone, Sample, Layers. Each icon's halo shows that feature's progress: the share of the route walked, drone battery, samples sealed, and layers on.
- **Navigator panel** ("open map"). The full map with layer toggles, a click-to-add route planner (distance, elevation gain, max slope, time, peak fatigue, O₂ at the end), and the vitals forecast chart.
- The curved visor is a post-processing lens pass (`src/render/scene.ts`). It applies barrel curvature, a chromatic fringe at the edges and rim falloff. World markers are projected through the same curve so they stay on their targets.

## Judging criteria → where to see them

| # | Criterion | In TEVAN |
|---|---|---|
| 1 | Layered map, toggleable overlays | "Show radiation" / "show slope" / "hide POI". Each one repaints the radar and the Navigator map. |
| 2 | Route drawing with metrics | "Open map", click 4 waypoints. You get distance, elevation gain, max slope and estimated time, then "commit route". |
| 3 | Health model coupled to route | The dashed forecast lines in the Navigator chart and the Route card ("check route progress") change with every route choice. |
| 4 | Hazard-triggered rerouting | When fatigue crosses 70 (or O₂ forecast falls below reserve), the island expands with the reason, a now-vs-alternate comparison, and the alternate drawn on the radar. |
| 5 | AR HUD | The whole visor: ground chevrons, waypoint and hazard labels, halo vitals, dose vignette. |
| 6 | Continuity | There's one view and one simulation state. Opening the map, zooming, recalibrating or deciding never resets position, route or vitals. |
| 7 | Voice command | "show radiation", "reroute", "mark sample", "vitals". These are always on, with no push-to-talk. |
| 8 | Drone scout | "launch drone" (or look at Drone and say "launch this"). It flies ahead, clears fog of war, finds hidden hazards, and streams a live feed to the visor. |

Demo-operator keys (not part of the astronaut UX): `[` and `]` change time warp.

## Hosting

TEVAN is a static site, so deploy it to **Netlify**:

- build command `npm run build`
- publish directory `dist`

HTTPS is automatic, and camera and mic need it. It only needs a server (Railway, or a Netlify Function) if you add something secret, such as an LLM API key.

## Architecture

```
src/
  data/            DATA CONTRACT (swap point for NASA data, ?data=<name>)
  core/            framework-free engine: route graph + metrics, health model, forecast, sim
  render/scene.ts  Three.js world, chevrons, drone + PIP camera, curved visor lens pass, zoom
  ui/hud.ts        visor HUD (dynamic island, halos, radar, dock, detail cards); bound by element IDs
  ui/map.ts        tactical map + heading-up radar
  ui/voice.ts      continuous speech recognition + command grammar
  ui/gaze.ts       MediaPipe face/iris tracking, calibration, smoothing
  ui/targets.ts    gaze → feature targeting
  ui/audio.ts      named sound slots (see AUDIO.md)
tools/convert_geotiff.py   NASA GeoTIFF → simulator grids
```

### Swapping in NASA data (14 Nov)

1. Convert the rasters: `python tools/convert_geotiff.py --out public/data/nasa-jezero --elevation dtm.tif ...`
2. Open `/?data=nasa-jezero`. Missing layers fall back to synthetic ones.

### Health model

The model is unchanged from v1, and every constant is auditable in `src/core/health.ts`: Pandolf metabolic cost at 0.38 g, O₂ from metabolic energy, sublimator water, battery draw, sky-view-shielded GCR dose, and a fatigue index with a reroute threshold of 70. All synthetic values are plausible placeholders. They are not mission data.
