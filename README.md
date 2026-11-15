# TEVAN · Tactical EVA Navigator

A helmet navigator for astronauts on a Marswalk, built for NASA Space Apps 2026 ("Interplanetary Survival Guide: Martian Map"). The screen is the inside of the helmet: you see **real Jezero Crater terrain** through a curved visor, and TEVAN draws on the glass. You control it with your voice, your eyes (webcam) and the keyboard and mouse.

**Thesis:** on Mars, an astronaut's health risk is a function of geography. The map causes the risk, the health model measures it, and the route engine changes the route to avoid it.

There are no modes: no training, VR or AR mode, only the astronaut on an EVA.

**Live:** https://tactical-eva-navigator.netlify.app/ · **[User Manual](docs/USER_MANUAL.md)** · **[Changelog](docs/CHANGELOG.md)**

## Quick start

> **Use Google Chrome or Microsoft Edge on a laptop or desktop with a webcam and microphone.**
> Firefox can't do voice commands, and Safari's support is unreliable.

1. Open https://tactical-eva-navigator.netlify.app/ and **allow the camera and microphone**.
2. Click **"Calibrate gaze & begin EVA"**. After a 3, 2, 1 countdown, follow the dot with your eyes (13 dots, then 3 check dots, about 30 s). Keep your head still.
3. **Voice check:** stay quiet for a second, say **"Hi TEVAN"**, then read the five short commands on screen. TEVAN learns how your accent comes through.
4. Walk with **W A S D** (Shift to sprint), **Space** to jump, **drag** to look, **scroll** to zoom. Follow the blue **ground arrows**.
5. Talk to TEVAN. It is always listening. Try "what can I say", "open map", "show radiation", "vitals", "reroute", "launch drone", "rover feed", and look at a rock and say **"what is this"** or **"label this as a hazard"**.
6. Look at a dock icon and say **"launch this feature"** or **"check this feature's progress"**. Its ID card stays for 3.5 s after you look away.

No camera or mic? Click **"Begin without gaze and mic"**: the mouse pointer stands in for your eyes, and **Enter** opens a typed command line (type "voice check" to turn the mic on later). Every calibration screen has a **Skip** button.

The full guide to every feature is in the **[User Manual](docs/USER_MANUAL.md)**.

## Features

| Feature | Summary |
|---|---|
| Helmet visor HUD | Curved visor, dynamic island, halo vitals, heading-up radar, feature dock, status chips |
| Real NASA terrain | HiRISE 1 m DTM and 25 cm photo of a 4 × 4 km window around the Perseverance landing site; Perseverance's real traverse |
| Gaze | Webcam eye tracking in the browser, 13-point calibration, look-to-identify ID cards that hold 3.5 s |
| Voice | Always-on, grammar plus meaning-based matching, "Did you mean …?", accent learning ("voice check", "forget my accent"), typed commands with Enter, never acts on its own voice |
| Navigator map | Street-map style zoom, pan, search, category chips, place cards, labels, layer toggles |
| Route planning | Click waypoints for distance, elevation gain, max slope, time, peak fatigue and O₂ at the end; commit to drive the ground arrows |
| Health model and forecast | Terrain-driven O₂, water, power, dose and fatigue; forecast chart changes with the route |
| Rerouting | Fatigue over 70 or O₂ below reserve triggers an alternate with its reason and a comparison |
| Guardian | Dust storm, marsquake rockfall, low consumables with supply caches, fall check with auto mayday, hazard zones |
| Look and ask | "What is this" answers from map data; "label this" pins coloured tags |
| Drone scout | Clears fog of war, finds hidden hazards, live picture-in-picture feed, radio relay |
| Rover feed | Perseverance's newest raw images and per-sol Navcam frames, live from NASA |
| Traceability | Mission log, "repeat that", "undo", JSON log export, seeded repeatable scenario |

## Caveats

| Topic | What to know |
|---|---|
| Browser | Chrome or Edge for voice. On other browsers the start screen warns you, and **Enter** opens a typed command line. |
| HTTPS | Camera and mic only work on `https://` or `localhost`, not `file://`. Netlify provides HTTPS. |
| Privacy | Gaze runs entirely in the browser; no video leaves the computer. Chrome/Edge speech recognition sends audio to Google or Microsoft to turn it into text. The accent profile stays in the browser. |
| Internet | Needed for voice, fonts and the rover feed. Gaze, the map and the simulation work offline once loaded. |
| Gaze accuracy | A laptop webcam can tell which feature you're looking at, not a tiny button. Targets are deliberately large. |
| Performance | The first load downloads a ~13 MB eye-tracking model and ~6.5 MB of terrain. Gaze runs fastest with a GPU. |
| Data | Terrain, imagery and the rover traverse are real NASA data. The health model, incidents, crew and caches are simulated with documented placeholder values. |
| Permissions denied by mistake | Click the camera/lock icon in the address bar, allow Camera and Microphone, reload. |

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

## Run it locally (developers)

