# Tactical EVA Navigator: Mars EVA simulator

A first-person mission simulation for NASA Space Apps 2026 ("Interplanetary Survival Guide: Martian Map"). You play an astronaut on a Marswalk in Jezero Crater. You walk freely with W A S D along an authored, branching traverse network, run into real Mars hazards, and use the Tactical EVA Navigator to manage O2, water, battery and radiation dose until you're back at the habitat.

**Thesis:** on Mars, an astronaut's health risk is a function of geography. The map causes the risk, and the health state reshapes the map.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (open with any static server)
npm test           # core engine tests incl. full autoplay of the mission
```

Chrome or Edge is recommended, since voice commands use the Web Speech API. Typed commands work in every browser.

## Demo script (maps to the 8 judging criteria)

| # | Criterion | How to show it |
|---|---|---|
| 1 | Layered map, toggleable overlays | Click RADIATION / SLOPE / POI / DUST / MAG FIELD chips on the map (or say "toggle slope"). Each layer repaints the map independently. |
| 2 | Route drawing with metrics | Press **M**, then click 4 nodes on the big map. The sidebar shows distance, elevation gain, max slope, time, peak fatigue, O2 at end and dose. Press COMMIT ROUTE to set it as guidance, then walk it. |
| 3 | Health model coupled to route | The dashed lines in the TRAVERSE chart are the vitals forecast along the planned route. Pick a different branch at a junction or plan a route, and the forecast changes. |
| 4 | Hazard-triggered rerouting | When fatigue crosses 70 (or the O2 forecast drops below the 20% reserve), an amber REROUTE ADVISORY appears with the reason, a current-vs-alternate table, and the alternate drawn dashed on the map. Press **R** to accept. |
| 5 | AR HUD | The whole view is the helmet AR HUD over the 3D Jezero terrain: ground chevrons, waypoint and hazard markers, compass tape and the dose vignette. Press **Tab** for the minimal visor (vitals strip + reroute pill only). |
| 6 | Mode continuity | AR only (no VR). Toggling **Tab** between full navigator and minimal visor never resets position, route or vitals, because both read one simulation state. |
| 7 | Voice commands | Hold **Space** and say "toggle radiation", "reroute", "mark sample" or "vitals" (it answers aloud). You can also press **Enter** and type the same commands. |
| 8 | Drone scout | Press **Q**. The drone flies the next ~1 km of the plan, clears fog of war, discovers hidden hazards, and streams a live PIP feed (also shown in AR). |

A good 5-minute run: walk out with **W** (Shift to sprint, drag or arrow keys to look, **H** shows every key). At each junction press **1/2/3** to set guidance, then follow the chevrons. Egress, take the **Wadi Shortcut** (dust devil), collect the Delta Front sample (**F**). A solar particle event warning follows, so divert to the Rock Overhang shelter and watch the dose rate drop. Then take the **Rim Ascent** (suit micro-leak, so use the patch kit) or the Fan Lobe Route (battery fault). Collect the second sample and return via the Western Return (loss of signal, so launch the drone relay). The debrief shows the full emergency and decision log. Use **]** to speed up time.

## Architecture

```
src/
  data/            DATA CONTRACT (swap point for NASA data)
    types.ts       Grid, POI, track graph, incidents, mission, DataProvider
    mockJezero.ts  synthetic Jezero: DEM, sky-view-shielded GCR dose, dust, crustal field, 7 incidents
    staticGrid.ts  loader for real rasters (public/data/<name>/manifest.json)
    index.ts       ?data=<name> selects the provider
  core/            framework-free engine (unit-tested in Node)
    route.ts       track graph, spline geometry, metrics, path search
    health.ts      metabolic / O2 / water / battery / dose / fatigue model
    forecast.ts    runs the health model along any candidate route
    sim.ts         single source of truth: movement, incidents, advisories, drone, log
  render/scene.ts  Three.js first-person world, chevrons, drone + PIP camera
  ui/              HUD (bound by element IDs), map, chart, voice, audio
tools/convert_geotiff.py   NASA GeoTIFF -> simulator grids
```

### Swapping in NASA data (14 Nov)

1. Convert the rasters: `python tools/convert_geotiff.py --out public/data/nasa-jezero --elevation dtm.tif ...` (see the script header).
2. Open `http://localhost:5173/?data=nasa-jezero`. Missing layers fall back to the synthetic ones.
3. If the real terrain changes where the tracks should run, export a `mission.json` (same shape as `MISSION` in `mockJezero.ts`) next to the manifest.

### Stitch UI

`index.html` uses the element IDs from the Stitch prompt pack. A Stitch-exported layout can replace it as long as the IDs stay the same; `src/ui/hud.ts` is the only file that touches the DOM.

### Health model (auditable)

- **Metabolic rate:** Pandolf et al. (1977) load-carriage equation with a Santee-style downhill term, gravity-scaled to 0.38 g. Astronaut 80 kg, suit/PLSS 60 kg. Terrain factor η: bedrock 1.0, regolith 1.2, boulders 1.5, scree 1.6, soft sand 2.1.
- **Walking speed:** Tobler-style slope factor × terrain factor × visibility, capped by injuries.
- **O2:** metabolic energy ÷ 20.1 kJ/L × 1.429 g/L, plus leaks.
- **Water:** heat rejected by the sublimator ÷ 2.83 kJ/g. When cooling is degraded, excess heat raises core temperature.
- **Battery:** 40 W base + heaters below −40 °C + dust load + faults.
- **Dose:** grid dose rate (GCR ≈ 28 µSv/h open sky, reduced by computed sky-view factor) × space-weather multiplier × shelter shielding × time.
- **Fatigue index:** accumulates from work above 300 W, time on EVA and heat stress; recovers at rest. The reroute threshold is 70.
- **Failures:** O2 = 0, core ≥ 39.8 °C, battery = 0, fatigue = 100, or dose ≥ 250 mSv. Training mode disables them.

All synthetic values are placeholders that look plausible. They are not mission data.

## Audio

See `AUDIO.md` for the sound slots and a Suno prompt for each. Drop MP3s into `public/audio/`.
