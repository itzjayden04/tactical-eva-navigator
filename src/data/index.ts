import type { DataBundle, DataProvider } from './types';
import { mockJezeroProvider } from './mockJezero';
import { staticGridProvider } from './staticGrid';

/**
 * Pick the dataset with `?data=<name>`:
 *   (default)           real NASA Jezero: HiRISE terrain + Perseverance route
 *                       (public/data/nasa-jezero, built by tools/fetch_nasa_jezero.py)
 *   ?data=mock          synthetic Jezero (procedural stand-in)
 *   ?data=<other>       loads public/data/<other>/manifest.json
 * If the real dataset fails to load, the synthetic one is used instead.
 */
export function selectProvider(): DataProvider {
  const name = new URLSearchParams(location.search).get('data') ?? 'nasa-jezero';
  if (name === 'mock') return mockJezeroProvider;
  const real = staticGridProvider(name);
  return {
    id: real.id,
    label: real.label,
    async load(): Promise<DataBundle> {
      try {
        return await real.load();
      } catch (e) {
        console.warn(`[TEVAN] ${name} failed to load, using synthetic terrain`, e);
        const mock = await mockJezeroProvider.load();
        return { ...mock, label: `${mock.label} (NASA data unavailable)` };
      }
    },
  };
}

export * from './types';
