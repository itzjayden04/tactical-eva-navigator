import { it, expect } from 'vitest';
import { matchScore, fromLatLon } from '../src/ui/mapnav';
import { toLatLon } from '../src/data/types';
import { holoKey, identifiable } from '../src/ui/holo';

it('map search ranks names over notes and tolerates typos', () => {
  expect(matchScore('shelt', 'Crater Wall Shelter', 'shelter')).toBeGreaterThan(matchScore('shelt', 'Supply Cache Alpha', 'cache pre-placed pack at the shelter'));
  expect(matchScore('hab', 'Habitat')).toBe(1);
  expect(matchScore('seitah', 'Séítah Margin Outcrop')).toBeGreaterThan(0.9);
  expect(matchScore('kodak', 'Kodiak')).toBeGreaterThan(0);
  expect(matchScore('zzz', 'Habitat')).toBe(0);
});

it('lat/lon search round-trips to the local grid', () => {
  const g = { lat0: 18.44462715, lon0: 77.45088573, offsetE: 1200, offsetN: -400, radius: 3396190 };
  const ll = toLatLon(g, 250, -730);
  const p = fromLatLon(g, ll.lat, ll.lon);
  expect(p.e).toBeCloseTo(250, 3);
  expect(p.n).toBeCloseTo(-730, 3);
});

it('ID cards: what gets one, and stable identity', () => {
  const rock = { type: 'boulder' as const, name: 'Boulder', e: 10.04, n: 5, up: 0.5, dist: 20, size: 1 };
  expect(identifiable(rock)).toBe(true);
  expect(identifiable({ ...rock, dist: 300 })).toBe(false);
  expect(identifiable({ ...rock, type: 'ground' })).toBe(false);
  expect(holoKey(rock)).toBe(holoKey({ ...rock, dist: 12 }));
});
