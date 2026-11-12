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
| `ambient_wind.mp3` | loop | whole EVA in VR mode | Instrumental soundscape of thin Martian wind heard through a spacesuit helmet, low muffled whooshing, faint grit hitting a visor, very sparse, no music, seamless loop |
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
| `ui_click.mp3` | one-shot, <0.2 s | button presses | Very short soft UI click, high-tech button tap, 0.1 seconds |

Mixing is done in `src/main.ts` (search for `audio.setLevel`), and the slot list lives in `src/ui/audio.ts`.
