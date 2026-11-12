import type { DataProvider } from './types';
import { mockJezeroProvider } from './mockJezero';
import { staticGridProvider } from './staticGrid';

/**
 * Pick the dataset with `?data=<name>`:
 *   ?data=mock          synthetic Jezero (default)
 *   ?data=nasa-jezero   loads public/data/nasa-jezero/manifest.json
 */
export function selectProvider(): DataProvider {
  const name = new URLSearchParams(location.search).get('data') ?? 'mock';
  return name === 'mock' ? mockJezeroProvider : staticGridProvider(name);
}

export * from './types';
