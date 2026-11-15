# TEVAN · Tactical EVA Navigator

A helmet navigator for astronauts on a Marswalk, built for NASA Space Apps 2026 ("Interplanetary Survival Guide: Martian Map"). The screen is the inside of the helmet: you see Jezero Crater through a curved visor, and TEVAN draws on the glass.

**Thesis:** on Mars, an astronaut's health risk is a function of geography. The map causes the risk, the health model measures it, and the route engine changes the route to avoid it.

There are no modes. There's no training mode, VR mode or AR mode, only the astronaut on an EVA.

## Quick start

> **Use Google Chrome or Microsoft Edge on a laptop or desktop with a webcam and microphone.**
> Firefox can't do voice commands, and Safari's support is unreliable.

1. **Open the live link:** https://tactical-eva-navigator.netlify.app/
2. **Allow the camera and microphone** when the browser asks. TEVAN uses your laptop's built-in webcam, so no extra hardware is needed.
3. Click **"Calibrate gaze & begin EVA"**. After a **3, 2, 1 countdown**, follow the dot with your eyes (13 dots, then 3 check dots, about 30 seconds). Keep your head still.
4. **Voice check:** stay quiet for a second, then say **"Hi TEVAN"**. TEVAN measures your room noise, your voice level and pitch, and learns how the browser spells "TEVAN" for your voice.
5. You're on Mars. Walk with **W A S D** (Shift to sprint), **Space** to jump, **drag the mouse** to look around, and **scroll** to zoom. Follow the blue **ground arrows**.
6. **Talk to TEVAN.** It is always listening, so there's no button to press. Start with:
   - "what can I say"
   - look at a rock, the ground, your crewmate or the habitat and say **"what is this"**
   - look at something and say **"label this as a hazard"** (or just "label this" and TEVAN asks what it is)
   - "call for help", "back to habitat", "nearest shelter", "go to cache", "rest"
   - "vitals", "show radiation", "reroute", "mark sample", "launch drone"
   - "show log", "repeat that", "undo", "tools"
   - look at a feature (an oxygen ring, the radar, a dock icon) and say **"launch this feature"** or **"check this feature's progress"**

The camera and microphone icons at the top turn **green** while they are working and stay **dim grey** when they are not. Hover them for the reason.

No camera or microphone, or you'd rather skip calibration? Click **"Begin without gaze and mic"**: the mouse pointer stands in for your eyes, and you press **Enter** to type commands instead of speaking (type "voice check" to turn the mic on later). Every calibration screen has a **Skip** button. Say **"voice check"** during the EVA to repeat the voice check, and **"calibrate"** to redo the gaze calibration.

### Tips for good gaze tracking

- Light your face **from the front**. A bright window behind you makes tracking much worse.
- Sit about **an arm's length** from the screen, with your face centred in the camera.
- Only **one person** should be in front of the camera. TEVAN tracks a single face.
- If the highlight drifts, say **"calibrate"** to redo the calibration.

### Tips for voice

- Speak normally, in short commands. The bubble next to the top pill shows what TEVAN heard.
- TEVAN ignores its own spoken replies, so wait for it to finish talking before your next command.
- A quiet room helps. Speakers turned up loud can trigger false commands, so headphones are best.
- Say **"stop listening"** to pause the mic and **"resume listening"** to turn it back on.

### Caveats

