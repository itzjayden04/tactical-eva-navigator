# TEVAN User Manual

**TEVAN (Tactical EVA Navigator)** is a helmet navigator for an astronaut on a Marswalk in Jezero Crater. The whole screen is the inside of your helmet: you look at real Mars terrain through a curved visor, and TEVAN draws its displays on the glass. You control it with your **voice**, your **eyes** (through the webcam), and the **keyboard and mouse**.

Live version: **https://tactical-eva-navigator.netlify.app/**

## Contents

1. [What you need](#1-what-you-need)
2. [Starting an EVA](#2-starting-an-eva)
3. [Moving around](#3-moving-around)
4. [Reading the visor](#4-reading-the-visor)
5. [Using your eyes (gaze)](#5-using-your-eyes-gaze)
6. [Talking to TEVAN (voice)](#6-talking-to-tevan-voice)
7. [Voice command reference](#7-voice-command-reference)
8. [The Navigator map](#8-the-navigator-map)
9. [Planning a route](#9-planning-a-route)
10. [Health forecast and rerouting](#10-health-forecast-and-rerouting)
11. [The guardian: what TEVAN does on its own](#11-the-guardian-what-tevan-does-on-its-own)
12. [Emergency](#12-emergency)
13. [Look and ask: "what is this" and labels](#13-look-and-ask-what-is-this-and-labels)
14. [Drone scout](#14-drone-scout)
15. [Rover feed and Perseverance data](#15-rover-feed-and-perseverance-data)
16. [Tools](#16-tools)
17. [Ending the EVA: debrief and log export](#17-ending-the-eva-debrief-and-log-export)
18. [Data sources](#18-data-sources)
19. [Privacy](#19-privacy)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. What you need

| Item | Requirement |
|---|---|
| Browser | **Google Chrome or Microsoft Edge** on a laptop or desktop. Firefox has no speech recognition and Safari's is unreliable. On other browsers TEVAN still runs, but you type commands instead of speaking. |
| Webcam | Any built-in laptop webcam. Used only for gaze; optional. |
| Microphone | Built-in is fine; a headset is better. Optional. |
| Internet | Needed for voice (the browser's speech service), fonts and the live rover feed. The map, gaze and simulation work offline once loaded. |
| Address | The page must be opened over `https://` (the live site) or `http://localhost` (local development). Camera and mic are blocked on `file://`. |

The first load downloads about 13 MB for the eye-tracking model and about 6.5 MB of real Jezero terrain.

## 2. Starting an EVA

### The boot screen

When TEVAN loads you see the mission briefing: the EVA name, its objectives, starting consumables, conditions, a small map of the route, and three system checks (**Suit telemetry**, **Voice**, **Gaze**). A badge at the bottom says whether the map is **real NASA data** or synthetic terrain.

There are two buttons:

| Button | What it does |
|---|---|
| **Calibrate gaze & begin EVA** | Asks for camera and microphone, runs the gaze calibration, then the voice check, then starts the EVA. Recommended. |
| **Begin without gaze and mic** | Starts straight away with no camera and no microphone. The **mouse pointer stands in for your eyes**, and you press **Enter** to type commands. You can turn the mic on later by typing **"voice check"**. |

Every calibration screen has a **Skip** button.

### Gaze calibration (about 30 seconds)

1. Sit about an arm's length from the screen, face centred in the camera, lit from the front.
2. After a **3, 2, 1** countdown a dot appears. Follow it with your eyes, keeping your head still. There are 13 dots.
3. Three more check dots measure the real accuracy. TEVAN reports it honestly as **Good**, **Fair** or **Low**.

Say **"calibrate"** at any time during the EVA to redo it.

### Voice check (about 30 seconds)

1. **Stay quiet** for a second while TEVAN measures the room noise.
2. Say **"Hi TEVAN"** in your normal voice. TEVAN learns how the browser spells "TEVAN" for your voice so the wake word works for you.
3. TEVAN then asks you to read **five short commands**: "Open the map", "Check oxygen level", "Open emergency", "Label this as a hazard", "Show radiation dose". It compares what the browser heard with what you were asked to read and learns your accent (for example, that your "map" comes through as "mop").

Say **"voice check"** at any time to add more training, and **"forget my accent"** to wipe what was learned. Anyone can give commands: TEVAN adapts to accents but does not lock to one speaker.

### The camera and mic icons

At the top of the visor, the camera and microphone icons turn **green** while they work and stay **dim grey** when they don't. Hover over them to see why.

## 3. Moving around

| Input | Action |
|---|---|
| **W A S D** | Walk forward, left, back, right |
| **Shift** | Sprint (uses more oxygen, raises fatigue and stumble risk) |
| **Space** | Jump. Clears rocks under about 0.7 m; Mars hang time is about 1.3 s |
| **Drag the mouse**, or **arrow keys** | Look around |
| **Mouse wheel** | Optical zoom, 1× to 6×. Double-click resets |
| **Click a feature** | Same as looking at it and saying "launch this" |
| **Enter** | Open the typed command line |

The terrain is physical. Large boulders block you and you slide around them. Slopes steeper than about 34° can't be climbed. Loose rock, steep ground, sprinting, dust and fatigue can make you **stumble or fall**: the view jolts, drops to the ground, and gets back up.

Follow the blue **ground arrows**. They show a live path from your feet to the next waypoint, around boulders, rubble and slopes over 31°. **Pink** arrows lead to an off-route destination (a label or a teammate), and **amber** arrows mean an emergency route.

## 4. Reading the visor

```
             [ mic ] [ ---- Dynamic island ---- ] [ cam ]   [voice bubble]

  Halo vitals                                                        Radar
  O2  H2O  Power                                                     (heading-up
  Dose  Fatigue                                                       minimap)
  HR · speed · pace
  [status chips]

          [ Route ] [ Drone ] [ Sample ] [ Layers ] [ Tools ] [ SOS ]
```

| Element | What it shows |
|---|---|
| **Dynamic island** (top centre) | Compact: mission elapsed time, next waypoint with a direction arrow, local solar time. It **expands** for incidents, reroute advisories, junction choices, holds and feature cards, so only one thing asks for attention at a time. |
| **Voice bubble** (next to the island) | What TEVAN heard you say, and what it did. `≈` means TEVAN understood the meaning rather than the exact words. |
| **Halo vitals** (left) | Rings for oxygen, cooling water, suit power, radiation dose and fatigue, with heart rate, speed and pace underneath. |
| **Status chips** (under the vitals) | Everything currently "on": navigation target, stability assist, storm, blocked traverse, poor footing, help en route. |
| **Radar** (right) | Heading-up minimap with your route, any suggested alternate, hazards, unexplored areas (fog of war) and the active map layers. |
| **Feature dock** (bottom) | Route, Drone, Sample, Layers, Tools and the red SOS (Emergency). Each icon's ring shows that feature's progress: share of route walked, drone battery, samples sealed, layers on. |
| **World markers** | Waypoint, hazard and site labels drawn on the terrain through the same curved lens as the visor. |

## 5. Using your eyes (gaze)

TEVAN tracks **one face** with the webcam and works out which part of the visor you're looking at. Anything you can look at glows when your gaze settles on it for a moment.

**Gaze plus a voice command.** Look at a feature and say:
- **"launch this feature"** (or just "launch this", "open this") to open or start it
- **"check this feature's progress"** (or "status of this") to show its progress card

"This" means whatever you were looking at while you spoke, up to 2.5 s earlier, so you can glance back at the terrain as you talk.

**ID cards.** When your eyes land on a boulder, a site, your crewmate, the drone or a label, an **ID card** appears beside it in 3D. Look away, even turn right around, and the card **stays for 3.5 seconds** with a countdown ring. While the object is behind you, the card rides on the visor edge on that side, with an arrow and how far to turn ("Turn 146° left · 904 m"). Up to three cards show at once.

**Tips for good tracking**
- Light your face from the front. A bright window behind you makes tracking much worse.
- Keep only one person in front of the camera.
- Targets are deliberately large: a webcam can tell which feature you're looking at, but not pick out a tiny button.
- If the highlight drifts, say **"calibrate"**.

No camera? The **mouse pointer** acts as your gaze, so "launch this" works on whatever is under the pointer.

## 6. Talking to TEVAN (voice)

TEVAN is **always listening**; there's no button to press. Speak normally in short commands. You can start any command with "TEVAN" or "Hey TEVAN", but you don't have to.

**How TEVAN understands you**
1. Your learned accent words are applied first ("oxy gin" becomes "oxygen").
2. A fixed command grammar is tried. The same words always give the same command.
3. If that doesn't match, an in-browser meaning matcher works out the intent from synonyms and from words that *sound* or are *spelt* like command words. It scores the browser's top four guesses of what you said.
   - Confident: it runs the command and shows "≈ what TEVAN understood".
   - Unsure: it asks **"Did you mean …?"** Answer **"yes"** or **"no"**. When you say yes, TEVAN remembers that phrase so it runs straight away next time (never for a mayday).
4. Small talk is ignored.

So phrases like "so radiation", "how much oxy gen left", "send the drawn out", "find me a better way" and "am I okay" all work.

**TEVAN never acts on its own voice.** The mic pauses while TEVAN speaks and restarts 0.6 s afterwards, and anything that sounds like an echo of TEVAN's own reply is thrown away. Wait for it to finish talking before your next command.

**Typed commands.** Press **Enter** anywhere to open the command line, type any voice command, press Enter again to send. This works on every browser and with the mic off.

**Tips**
- A quiet room helps. Loud speakers can trigger false commands; headphones are best.
- Say **"stop listening"** to pause the mic and **"resume listening"** to turn it back on.
- Say **"what can I say"** for the command list.

## 7. Voice command reference

| Area | Say |
|---|---|
| Help | "what can I say", "help" |
| Gaze-targeted | "launch this feature", "check this feature's progress" |
| Map | "open map", "close", "close map" |
| Layers | "show / hide / toggle" + "radiation", "slope", "POI", "dust", "magnetic", "fog", "rover" |
| Route | "reroute", "accept", "dismiss", "commit route", "clear route" |
| Choices | "option one / two / three", "route two", "take route one" |
| Suit | "vitals", "check oxygen", "battery status", "how is my fatigue", "slow pace", "nominal pace" |
| Drone | "launch drone", "recall drone", "drone relay", "check drone progress" |
| Science | "mark sample", "take a photo" |
| Look and ask | "what is this", "label this", "label this as a hazard", "remove tag", "go to tag", "take me to my teammate" |
| Emergency | "open emergency", "call for help" / "mayday", "back to habitat", "nearest shelter", "go to cache", "resupply", "rest", "stability on / off", "resume mission", "cancel navigation" |
| Tools | "tools", "team status", "show supplies", "system status", "how is the weather", "show tags", "show log", "where am I", "rover feed" |
| Traceability | "repeat that", "undo" |
| Visor | "zoom in", "zoom out", "reset zoom", "jump", "mute", "unmute" |
| Calibration | "calibrate" (gaze), "voice check", "forget my accent" |
| Mic | "stop listening", "resume listening" |

Note the difference: **"open emergency"** only opens the Emergency panel. **"call for help"** or **"mayday"** actually sends a distress call with your position.

## 8. The Navigator map

Open it with **"open map"**, by clicking the Route icon, or by looking at it and saying "launch this". It works like a street-map app.

| Action | How |
|---|---|
| Zoom | Mouse wheel, trackpad pinch or touch pinch (zooms around the cursor), double-click, `+` / `−` keys, or the zoom buttons |
| Pan | Drag, or the arrow keys |
| Centre on me | The target button |
| Whole study area | The expand button |
| Search | Press `/` or click the search box. Find places, your labels, crew, traverses, `sol 120`, or coordinates such as `18.445, 77.44` |
| Category chips | Shelters, Supply caches, Science sites, Hazards, My labels, Crew: frames all of that kind |
| Place card | Click anything, or empty ground to drop a pin. Shows coordinates, elevation, slope, dose rate and distance, with **Navigate**, **Add waypoint**, **Label** (name and colour, also shown in the visor) and, at rover stops, the real Perseverance panorama |
| Layers | Toggle radiation, slope, points of interest, dust, magnetic, fog of war and rover route. Each repaints both the map and the radar |

Zoomed in, the map switches to the full-resolution HiRISE photo and shows more labels: junction names, traverse names and denser Perseverance sol stops, placed so they don't overlap.

Close the map with **Close** or by saying "close". Opening and closing the map never resets your position, route or vitals.

## 9. Planning a route

1. Open the map and switch to **Plan route** mode (top of the map), or use **Add waypoint** on any place card.
2. Click waypoints on the map. Four is a good start.
3. The planner shows, live:
   - total **distance**
   - **elevation gain**
   - **maximum slope**
   - **estimated time**
   - **peak fatigue** and **oxygen left at the end**
4. Watch the **vitals forecast chart** under the planner change as you move waypoints.
5. Say **"commit route"** (or click **Commit route**) to make it your active route, or **"clear route"** to start over.

The ground arrows in the visor update the moment a route is committed.

## 10. Health forecast and rerouting

TEVAN's health model links the ground you cross to your body. Steeper slopes and rough ground raise metabolic cost (Pandolf model at Mars gravity, 0.38 g), which drives oxygen use, cooling-water use, heart rate and fatigue. Open terrain with less sky shielding raises radiation dose. Every constant is in `src/core/health.ts`.

**Forecast.** The dashed lines on the Navigator chart, and the Route card ("check route progress"), predict your vitals to the end of the route. Change the route and the forecast changes.

**Automatic rerouting.** When the fatigue index crosses **70**, or the oxygen forecast drops below reserve, the dynamic island expands with:
- the **reason** (for example, "fatigue forecast 78 on the delta climb"),
- a **now vs alternate** comparison,
- the alternate drawn on the radar.

Say **"accept"** to take it or **"dismiss"** to keep your route. You can also ask for one at any time with **"reroute"**.

## 11. The guardian: what TEVAN does on its own

TEVAN watches you and the terrain and acts without being asked.

| Situation | What TEVAN does |
|---|---|
| Dust storm front | Warns 90 s ahead, turns on stability assist, slows your pace or holds you in place, and releases when the storm passes |
| Marsquake | Shakes the view, rockfall **closes a traverse**, replans your way home, and offers a drone scout of the new route |
| Oxygen below 45% or battery below 30% | Compares options with numbers: nearest **supply cache**, back to habitat, or slow pace / shed loads |
| Half oxygen, oxygen below reserve, low cooling water | Spoken reminder with forecasts at the habitat and the nearest cache |
| Fall | "Are you OK?" card with a 15 s timer. No answer sends a **mayday** with your position. Two falls turn stability assist on |
| Entering a hazard zone | Spoken warning and stability assist, off again when you leave |
| High heart rate or core temperature | Suggests "rest" or "slow pace" |
| Path blocked | Tells you to jump a low rock or follow the arrows around |
| Signal lost during a call for help | Launches the drone as a radio relay |

**Stability assist** braces the suit's joints, cuts stumble risk by about 70% and caps your speed. Turn it on or off with "stability on" / "stability off".

## 12. Emergency

Open the Emergency panel with the red **SOS** icon, by looking at it and saying "launch this", or by saying **"open emergency"**. Quick actions:

| Action | Voice |
|---|---|
| Call for help (mayday with position) | "call for help", "mayday" |
| Back to habitat | "back to habitat" |
| Nearest shelter | "nearest shelter" |
| Resupply at the nearest cache | "go to cache", "resupply" |
| Rest 5 minutes | "rest" |
| Stability assist | "stability on" |

Say **"resume mission"** or **"cancel navigation"** to go back to the planned route.

## 13. Look and ask: "what is this" and labels

**"What is this".** Look at a boulder, the ground, a cache, the habitat, your crewmate EV-2 or the rover and ask **"what is this"**. TEVAN outlines it and answers out loud: size and whether you can jump it, slope and footing, dose rate, which traverse it's on, what a cache holds. On ground Perseverance drove over, it tells you the sol the rover passed and shows the rover's own Navcam pictures from that sol. All of this is computed from the map data; no AI service is used.

**Labels (tags).** Look at anything and say **"label this"**. TEVAN outlines it, asks what it is if it can't tell, and pins a coloured tag. You can name the kind directly: "label this as a hazard".

| Kind | Colour |
|---|---|
| Teammate | Blue |
| Habitat | Green |
| Destination | Pink |
| Hazard | Red |
| Sample | Cyan |
| Resource | Amber |
| Note | Lilac |

A tag on your crewmate follows them. **"Go to tag"** navigates to the latest tag, **"show tags"** lists them, **"remove tag"** or **"undo"** takes one back. Labels made on the map show in the visor too.

## 14. Drone scout

Say **"launch drone"** (or look at the Drone icon and say "launch this"). The drone flies ahead along your route:
- it **clears the fog of war** on the radar and map, revealing unexplored terrain,
- it finds **hidden hazards** before you reach them,
- it streams a **live picture-in-picture feed** to the visor.

The Drone icon's ring shows its battery. **"Check drone progress"** shows its status, **"recall drone"** brings it back, and **"drone relay"** parks it as a radio relay. TEVAN launches it as a relay automatically if you lose signal during a call for help.

## 15. Rover feed and Perseverance data

- Say **"rover feed"** (or "latest rover images") for Perseverance's newest raw images, fetched live from NASA.
- The **rover route** map layer ("show rover layer") draws Perseverance's real traverse from sol 13 to sol 760. The wheel tracks also appear on the ground in the visor.
- At rover stops on the map, the place card shows the real panorama from that sol.
- **"Where am I"** answers in latitude and longitude.

## 16. Tools

Open with the **Tools** icon or **"tools"**.

| Tool | Shows | Voice |
|---|---|---|
| Team | EV-2 and rover positions, comms link | "team status" |
| Supplies | Supply caches and contents | "show supplies" |
| Systems | Mic, camera, comms, faults | "system status" |
| Weather | Dust, radiation, seismic activity | "how is the weather" |
| Tags | Your labels | "show tags" |
| Log | Mission log with the full conversation (you, TEVAN, EV-2, habitat) | "show log" |
| Photo | Captures the current view into the mission log; photos are included when you export the log | "take a photo" |
| What is this | Identifies what you're looking at | "what is this" |
| Rover feed | Latest Perseverance images | "rover feed" |

**"Repeat that"** replays TEVAN's last spoken line, and **"undo"** reverses the last action.

## 17. Ending the EVA: debrief and log export

When the EVA ends, the debrief screen summarises the mission. **Export log** saves the full mission log as JSON (events, conversation, tags, photos and comms). **New EVA** starts again.

The scenario is **seeded**: the same choices always give the same boulders, events and outcomes, so a run can be repeated exactly for a demo.

Demo-operator keys (not part of the astronaut experience): **`[`** and **`]`** slow down and speed up time.

## 18. Data sources

| What you see | Source |
|---|---|
| Terrain under your boots, slopes, the delta scarp, the Kodiak butte | HiRISE 1 m/px digital terrain model, Mars 2020 Terrain Relative Navigation maps (NASA/JPL-Caltech, University of Arizona, USGS Astrogeology) |
| Ground texture and the map base | HiRISE 25 cm/px orthomosaic from the same set |
| Blue rover route and wheel tracks | Perseverance traverse, sols 13 to 760, from NASA/JPL's MMGIS service |
| Rover feed and photos in "what is this" | NASA Mars 2020 raw-image feed |
| Rock roughness, radiation shielding, dust | Computed from the real terrain model and photo |
| Health model, incidents, crew, caches | Simulation with plausible, documented placeholder values. These are not mission data. |

The study area is a 4 × 4 km window around the **Octavia E. Butler landing site** (18.4446° N, 77.4509° E). The habitat stands where Perseverance landed on 18 February 2021.

Add `?data=mock` to the address to use synthetic terrain instead. TEVAN also falls back to it automatically if the NASA files can't load.

## 19. Privacy

- **Gaze** runs entirely in your browser. No video leaves your computer.
- **Voice** uses Chrome's or Edge's built-in speech recognition, which sends audio to Google or Microsoft to turn it into text.
- Your **accent profile** stays in this browser (localStorage). "Forget my accent" deletes it.
- No account, no server, no AI API key.

## 20. Troubleshooting

| Problem | Fix |
|---|---|
| Mic or camera icon stays grey | Hover it for the reason. If permission was denied, click the camera/lock icon in the address bar, allow Camera and Microphone, and reload. |
| "Voice needs Chrome or Edge" | Switch browser, or press **Enter** to type commands. |
| "Speech service unreachable" | Voice needs internet. Brave, Opera and plain Chromium builds usually fail here; use Chrome or Edge. |
| "No microphone found" | Check your system sound settings, and close other apps using the mic. |
| TEVAN mishears you | Say **"voice check"** to train more words. Answer "yes" to "Did you mean …?" so it learns the phrase. Use a headset in noisy rooms. |
| False commands from the speakers | Turn the volume down or use headphones. |
| Gaze highlight drifts | Light your face from the front, keep one face in view, and say **"calibrate"**. |
| Gaze is slow | Close other tabs. Tracking is fastest with a GPU. |
| Blank page from a downloaded copy | Don't open `index.html` from disk. Use the live site or run it locally (see the README). |
| Badge says "Synthetic terrain" | The NASA files didn't load. Check the connection and reload, and make sure the address has no `?data=mock`. |
