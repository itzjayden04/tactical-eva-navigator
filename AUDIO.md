# Audio slots and Suno prompts

The simulator plays sound through named slots. Each slot already has a placeholder synthesized in code, so nothing is silent. To replace a slot, generate the sound in Suno, export it as MP3, and save it as `public/audio/<slot>.mp3`. It is picked up on the next page load, and no code changes are needed.

Tips for Suno:
- Use **Instrumental** mode for every slot. You don't want vocals in any of them.
- For loops, ask for a "seamless loop" and trim the start and end in an audio editor (Audacity works) so the file loops without a click. Aim for 30 to 90 seconds.
- Suno is strongest at music and ambient beds. The short one-shot alerts (under 2 s) may come out cleaner from a sound-effects generator, or you can keep the built-in synth versions.
- Keep levels moderate. The engine mixes the volumes itself (for example, breathing gets louder with metabolic rate).

| Slot (file name) | Type | When it plays | Suno prompt |
|---|---|---|---|
| `music_bed.mp3` | loop, very quiet | whole EVA | Instrumental ambient score for a realistic Mars surface mission, slow evolving analog synth pads, low drones, sparse soft piano notes, sense of isolation and focus, no drums, no melody hooks, 60 BPM, seamless loop |
| `ambient_wind.mp3` | loop | whole EVA | Instrumental soundscape of thin Martian wind heard through a spacesuit helmet, low muffled whooshing, faint grit hitting a visor, very sparse, no music, seamless loop |
| `suit_breathing.mp3` | loop, rate follows heart rate | whole EVA | Instrumental sound design: calm human breathing inside a pressurized spacesuit helmet, close-mic inhale and exhale every 4 seconds, soft air hiss from the suit vent, no music, seamless loop |
| `plss_hum.mp3` | loop | whole EVA | Instrumental sound design: steady low electrical hum and gentle fan whir of a spacesuit life-support backpack, quiet pump pulsing, mechanical, no music, seamless loop |
| `dust_storm.mp3` | loop, fades in with dust | dust devil incident | Instrumental sound design: approaching Martian dust devil heard from inside a helmet, swirling roaring wind, sand hissing against the visor, rising intensity, no music, seamless loop |
| `spe_geiger.mp3` | loop, fades in with dose rate | solar particle event | Instrumental sound design: dosimeter crackle, irregular Geiger counter clicks speeding up, tense low synth drone underneath, no melody, seamless loop |
| `drone_rotor.mp3` | loop | drone airborne | Instrumental sound design: small coaxial helicopter drone rotors in thin air, high-pitched buzzing whir heard from a distance, no music, seamless loop |
| `alert_caution.mp3` | one-shot, ~1 s | caution incidents, hazard sighted | Short spacecraft cockpit caution tone, two soft rising beeps, clean sine, NASA flight software style, 1 second |
| `alert_warning.mp3` | one-shot, ~1.5 s | warning incidents (SPE, foot slip, battery) | Short spacecraft master warning tone, three urgent triangle-wave beeps, clean, 1.5 seconds |
| `alert_emergency.mp3` | one-shot, ~2 s | emergency incidents (suit leak) | Spacecraft emergency klaxon, alternating high-low two-tone alarm, urgent but not distorted, 2 seconds |
| `reroute_chime.mp3` | one-shot, ~1 s | reroute advisory appears | Soft navigation chime, two ascending glassy tones, calm and informative, 1 second |
| `sample_collect.mp3` | one-shot, ~1 s | sample sealed | Positive confirmation chime, three ascending soft bell tones, scientific instrument style, 1 second |
| `ui_click.mp3` | one-shot, <0.2 s | clicks on a feature | Very short soft UI click, high-tech button tap, 0.1 seconds |
| `voice_ack.mp3` | one-shot, ~0.2 s | a voice command was understood | Two quick soft ascending sine blips, friendly confirmation, Apple-like, 0.2 seconds |
| `gaze_lock.mp3` | one-shot, <0.1 s | eyes lock onto a feature | Tiny soft high tick, almost subliminal, glassy, 0.05 seconds |
| `island_open.mp3` | one-shot, ~0.3 s | dynamic island expands with a decision or card | Soft airy whoosh with a gentle low tone, interface panel opening, 0.3 seconds |
| `quake_rumble.mp3` | loop, fades in during a marsquake | marsquake | Instrumental sound design: deep low-frequency ground rumble heard through a spacesuit, rocks grinding and settling, no music, seamless loop |
| `body_thud.mp3` | one-shot, ~0.5 s | the astronaut falls | Muffled heavy body thud on dusty ground heard from inside a helmet, suit fabric rustle, 0.5 seconds |
| `jump.mp3` | one-shot, ~0.2 s | Space to jump | Soft suit push-off, short muffled boot scrape and breath, 0.2 seconds |
| `tag_set.mp3` | one-shot, ~0.3 s | a tag is placed | Two quick bright glassy ticks, map pin dropped, 0.3 seconds |
| `camera_shutter.mp3` | one-shot, ~0.2 s | photo taken | Crisp digital camera shutter click, 0.2 seconds |
| `mayday.mp3` | one-shot, ~1 s | call for help sent | Three urgent radio beacon pips, distress transmit tone, 1 second |

Mixing is done in `src/main.ts` (search for `audio.setLevel`), and the slot list lives in `src/ui/audio.ts`.