| Topic | What to know |
|---|---|
| Browser | Chrome or Edge only for voice. On other browsers the start screen warns you, and **Enter** opens a typed command line instead. |
| HTTPS | Camera and mic only work on `https://` or `localhost`. Netlify provides HTTPS automatically. Opening `index.html` straight from disk (`file://`) won't work. |
| Privacy | Gaze runs entirely in your browser, and no video leaves the computer. Chrome/Edge speech recognition sends audio to the browser vendor's speech service (Google or Microsoft) to turn it into text. |
| Internet | Needed for voice (the speech service) and fonts. Gaze, the map and the simulation work offline once loaded. |
| Gaze accuracy | A laptop webcam can tell which feature you're looking at, but not pick out a tiny button. Targets are deliberately large. |
| Performance | Gaze runs fastest with a GPU. On weak machines, close other tabs. The first load downloads a ~13 MB eye-tracking model and runtime. |
| Data | Terrain, radiation and incidents are **synthetic placeholders** until the NASA challenge data is loaded (see "Swapping in NASA data"). |
| Permissions denied by mistake | Click the camera/lock icon in the address bar → allow Camera and Microphone → reload. |

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
npm test           # engine tests (full mission autoplay) + voice grammar
```

## Deploy to Netlify

Choose either option.

- **Connect the repo:** on app.netlify.com choose *Add new site → Import from Git → tactical-eva-navigator*. The settings come from `netlify.toml` (build `npm run build`, publish `dist`).
- **Drag and drop:** run `npm run build` locally, then drag the `dist/` folder onto https://app.netlify.com/drop.

## What's new in v4: mixed-reality labels, intent voice, street-map Navigator

**Look-to-identify ID cards (mixed reality).** The moment your eyes land on a boulder, a site, your crewmate, the drone or a tag, an ID card appears beside it, anchored to the object in 3D. Look away, or turn all the way around, and the card stays for **3.5 s** with a countdown ring. While the object is out of view, the card rides on the visor edge on the side the object is, with an arrow and how far to turn ("Turn 146° left · 904 m"). Up to three cards at a time. (`src/ui/holo.ts`)

**Voice that understands meaning, not exact phrases.** The strict grammar still runs first. If it does not match, an in-browser intent model takes over (no API key, no network): a synonym lexicon maps words to concepts, misheard words are rescued by sound (Metaphone-style codes) and spelling (Jaro-Winkler), and an IDF-weighted similarity picks the intent and fills its slots (which layer, which consumable, on/off). Chrome's top 4 recognition guesses are all scored, which helps with accents. Confident guesses run and show "≈ what TEVAN understood"; unsure ones ask "Did you mean …?" and wait for yes or no. Small talk is ignored. Examples that now work: "so radiation", "sure the radiation lair", "how much oxy gen left", "send the drawn out", "we route", "find me a better way", "am I okay", "take pitcher". (`src/ui/intent.ts`)

**TEVAN never acts on its own voice.** The speech recogniser is stopped while TEVAN talks (anything it had buffered is dropped) and restarts 0.6 s after the speech ends. Results that arrive during speech or a sound cue are ignored, and a transcript finalised right after TEVAN spoke that is mostly TEVAN's own words is discarded as an echo. (`src/ui/voice.ts`)

**TEVAN learns your accent, and takes commands from anyone.** There is no speaker or pitch check: any crew member can give commands. Instead, after "Hi TEVAN" the voice check asks you to read five short commands. Each heard sentence is aligned word by word with the one you were asked to read, and every word the recogniser spells differently for your accent is learned ("mop" = map, "oxy gin" = oxygen, "emergence" = emergency). From then on, spoken commands are read with your learned spellings first, then the grammar and the meaning-based matcher handle the rest. TEVAN also keeps learning while you work: when it asks "Did you mean …?" and you say yes, that exact phrase runs straight away next time (never for a mayday). The profile stays in this browser (localStorage). Say "voice check" to add more, or "forget my accent" to reset. (`src/ui/accent.ts`)

**Navigator map with street-map interaction.** Scroll, trackpad-pinch or touch-pinch to zoom around the cursor, drag to pan, double-click to zoom, `+`/`−` and arrow keys, buttons for zoom, "centre on me" and "whole area". Zoomed in, the map switches to the full 1 m/px HiRISE orthophoto, and more labels appear (junction names, traverse names, denser Perseverance sol stops) with collision-free placement. Search box (`/`) finds places, your labels, crew, traverses, `sol 120`, or coordinates like `18.445, 77.44`; category chips frame all shelters, caches, science sites, hazards, labels or crew. Click anything (or empty ground to drop a pin) for a place card with coordinates, elevation, slope, dose rate and distance, plus **Navigate**, **Add waypoint**, **Label** (name + colour; shows in the visor too) and, at rover stops, the real Perseverance panorama. "Plan route" mode keeps click-to-add-waypoint. (`src/ui/mapnav.ts`, `src/ui/map.ts`)

## What's new in v3: real NASA data

TEVAN now walks you across **real Jezero Crater**, not a procedural stand-in.

| What you see | Real source |
|---|---|
| Terrain under your boots, slopes, the delta scarp on the horizon, the Kodiak butte | HiRISE 1 m/px digital terrain model from the Mars 2020 Terrain Relative Navigation maps (NASA/JPL-Caltech, University of Arizona, USGS Astrogeology) |
| Ground texture in the visor and the map base | HiRISE 25 cm/px orthomosaic from the same set, the imagery NASA Mars Trek and the USGS Astrogeology hub serve |
| The blue route on the map and the wheel tracks in the visor | Perseverance's actual traverse, sols 13 to 760, from NASA/JPL's MMGIS service |
| "Rover feed" tool and the photos in "what is this" | NASA's live Mars 2020 raw-image feed (mars.nasa.gov/mars2020/multimedia/raw-images) |
| Rock roughness, terrain radiation shielding, dust | Computed from the real DTM and orthophoto |

- **Where you are:** a 4 × 4 km window around the **Octavia E. Butler landing site** (18.4446° N, 77.4509° E). The habitat sits where Perseverance touched down on 18 Feb 2021. Sample 1 is at the northern margin of Séítah, sample 2 at the western delta front, and the relay point is on top of the delta.
- **Look at the ground Perseverance drove over and say "what is this".** TEVAN tells you the sol it passed and shows the rover's own Navcam frames from that sol, fetched live from NASA.
- **Say "rover feed"** (or "latest rover images") for Perseverance's newest raw images.
- **"Where am I"** now answers in latitude and longitude.
- **Map layer "rover route"** toggles Perseverance's traverse ("show rover layer").
- **Artemis-era visor style:** Earth-blue primary, signal-red alarms, condensed display type. Colours and type only; no NASA or Artemis logos are used.
- `?data=mock` still loads the synthetic terrain, and TEVAN falls back to it automatically if the NASA files can't load.
- NASA Worldview was checked too, but it covers Earth only, so it isn't used.

The dataset in `public/data/nasa-jezero/` (about 6.5 MB) is built by one command that reads only the needed window of the multi-gigabyte mosaics over HTTP:

```bash
pip install rasterio numpy scipy scikit-image pillow
python tools/fetch_nasa_jezero.py          # writes public/data/nasa-jezero/
```

## What's new in v2

**An active guardian, not a passive display.** TEVAN watches the astronaut and the terrain and acts:

| Situation | What TEVAN does |
|---|---|
| Dust storm front (after the first sample) | Warns 90 s ahead, turns on stability assist, slows the pace or holds you in place, releases assist when the storm passes |
| Marsquake (after the second sample) | Shakes the view, drops rockfall that **closes a traverse**, replans the route home before asking you, offers a drone scout of the new route |
| Oxygen or battery below normal (45% / 30%) | Compares options with numbers: nearest **supply cache** (guided off-road around boulders), return to habitat, or slow pace / shed loads |
| Half oxygen, oxygen below reserve, low cooling water | Spoken reminder with the forecast at the habitat and the nearest cache |
| Fall | "Are you OK?" card with a 15 s timer. No answer means TEVAN sends a **mayday** with your position. Two falls turn stability assist on |
| Entering a hazard zone | Spoken warning, stability assist on, off again when you leave |
| High heart rate or core temperature | Suggests "rest" or "slow pace" |
| Path blocked | Tells you to jump a low rock (Space) or follow the arrows around a boulder or steep slope |
| Loss of signal while calling for help | Launches the drone as a relay automatically |

"Increase suit gravity" isn't physically possible, so TEVAN does the real-world equivalent: **stability assist** braces the suit's joints, cuts stumble risk by about 70% and caps speed.

**Emergency quick actions** (the red SOS icon, or by voice): Call for help, Back to habitat, Nearest shelter, Resupply, Rest 5 min, Stability assist.

**Tags.** Look at anything and say "label this". TEVAN outlines what you're looking at, asks what it is if it can't tell, and pins a coloured tag: teammate (blue), habitat (green), destination (pink), hazard (red), sample (cyan), resource (amber), note (lilac). A tag on your crewmate EV-2 follows them as they move. "Go to tag" navigates there; "remove tag" and "undo" take it back.

**"What is this".** Look at a boulder, the ground, a cache, the habitat, EV-2 or the rover and ask. TEVAN outlines it and answers out loud: size and whether you can jump it, slope and footing, dose rate, which traverse it's on, cache contents, and so on. This is all computed from the map data, so **no AI API or key is needed**.

**AR ground arrows.** The arrows follow a live A* path from your feet: around boulders, rubble and slopes over 31°, along the cheapest ground, through each waypoint. They change the moment you reroute, divert to a cache or tag, or the terrain changes. Pink arrows mean an off-route destination, amber means an emergency route.

**Real terrain.** Boulders block you (you slide around them), low rocks can be jumped with Space (about 0.8 m, 1.3 s of Mars hang time), slopes over 34° can't be climbed, and loose rock, slope, sprinting, dust and fatigue can make you **stumble or fall**. The camera jolts, drops to the ground and gets back up.

**Status visibility, traceability, interactivity, repeatability.**
- Everything that is "on" shows as a chip under the vitals (navigation target, stability assist, storms, blocked traverses, poor footing, help en route).
- "Show log" opens the mission log with the full conversation: what you said, what TEVAN said, EV-2 and the habitat. "Export log" on the debrief saves it as JSON with tags, photos and comms.
- Every action works by voice, by gaze + "launch this", or by click.
- The scenario is seeded: the same choices always give the same boulders, events and outcomes. "Repeat that" replays the last spoken line.

**Tools** (dock icon or "tools"): Team (EV-2 and rover positions, comms link), Supplies (caches), Systems (mic, camera, comms, faults), Weather (dust, radiation, seismic), Tags, Log, Photo, What is this.

## How the astronaut uses it

| Input | Does |
|---|---|
| **Voice** (always listening) | Every command, hands-free. Say "what can I say" to list them. |
| **Eyes** (webcam gaze) | Look at a feature, then say **"launch this feature"** or **"check this feature's progress"** |
| W A S D, Shift | Walk, strafe, sprint |
| Space | Jump (clears rocks under 0.7 m) |
| Mouse drag, arrow keys | Look around |
| Mouse wheel | Optical zoom, 1–6× (double-click resets) |
| Click a feature | Same as looking at it and saying "launch this" (fallback) |
| Enter | Type a command if no microphone is available |

### Voice commands

- **Gaze-targeted:** "launch this (feature)", "check this feature's progress"
- **Layers:** "show / hide / toggle radiation · slope · POI · dust · magnetic · fog · rover"
- **Route:** "reroute", "accept", "dismiss", "open map", "commit route", "clear route", "close"
- **Decisions:** "option one / two / three", "route two", "take route one"
- **Suit:** "vitals", "check oxygen", "battery status", "how is my fatigue", "slow pace"
- **Drone:** "launch drone", "recall drone", "drone relay", "check drone progress"
- **Science:** "mark sample"
- **Emergency:** "call for help" / "mayday", "back to habitat", "nearest shelter", "go to cache", "resupply", "rest", "stability on / off", "resume mission", "cancel navigation"
- **Look and ask:** "what is this", "label this (as hazard / teammate / destination / …)", "remove tag", "go to tag", "take me to my teammate"
- **Tools:** "tools", "team status", "show supplies", "system status", "how is the weather", "show tags", "show log", "take a photo", "where am I", "rover feed"
- **Traceability:** "repeat that", "undo"
- **Visor:** "zoom in / out", "reset zoom", "calibrate", "voice check", "mute", "stop listening" / "resume listening", "jump"
- You can start any command with "TEVAN", e.g. "Hey TEVAN, show radiation".

The parser (`src/ui/voice.ts`) is a deterministic grammar, so the same words always give the same command. No LLM or API key is needed.

### Gaze

`src/ui/gaze.ts` runs MediaPipe Face Landmarker in the browser, tracking one face (`numFaces: 1`). It uses iris position inside each eye opening, plus head yaw and pitch, as features. Calibration starts after a 3-second countdown and shows 13 dots. Blink frames are dropped, each dot's samples are filtered against their median, and a ridge regression with quadratic terms maps features to screen position. Three unseen check dots then measure the real error and remove any constant offset, and TEVAN reports the accuracy honestly (Good / Fair / Low). A One Euro filter smooths the result. Without calibration, TEVAN falls back to head pointing. `src/ui/targets.ts` snaps the gaze point to the nearest `data-gaze` element. A target has to hold for 160 ms before it locks, and "this" refers to whatever was locked while you were speaking, up to 2.5 s earlier. No video leaves the device.

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

## Architecture

```
src/
  data/            DATA CONTRACT (swap point for NASA data, ?data=<name>)
  core/            framework-free engine: route graph + metrics, health model, forecast, sim
  core/terrain.ts  boulders, traversability grid, A* guide path, stumble risk
  core/guardian.ts active responses (storm, quake, consumables, falls, geofence), tags, describe, crew
  render/scene.ts  Three.js world, chevrons, drone + PIP camera, curved visor lens pass, zoom
  ui/hud.ts        visor HUD (dynamic island, halos, radar, dock, detail cards); bound by element IDs
  ui/map.ts        tactical map + heading-up radar
  ui/voice.ts      continuous speech recognition + command grammar
  ui/gaze.ts       MediaPipe face/iris tracking, calibration, smoothing
  ui/targets.ts    gaze → feature targeting
  ui/audio.ts      named sound slots (see AUDIO.md)
  data/roverFeed.ts  live Perseverance raw images (NASA JSON API)
tools/fetch_nasa_jezero.py  builds the real Jezero dataset from NASA/USGS sources
tools/convert_geotiff.py   any other NASA GeoTIFF → simulator grids
```

### Data sets

- Default: `public/data/nasa-jezero/` (real, see "What's new in v3").
- `/?data=mock`: the synthetic terrain.
- Another GeoTIFF: `python tools/convert_geotiff.py --out public/data/<name> --elevation dtm.tif ...`, then open `/?data=<name>`. Missing layers fall back to synthetic ones.

### Health model

The model is unchanged from v1, and every constant is auditable in `src/core/health.ts`: Pandolf metabolic cost at 0.38 g, O₂ from metabolic energy, sublimator water, battery draw, sky-view-shielded GCR dose, and a fatigue index with a reroute threshold of 70. All synthetic values are plausible placeholders. They are not mission data.
