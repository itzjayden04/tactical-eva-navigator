# TEVAN changelog

Feature history by version. For how to use everything, see the [User Manual](USER_MANUAL.md).

## v4 (15 Nov 2026): mixed-reality labels, intent voice, street-map Navigator

**Look-to-identify ID cards (mixed reality).** The moment your eyes land on a boulder, a site, your crewmate, the drone or a tag, an ID card appears beside it, anchored to the object in 3D. Look away, or turn all the way around, and the card stays for **3.5 s** with a countdown ring. While the object is out of view, the card rides on the visor edge on the side the object is, with an arrow and how far to turn ("Turn 146° left · 904 m"). Up to three cards at a time. (`src/ui/holo.ts`)

**Voice that understands meaning, not exact phrases.** The strict grammar still runs first. If it does not match, an in-browser intent model takes over (no API key, no network): a synonym lexicon maps words to concepts, misheard words are rescued by sound (Metaphone-style codes) and spelling (Jaro-Winkler), and an IDF-weighted similarity picks the intent and fills its slots (which layer, which consumable, on/off). Chrome's top 4 recognition guesses are all scored, which helps with accents. Confident guesses run and show "≈ what TEVAN understood"; unsure ones ask "Did you mean …?" and wait for yes or no. Small talk is ignored. Examples that now work: "so radiation", "sure the radiation lair", "how much oxy gen left", "send the drawn out", "we route", "find me a better way", "am I okay", "take pitcher". (`src/ui/intent.ts`)

**TEVAN never acts on its own voice.** The speech recogniser is stopped while TEVAN talks (anything it had buffered is dropped) and restarts 0.6 s after the speech ends. Results that arrive during speech or a sound cue are ignored, and a transcript finalised right after TEVAN spoke that is mostly TEVAN's own words is discarded as an echo. (`src/ui/voice.ts`)

**TEVAN learns your accent, and takes commands from anyone.** There is no speaker or pitch check: any crew member can give commands. Instead, after "Hi TEVAN" the voice check asks you to read five short commands. Each heard sentence is aligned word by word with the one you were asked to read, and every word the recogniser spells differently for your accent is learned ("mop" = map, "oxy gin" = oxygen, "emergence" = emergency). From then on, spoken commands are read with your learned spellings first, then the grammar and the meaning-based matcher handle the rest. TEVAN also keeps learning while you work: when it asks "Did you mean …?" and you say yes, that exact phrase runs straight away next time (never for a mayday). The profile stays in this browser (localStorage). Say "voice check" to add more, or "forget my accent" to reset. (`src/ui/accent.ts`)

**Navigator map with street-map interaction.** Scroll, trackpad-pinch or touch-pinch to zoom around the cursor, drag to pan, double-click to zoom, `+`/`−` and arrow keys, buttons for zoom, "centre on me" and "whole area". Zoomed in, the map switches to the full 1 m/px HiRISE orthophoto, and more labels appear (junction names, traverse names, denser Perseverance sol stops) with collision-free placement. Search box (`/`) finds places, your labels, crew, traverses, `sol 120`, or coordinates like `18.445, 77.44`; category chips frame all shelters, caches, science sites, hazards, labels or crew. Click anything (or empty ground to drop a pin) for a place card with coordinates, elevation, slope, dose rate and distance, plus **Navigate**, **Add waypoint**, **Label** (name + colour; shows in the visor too) and, at rover stops, the real Perseverance panorama. "Plan route" mode keeps click-to-add-waypoint. (`src/ui/mapnav.ts`, `src/ui/map.ts`)

## v3 (15 Nov 2026): real NASA data

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

## v2 (14 Nov 2026): active guardian

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

## v1 (12 Nov 2026): helmet navigator

Curved helmet visor, dynamic-island HUD, halo vitals, radar, feature dock, always-on voice commands and webcam gaze, route planner with metrics, health model and forecast, hazard-triggered rerouting and drone scout.
