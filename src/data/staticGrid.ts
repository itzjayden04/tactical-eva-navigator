/**
 * STATIC GRID PROVIDER (for real data)
 * ------------------------------------------------------------------
 * Loads pre-converted rasters from `public/data/<dataset>/manifest.json`.
 * Use `tools/convert_geotiff.py` to turn NASA GeoTIFFs (MOLA/HiRISE DTM,
 * dose maps, etc.) into this format on hackathon day.
 *
 * manifest.json
 * {
 *   "label": "NASA JEZERO (Space Apps 2026)",
 *   "grids": {
 *     "elevation": { "file": "elevation.f32", "width": 257, "height": 257,
 *                    "originE": -2000, "originN": 2000, "cell": 15.625, "units": "m" },
 *     "radiation": { ... },   // optional, µSv/h
 *     "dust":      { ... },   // optional
 *     "magnetic":  { ... },   // optional, nT
 *     "rocks":     { ... }    // optional, 0..1
 *   },
 *   "pois": "pois.json",       // optional, Poi[]
 *   "mission": "mission.json", // optional, MissionDef
 *   "conditions": { "surfaceTempC": -63, "dustTau": 0.6, "gcrDoseRateuSvH": 28 }
 * }
 * Each .f32 file is little-endian Float32, row-major, row 0 = north.
 * Anything missing falls back to the synthetic provider's layer.
 */
import type { DataBundle, DataProvider, Grid } from './types';
import { mockJezeroProvider } from './mockJezero';

interface GridMeta {
  file: string;
  width: number;
  height: number;
  originE: number;
  originN: number;
  cell: number;
  units: string;
}

async function loadGrid(base: string, m: GridMeta): Promise<Grid> {
  const buf = await (await fetch(base + m.file)).arrayBuffer();
  const data = new Float32Array(buf);
  if (data.length !== m.width * m.height) throw new Error(`${m.file}: expected ${m.width * m.height} values, got ${data.length}`);
  return { ...m, data };
}

export function staticGridProvider(dataset: string): DataProvider {
  const base = `./data/${dataset}/`;
  return {
    id: dataset,
    label: dataset.toUpperCase(),
    async load(): Promise<DataBundle> {
      const manifest = await (await fetch(base + 'manifest.json')).json();
      const fallback = await mockJezeroProvider.load();
      const g = manifest.grids ?? {};
      const get = async (k: string, fb: Grid | undefined) => (g[k] ? loadGrid(base, g[k]) : fb);
      return {
        label: manifest.label ?? dataset,
        elevation: (await get('elevation', fallback.elevation))!,
        radiation: (await get('radiation', fallback.radiation))!,
        dust: (await get('dust', fallback.dust))!,
        magnetic: (await get('magnetic', fallback.magnetic))!,
        rocks: await get('rocks', fallback.rocks),
        pois: manifest.pois ? await (await fetch(base + manifest.pois)).json() : fallback.pois,
        mission: manifest.mission ? await (await fetch(base + manifest.mission)).json() : fallback.mission,
        conditions: manifest.conditions ?? fallback.conditions,
      };
    },
  };
}
