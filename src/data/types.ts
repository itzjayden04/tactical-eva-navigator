/**
 * DATA CONTRACT
 * ------------------------------------------------------------------
 * Everything the simulation knows about Mars comes through these
 * interfaces. The engine, 3D scene and HUD never import a concrete
 * dataset. To use NASA's challenge data, implement `DataProvider`
 * (or convert the data into the static-grid format read by
 * `StaticGridProvider`) and register it in `src/data/index.ts`.
 *
 * Coordinate frame: local tangent plane in metres.
 *   e = east, n = north, origin = centre of the study area.
 * Elevation is metres relative to the Mars areoid (MOLA convention).
 */

/** A regular raster covering the study area. Row 0 is the NORTH edge. */
export interface Grid {
  width: number; // columns
  height: number; // rows
  /** east coordinate of column 0 centre (m) */
  originE: number;
  /** north coordinate of row 0 centre (m) */
  originN: number;
  /** cell size (m) */
  cell: number;
  data: Float32Array; // row-major, length width*height
  units: string;
}

export type PoiKind =
  | 'habitat'
  | 'sample'
  | 'shelter'
  | 'hazard'
  | 'comms'
  | 'landmark';

export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  e: number;
  n: number;
  /** radiation shielding factor applied when the astronaut is within `radius` (0..1, 1 = none) */
  shielding?: number;
  radius?: number;
  note?: string;
}

export type SurfaceType = 'regolith' | 'bedrock' | 'boulders' | 'soft_sand' | 'slope_scree';

export interface TrackNode {
  id: string;
  name: string;
  e: number;
  n: number;
  poiId?: string;
}

export interface TrackEdge {
  id: string;
  name: string;
  a: string; // node id
  b: string; // node id
  /** intermediate control points (e,n), from a to b, excluding endpoints */
  via: [number, number][];
  surface: SurfaceType;
  description?: string;
}

export type IncidentTrigger =
  | { type: 'edge'; edgeId: string; at: number } // fraction 0..1 of the edge
  | { type: 'met'; seconds: number } // mission elapsed time
  | { type: 'node_depart'; nodeId: string };

export interface ModifierSpec {
  leakGph?: number; // O2 leak, grams/hour
  metMult?: number; // metabolic multiplier
  speedCap?: number; // m/s
  coolingMult?: number; // sublimator efficiency multiplier
  battExtraW?: number; // extra electrical draw
  battCapacityMult?: number; // permanent capacity loss
  doseMult?: number; // radiation multiplier (space weather)
  dust?: number; // added dust optical depth
  commsLoss?: boolean;
}

export interface IncidentEffect {
  modifier?: ModifierSpec & { id: string; durationS?: number; delayS?: number; label: string };
  removeModifier?: string; // modifier id to remove
  waitS?: number; // astronaut stops for this long (sim seconds)
  consume?: { o2g?: number; waterg?: number; battWh?: number };
  reroute?: 'shelter' | 'habitat' | 'avoid_steep' | 'alternate';
  setPace?: 'slow' | 'nominal' | 'fast';
  note?: string;
}

export interface IncidentOption {
  label: string;
  consequence: string;
  tags: string[];
  effects: IncidentEffect[];
  recommended?: boolean;
}

export type Severity = 'caution' | 'warning' | 'emergency';

export interface IncidentDef {
  id: string;
  title: string;
  category: string;
  severity: Severity;
  trigger: IncidentTrigger;
  body: string;
  onTrigger: IncidentEffect[];
  options: IncidentOption[];
  defaultOption: number;
  timeoutS: number; // real seconds to decide
}

export interface Objective {
  id: string;
  label: string;
  nodeId: string;
  kind: 'sample' | 'return';
}

export interface MissionDef {
  id: string;
  title: string;
  subtitle: string;
  sol: number;
  startLmstH: number; // local mean solar time at egress, hours
  startNodeId: string;
  nodes: TrackNode[];
  edges: TrackEdge[];
  objectives: Objective[];
  incidents: IncidentDef[];
  consumables: { o2g: number; waterg: number; battWh: number; doseBudgetmSv: number };
}

export interface Conditions {
  surfaceTempC: number;
  dustTau: number;
  gcrDoseRateuSvH: number; // open-sky baseline
}

/** What every dataset must provide. */
export interface DataProvider {
  id: string;
  label: string; // shown in HUD, e.g. "SYNTHETIC JEZERO v0"
  load(): Promise<DataBundle>;
}

export interface DataBundle {
  label: string;
  elevation: Grid; // m
  /** open-sky-normalised radiation dose rate (µSv/h), already including terrain sky-view shielding */
  radiation: Grid;
  /** dust optical depth / deposit index (0..~3) */
  dust: Grid;
  /** crustal magnetic field magnitude (nT) */
  magnetic: Grid;
  /** optional surface roughness / rock abundance 0..1; derived from elevation if absent */
  rocks?: Grid;
  pois: Poi[];
  mission: MissionDef;
  conditions: Conditions;
}
