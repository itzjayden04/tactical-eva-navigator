/**
 * PERSEVERANCE RAW IMAGES (live)
 * ------------------------------------------------------------------
 * NASA's public Mars 2020 raw-image feed, the same one behind
 * https://mars.nasa.gov/mars2020/multimedia/raw-images/ . The JSON API
 * sends CORS headers, and the images display as plain <img> elements,
 * so no proxy or key is needed. Everything is cached per session and
 * fails quietly (the visor just shows no gallery) when offline.
 */
export interface RawImage {
  id: string;
  sol: number;
  camera: string;
  date: string;
  thumb: string;
  medium: string;
  link: string;
}

const API = 'https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json';

const CAMERA_NAME: Record<string, string> = {
  NAVCAM_LEFT: 'Navcam',
  NAVCAM_RIGHT: 'Navcam',
  MCZ_LEFT: 'Mastcam-Z',
  MCZ_RIGHT: 'Mastcam-Z',
  FRONT_HAZCAM_LEFT_A: 'Front Hazcam',
  FRONT_HAZCAM_RIGHT_A: 'Front Hazcam',
  REAR_HAZCAM_LEFT: 'Rear Hazcam',
  REAR_HAZCAM_RIGHT: 'Rear Hazcam',
  SUPERCAM_RMI: 'SuperCam RMI',
  SHERLOC_WATSON: 'WATSON',
  SKYCAM: 'MEDA SkyCam',
  CACHECAM: 'CacheCam',
};
export const cameraName = (c: string) => CAMERA_NAME[c] ?? c.replace(/_/g, ' ').toLowerCase();

interface ApiImage {
  imageid: string;
  sol: number;
  sample_type: string;
  date_taken_utc: string;
  link: string;
  camera: { instrument: string };
  image_files: { small: string; medium: string; large: string };
}

async function query(params: string, timeoutMs = 9000): Promise<RawImage[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(API + params, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { images?: ApiImage[] };
    return (j.images ?? [])
      .filter((i) => i.sample_type === 'Full' && i.image_files?.small)
      .map((i) => ({ id: i.imageid, sol: i.sol, camera: i.camera.instrument, date: i.date_taken_utc?.slice(0, 10) ?? '', thumb: i.image_files.small, medium: i.image_files.medium, link: i.link }));
  } finally {
    clearTimeout(t);
  }
}

export class RoverFeed {
  latest: RawImage[] | null = null;
  latestError = '';
  private bySol = new Map<number, RawImage[] | 'loading' | 'error'>();
  private latestLoading = false;
  private retryAt = 0;

  /** newest images across cameras, one per camera first for variety */
  loadLatest() {
    if (this.latest || this.latestLoading || performance.now() < this.retryAt) return;
    this.latestLoading = true;
    this.latestError = '';
    query('&num=100&page=0&order=sol+desc&extended=sample_type::full,')
      .then((imgs) => {
        const seen = new Set<string>();
        const varied = imgs.filter((i) => {
          const k = cameraName(i.camera);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        this.latest = [...varied, ...imgs.filter((i) => !varied.includes(i))].slice(0, 6);
      })
      .catch((e) => {
        this.latestError = String(e);
        this.retryAt = performance.now() + 30000;
      })
      .finally(() => (this.latestLoading = false));
  }

  /** Navcam frames from one sol (what the rover saw while driving past a spot) */
  forSol(sol: number): RawImage[] | 'loading' | 'error' {
    const c = this.bySol.get(sol);
    if (c) return c;
    this.bySol.set(sol, 'loading');
    query(`&num=6&page=0&order=sol+desc&search=NAVCAM_LEFT&condition_2=${sol}:sol:gte&condition_3=${sol}:sol:lte`)
      .then((imgs) => this.bySol.set(sol, imgs.length ? imgs : 'error'))
      .catch(() => this.bySol.set(sol, 'error'));
    return 'loading';
  }
}