You need [Node.js 20+](https://nodejs.org).

```bash
git clone https://github.com/itzjayden04/tactical-eva-navigator.git
cd tactical-eva-navigator
npm install
npm run dev        # open http://localhost:5173 in Chrome or Edge
```

Other commands:

```bash
npm run build      # production build into dist/
npm run preview    # serve the production build at http://localhost:4173
npm test           # engine, guardian, voice grammar, intent, accent, map and NASA data tests
```

## Deploy to Netlify

- **Connect the repo:** on app.netlify.com choose *Add new site → Import from Git → tactical-eva-navigator*. Settings come from `netlify.toml` (build `npm run build`, publish `dist`).
- **Drag and drop:** run `npm run build`, then drag `dist/` onto https://app.netlify.com/drop.

## Architecture

```
src/
  data/              DATA CONTRACT (swap point for NASA data, ?data=<name>)
  data/roverFeed.ts  live Perseverance raw images (NASA JSON API)
  core/              framework-free engine: route graph + metrics, health model, forecast, sim
  core/terrain.ts    boulders, traversability grid, A* guide path, stumble risk
  core/guardian.ts   active responses (storm, quake, consumables, falls, geofence), tags, describe, crew
  render/scene.ts    Three.js world, chevrons, drone + PIP camera, curved visor lens pass, zoom
  ui/hud.ts          visor HUD (dynamic island, halos, radar, dock, detail cards); bound by element IDs
  ui/map.ts          tactical map rendering + heading-up radar
  ui/mapnav.ts       street-map Navigator: zoom, pan, search, place cards, labels, plan mode
  ui/holo.ts         gaze ID cards anchored in 3D (3.5 s hold)
  ui/voice.ts        continuous speech recognition + command grammar
  ui/intent.ts       in-browser meaning-based intent matcher ("Did you mean …?")
  ui/accent.ts       accent learning from the voice check and confirmed phrases
  ui/gaze.ts         MediaPipe face/iris tracking, calibration, smoothing
  ui/targets.ts      gaze → feature targeting
  ui/audio.ts        named sound slots (see AUDIO.md)
tools/fetch_nasa_jezero.py  builds the real Jezero dataset from NASA/USGS sources
tools/convert_geotiff.py    any other NASA GeoTIFF → simulator grids
docs/USER_MANUAL.md         end-user guide
docs/CHANGELOG.md           feature history (v1 to v4)
```

### How gaze works

`src/ui/gaze.ts` runs MediaPipe Face Landmarker in the browser, tracking one face (`numFaces: 1`). It uses iris position inside each eye opening, plus head yaw and pitch, as features. Calibration starts after a 3-second countdown and shows 13 dots. Blink frames are dropped, each dot's samples are filtered against their median, and a ridge regression with quadratic terms maps features to screen position. Three unseen check dots then measure the real error and remove any constant offset, and TEVAN reports the accuracy honestly (Good / Fair / Low). A One Euro filter smooths the result. Without calibration, TEVAN falls back to head pointing. `src/ui/targets.ts` snaps the gaze point to the nearest `data-gaze` element. A target has to hold for 160 ms before it locks, and "this" refers to whatever was locked while you were speaking, up to 2.5 s earlier. No video leaves the device.

The WASM runtime is copied from `node_modules` into `public/mediapipe/` on `predev` and `prebuild`. The face model is in `public/models/`. If either is missing, the app loads them from the official CDN.

### Voice

The grammar in `src/ui/voice.ts` is deterministic: the same words always give the same command. If it doesn't match, `src/ui/intent.ts` scores the browser's top four guesses against every intent using a synonym lexicon, sound codes and spelling similarity, and either runs the command or asks "Did you mean …?". `src/ui/accent.ts` applies word substitutions learned in the voice check first. The recogniser is paused while TEVAN speaks. No LLM or API key is used.

### Data sets

- Default: `public/data/nasa-jezero/` (real NASA data, see [Data sources](docs/USER_MANUAL.md#18-data-sources)).
- `/?data=mock`: the synthetic terrain.
- Another GeoTIFF: `python tools/convert_geotiff.py --out public/data/<name> --elevation dtm.tif ...`, then open `/?data=<name>`. Missing layers fall back to synthetic ones.

The dataset in `public/data/nasa-jezero/` (about 6.5 MB) is built by one command that reads only the needed window of the multi-gigabyte mosaics over HTTP:

```bash
pip install rasterio numpy scipy scikit-image pillow
python tools/fetch_nasa_jezero.py          # writes public/data/nasa-jezero/
```

### Health model

Every constant is auditable in `src/core/health.ts`: Pandolf metabolic cost at 0.38 g, O₂ from metabolic energy, sublimator water, battery draw, sky-view-shielded GCR dose, and a fatigue index with a reroute threshold of 70. All synthetic values are plausible placeholders. They are not mission data.

## Credits

Terrain and imagery: NASA/JPL-Caltech, University of Arizona (HiRISE), USGS Astrogeology. Perseverance traverse and raw images: NASA/JPL-Caltech. No NASA or Artemis logos are used.
