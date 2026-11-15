/**
 * STATIC GRID PROVIDER (real NASA data)
 * ------------------------------------------------------------------
 * Loads pre-converted rasters from `public/data/<dataset>/manifest.json`.
 * `tools/fetch_nasa_jezero.py` builds the default `nasa-jezero` dataset
 * straight from NASA/USGS sources (HiRISE DTM + orthophoto, Perseverance
 * traverse). `tools/convert_geotiff.py` converts any other GeoTIFF.
 *
 * manifest.json
 * {
 *   "label": "NASA JEZERO · HiRISE",
 *   "grids": {
 *     "elevation": { "file": "elevation.f32", "width": 513, "height": 513,
 *                    "originE": -2000, "originN": 2000, "cell": 7.8125, "units": "m" },
 *     "radiation" | "dust" | "magnetic" | "rocks": { ... }      // optional
 *   },
 *   "imagery":  { "file": "ortho.jpg", "map": "ortho_map.jpg", "originE", "originN", "sizeE", "sizeN" },
 *   "traverse": "traverse.json",   // optional, Perseverance route
 *   "layout":   "layout.json",     // optional, EVA nodes/tracks/POIs on the real terrain
 *   "pois": "pois.json", "mission": "mission.json",   // optional full replacements
 *   "geo": { "lat0", "lon0", "offsetE", "offsetN", "radius" },
 *   "conditions": { ... }, "credits": [ ... ]
 * }
 * Each .f32 file is little-endian Float32, row-major, row 0 = north.
 * Anything missing falls back to the synthetic provider's layer.
 */
import type { DataBundle, DataProvider, Grid, MissionDef, Poi, TrackEdge, TrackNode } from './types';
import { MISSION, mockJezeroProvider } from './mockJezero';

interface GridMeta {
  file: string;
  width: number;
  height: number;
  originE: number;
  originN: number;
  cell: number;
  units: string;
}

interface Layout {
  nodes: TrackNode[];
  edges: TrackEdge[];
  pois: Poi[];
}

async function fetchOk(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

async function loadGrid(base: string, m: GridMeta): Promise<Grid> {
  const buf = await (await fetchOk(base + m.file)).arrayBuffer();
  const data = new Float32Array(buf);
  if (data.length !== m.width * m.height) throw new Error(`${m.file}: expected ${m.width * m.height} values, got ${data.length}`);
  return { ...m, data };
}

/** Text that described the synthetic terrain, rewritten for the real Jezero layout. */
const INCIDENT_TEXT: Record<string, Partial<{ title: string; body: string }>> = {
  'dust-devil': {
    title: 'DUST DEVIL CROSSING THE RIPPLES',
    body: 'A convective vortex is tracking across the ripple field toward you. Visibility will drop below 30 m and fine dust will load the visor and suit joints. Soft sand already raises your walking cost.',
  },
  'foot-slip': { title: 'FOOT SLIP ON SÉÍTAH RIDGES', body: 'Your right boot slid off a tilted bedrock ridge. Ankle strain reported, no suit breach. Walking speed and efficiency are reduced.' },
  spe: {
    body: 'Mission Control: proton flux rising after an X-class flare. Protons arrive in ~15 min; surface dose rate then rises ×300 (≈8 mSv/h) for ~30 min. Terrain shielding matters: the crater wall shelter blocks part of the sky.',
  },
  leak: { body: 'Abrasive scree at the delta scarp toe has opened a pinhole near the left glove bearing. The PLSS is compensating from primary O2 at ~120 g/h.' },
  battery: { body: 'Cold-soak along the shaded delta front tripped a battery cell. Usable capacity dropped by 35%. Heaters are drawing more.' },
  comms: { title: 'LOSS OF SIGNAL BELOW THE DELTA', body: 'The delta scarp blocks line of sight to the habitat. Mission Control alerts and space-weather updates are unavailable until you regain signal.' },
};

function missionFromLayout(layout: Layout): MissionDef {
  const m: MissionDef = structuredClone(MISSION);
  m.title = 'EVA-03 · JEZERO CRATER';
  m.subtitle = 'Séítah to the Delta Front · real HiRISE terrain';
  m.nodes = layout.nodes;
  // keep the edge ids (incidents trigger on them); geometry and names come from the real layout
  const byId = new Map(layout.edges.map((e) => [e.id, e]));
  m.edges = m.edges.map((e) => ({ ...e, ...(byId.get(e.id) ?? {}) }));
  for (const e of layout.edges) if (!m.edges.some((x) => x.id === e.id)) m.edges.push(e);
  const name = (id: string) => layout.nodes.find((n) => n.id === id)?.name ?? id;
  m.objectives = m.objectives.map((o) => ({ ...o, label: o.kind === 'return' ? o.label : `Collect sample at ${name(o.nodeId)}` }));
  m.incidents = m.incidents.map((inc) => ({ ...inc, ...(INCIDENT_TEXT[inc.id] ?? {}) }));
  for (const inc of m.incidents)
    for (const o of inc.options) {
      o.label = o.label.replace('Rock Overhang shelter', 'the crater wall shelter').replace('Delta Front Traverse', 'Séítah Ridge Traverse');
    }
  return m;
}

export function staticGridProvider(dataset: string): DataProvider {
  const base = `${import.meta.env.BASE_URL}data/${dataset}/`;
  return {
    id: dataset,
    label: dataset.toUpperCase(),
    async load(): Promise<DataBundle> {
      const manifest = await (await fetchOk(base + 'manifest.json')).json();
      const fallback = await mockJezeroProvider.load();
      const g = manifest.grids ?? {};
      const get = async (k: string, fb: Grid | undefined) => (g[k] ? loadGrid(base, g[k]) : fb);
      const json = async (f?: string) => (f ? (await fetchOk(base + f)).json() : undefined);
      const layout: Layout | undefined = await json(manifest.layout);
      const mission: MissionDef | undefined = await json(manifest.mission);
      const pois: Poi[] | undefined = await json(manifest.pois);
      const im = manifest.imagery;
      return {
        label: manifest.label ?? dataset,
        source: 'nasa',
        elevation: (await get('elevation', fallback.elevation))!,
        radiation: (await get('radiation', fallback.radiation))!,
        dust: (await get('dust', fallback.dust))!,
        magnetic: (await get('magnetic', fallback.magnetic))!,
        rocks: await get('rocks', fallback.rocks),
        pois: pois ?? layout?.pois ?? fallback.pois,
        mission: mission ?? (layout ? missionFromLayout(layout) : fallback.mission),
        conditions: manifest.conditions ?? fallback.conditions,
        imagery: im ? { url: base + im.file, mapUrl: base + (im.map ?? im.file), originE: im.originE, originN: im.originN, sizeE: im.sizeE, sizeN: im.sizeN } : undefined,
        traverse: await json(manifest.traverse),
        geo: manifest.geo,
        credits: manifest.credits,
      };
    },
  };
}
