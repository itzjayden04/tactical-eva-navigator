/**
 * GAZE TRACKER: webcam eye + head tracking for ONE face, fully in-browser.
 *
 * MediaPipe Face Landmarker (numFaces = 1) gives 478 landmarks including the
 * iris centres. Per frame we build a small feature vector (iris position in each
 * eye opening + head yaw/pitch proxies) and map it to a screen point:
 *   - uncalibrated: head-pose only, auto-zeroed on the first second of tracking
 *   - calibrated:   ridge regression (quadratic terms) fitted on a 13-point calibration,
 *                   with blink frames dropped, per-dot outlier rejection, and a
 *                   validation pass that removes the leftover constant offset
 * The output is smoothed with a One Euro filter. Webcam gaze is coarse
 * (~4–8° visual angle), so TEVAN uses large, well-spaced gaze targets.
 * No video frame ever leaves the device.
 */
import { FaceLandmarker, FilesetResolver, type NormalizedLandmark } from '@mediapipe/tasks-vision';

export type GazeState = 'off' | 'starting' | 'tracking' | 'noface' | 'denied' | 'error';

const MP_VERSION = '0.10.14';
const WASM_LOCAL = './mediapipe';
const WASM_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_LOCAL = './models/face_landmarker.task';
const MODEL_CDN = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/** One Euro filter (Casiez et al. 2012): low lag when moving, low jitter when still. */
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(private minCutoff = 0.9, private beta = 0.012, private dCutoff = 1) {}
  private alpha(cut: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cut);
    return 1 / (1 + tau / dt);
  }
  filter(v: number, t: number) {
    if (this.x === null) {
      this.x = v;
      this.t = t;
      return v;
    }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const d = (v - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (d - this.dx);
    const cut = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cut, dt) * (v - this.x);
    return this.x;
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
}

/** Solve (AᵀA + λI) β = Aᵀy for a small dense system (Gaussian elimination). */
export function ridge(A: number[][], y: number[], lambda = 1e-2): number[] {
  const n = A[0].length;
  const M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let r = 0; r < A.length; r++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i][j] += A[r][i] * A[r][j];
      M[i][n] += A[r][i] * y[r];
    }
  }
  for (let i = 1; i < n; i++) M[i][i] += lambda; // don't regularise the bias term
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (M[i][i] || 1e-12));
}

/**
 * Feature vector from face landmarks (image coordinates, not mirrored):
 * [irisH, irisV, headX, headY]. Larger irisH / headX = the person turned toward
 * image-right = THEIR left = SCREEN left (camera faces the user).
 */
export function gazeFeatures(lm: NormalizedLandmark[]): number[] | null {
  if (lm.length < 478) return null;
  const eye = (outer: number, inner: number, iris: number) => {
    const a = lm[outer];
    const b = lm[inner];
    const c = lm[iris];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const L2 = vx * vx + vy * vy || 1e-9;
    const L = Math.sqrt(L2);
    const t = ((c.x - a.x) * vx + (c.y - a.y) * vy) / L2; // 0..1 along the eye
    const v = ((c.x - a.x) * -vy + (c.y - a.y) * vx) / L2; // perpendicular offset / width
    return { t, v, L };
  };
  // eye on image-left: outer 33 → inner 133, iris 468; eye on image-right: inner 362 → outer 263, iris 473
  const e1 = eye(33, 133, 468);
  const e2 = eye(362, 263, 473);
  const irisH = (e1.t + e2.t) / 2;
  const irisV = (e1.v + e2.v) / 2;
  // head pose proxies: nose tip relative to cheek midpoint, normalised by face width
  const L = lm[234];
  const R = lm[454];
  const fw = Math.hypot(R.x - L.x, R.y - L.y) || 1e-6;
  const mid = { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 };
  const eyeMid = { x: (lm[33].x + lm[263].x) / 2, y: (lm[33].y + lm[263].y) / 2 };
  const nose = lm[1];
  const headX = (nose.x - mid.x) / fw;
  const headY = (nose.y - eyeMid.y) / fw;
  return [irisH, irisV, headX, headY];
}

/** Eye openness (lid gap / eye width), averaged over both eyes. Drops toward 0 in a blink. */
export function eyeOpenness(lm: NormalizedLandmark[]): number {
  if (lm.length < 478) return 1;
  const one = (top: number, bot: number, a: number, b: number) => Math.hypot(lm[top].x - lm[bot].x, lm[top].y - lm[bot].y) / (Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y) || 1e-6);
  return (one(159, 145, 33, 133) + one(386, 374, 362, 263)) / 2;
}

const median = (v: number[]) => {
  const a = [...v].sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
};

const expand = (f: number[]) => [1, f[0], f[1], f[2], f[3], f[0] * f[2], f[1] * f[3], f[0] * f[0], f[1] * f[1], f[0] * f[1]];

export class GazeTracker {
  state: GazeState = 'off';
  calibrated = false;
  /** smoothed gaze point in CSS px, or null when no face */
  point: { x: number; y: number } | null = null;
  /** last raw landmarks (for the calibration preview) */
  landmarks: NormalizedLandmark[] | null = null;
  accuracyPx = 0;
  /** human-readable reason when state is denied/error */
  lastError = '';
  video: HTMLVideoElement;
  onState: (s: GazeState) => void = () => {};
  private lm: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private feat: number[] | null = null;
  private lastFaceT = 0;
  private lastVideoT = -1;
  private fx = new OneEuro();
  private fy = new OneEuro();
  private wx: number[] | null = null;
  private wy: number[] | null = null;
  private norm: { mu: number[]; sd: number[] } | null = null;
  private zero: number[] | null = null;
  private zeroAcc: number[][] = [];
  private calib: { f: number[]; x: number; y: number }[] = [];
  /** eye openness now and its slow baseline (blink detection) */
  open = 1;
  private openBase = 0;
  blinking = false;
  /** constant offset left after the fit, measured by the validation dots (px) */
  private bias = { x: 0, y: 0 };
  /** leave-one-dot-out error of the last calibration, px (honest accuracy) */
  cvErrorPx = 0;

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  get supported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  private set(s: GazeState) {
    if (s === this.state) return;
    this.state = s;
    this.onState(s);
  }

  async start() {
    if (this.state !== 'off' && this.state !== 'error' && this.state !== 'denied') return;
    if (!this.supported) {
      this.lastError = window.isSecureContext ? 'This browser has no camera API.' : 'Camera needs https:// or http://localhost (not a file:// page).';
      return this.set('error');
    }
    this.set('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    } catch (e: any) {
      const name = String(e?.name ?? '');
      console.warn('[TEVAN gaze] camera error:', name, e?.message ?? e);
      this.lastError =
        name === 'NotAllowedError' ? 'Camera permission denied. Click the icon left of the address bar, allow Camera, reload.'
        : name === 'NotFoundError' ? 'No camera found on this computer.'
        : name === 'NotReadableError' ? 'Camera is busy: close Zoom/Teams/Camera app or other tabs using it, then reload.'
        : name === 'SecurityError' ? 'Camera needs https:// or http://localhost (not a file:// page).'
        : `Camera error: ${name || e}`;
      this.set(name === 'NotAllowedError' ? 'denied' : 'error');
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    try {
      this.lm = await this.createLandmarker(WASM_LOCAL, MODEL_LOCAL).catch((e) => {
        console.warn('[TEVAN gaze] local model failed, trying CDN:', e);
        return this.createLandmarker(WASM_CDN, MODEL_CDN);
      });
      console.info('[TEVAN gaze] face landmarker ready');
    } catch (e) {
      console.error('[TEVAN gaze] could not load the face model:', e);
      this.lastError = 'Eye-tracking model failed to load (see browser console, F12).';
      this.set('error');
      return;
    }
    this.set('noface');
    const loop = () => {
      if (!this.lm) return;
      this.tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private async createLandmarker(wasm: string, model: string) {
    const files = await FilesetResolver.forVisionTasks(wasm);
    const opts = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: model, delegate },
      runningMode: 'VIDEO' as const,
      numFaces: 1, // track ONE astronaut only
      minFaceDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
    });
    return FaceLandmarker.createFromOptions(files, opts('GPU')).catch(() => FaceLandmarker.createFromOptions(files, opts('CPU')));
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.lm?.close();
    this.lm = null;
    this.point = null;
    this.set('off');
  }

  private tick() {
    const v = this.video;
    if (!this.lm || v.readyState < 2 || v.currentTime === this.lastVideoT) return;
    this.lastVideoT = v.currentTime;
    const now = performance.now();
    let res;
    try {
      res = this.lm.detectForVideo(v, now);
    } catch {
      return;
    }
    const lm = res.faceLandmarks?.[0];
    const f = lm ? gazeFeatures(lm) : null;
    this.landmarks = lm ?? null;
    if (!f) {
      if (now - this.lastFaceT > 600) {
        this.point = null;
        this.feat = null;
        this.set('noface');
        this.fx.reset();
        this.fy.reset();
      }
      return;
    }
    this.lastFaceT = now;
    this.set('tracking');
    // blink: lids closing drags the iris landmarks, so hold the last point instead of jumping
    this.open = eyeOpenness(lm!);
    this.openBase = this.openBase ? this.openBase + (Math.max(this.open, this.openBase * 0.9) - this.openBase) * 0.02 : this.open;
    this.blinking = this.open < this.openBase * 0.62;
    if (this.blinking) {
      this.feat = null;
      return;
    }
    this.feat = f;
    const raw = this.predict(f);
    if (!raw) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const x = Math.max(0, Math.min(W, raw.x));
    const y = Math.max(0, Math.min(H, raw.y));
    this.point = { x: this.fx.filter(x, now / 1000), y: this.fy.filter(y, now / 1000) };
  }

  private predict(f: number[]): { x: number; y: number } | null {
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (this.calibrated && this.wx && this.wy && this.norm) {
      const z = expand(f.map((v, i) => (v - this.norm!.mu[i]) / this.norm!.sd[i]));
      const dot = (w: number[]) => w.reduce((s, wi, i) => s + wi * z[i], 0);
      return { x: dot(this.wx) - this.bias.x, y: dot(this.wy) - this.bias.y };
    }
    // uncalibrated: head-pose pointing, zeroed on the first ~30 frames
    if (!this.zero) {
      this.zeroAcc.push(f);
      if (this.zeroAcc.length < 30) return { x: W / 2, y: H / 2 };
      this.zero = f.map((_, i) => this.zeroAcc.reduce((s, a) => s + a[i], 0) / this.zeroAcc.length);
    }
    const dx = f[2] - this.zero[2] + 0.6 * (f[0] - this.zero[0]);
    const dy = f[3] - this.zero[3] + 0.6 * (f[1] - this.zero[1]);
    return { x: W / 2 - dx * W * 2.6, y: H / 2 + dy * H * 3.4 };
  }

  /** Re-centre the uncalibrated head-pose mapping on the current pose. */
  recentre() {
    this.zero = null;
    this.zeroAcc = [];
  }

  // ---------------------------------------------------------------- calibration
  beginCalibration() {
    this.calib = [];
  }
  /** Record the current features as looking at screen point (x, y). */
  addCalibrationSample(x: number, y: number) {
    if (this.feat) this.calib.push({ f: this.feat.slice(), x, y });
  }
  get calibrationSamples() {
    return this.calib.length;
  }
  /** Raw (unsmoothed) prediction for the current frame, for the validation dots. */
  rawPoint(): { x: number; y: number } | null {
    return this.feat ? this.predict(this.feat) : null;
  }
  /** Remove the constant offset measured by the validation dots (mean of predicted − target). */
  applyBias(dx: number, dy: number) {
    this.bias = { x: this.bias.x + dx, y: this.bias.y + dy };
    this.fx.reset();
    this.fy.reset();
  }

  /**
   * Fit the regression. Per dot, samples far from that dot's median feature vector (saccades
   * still in flight, half-blinks) are dropped first. Returns the leave-one-dot-out error in px
   * (what to expect on a point it was not trained on), or null if there is not enough data.
   */
  finishCalibration(): number | null {
    const groups = new Map<string, { f: number[]; x: number; y: number }[]>();
    for (const c of this.calib) {
      const k = `${Math.round(c.x)},${Math.round(c.y)}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
    }
    const S: { f: number[]; x: number; y: number; g: number }[] = [];
    let gi = 0;
    for (const list of groups.values()) {
      if (list.length < 4) continue;
      const k = list[0].f.length;
      const med = Array.from({ length: k }, (_, i) => median(list.map((c) => c.f[i])));
      const mad = Array.from({ length: k }, (_, i) => median(list.map((c) => Math.abs(c.f[i] - med[i]))) || 1e-6);
      const kept = list.filter((c) => c.f.every((v, i) => Math.abs(v - med[i]) <= 3.5 * mad[i] + 1e-4));
      for (const c of kept.length >= 4 ? kept : list) S.push({ ...c, g: gi });
      gi++;
    }
    if (S.length < 40 || gi < 6) return null;
    const k = S[0].f.length;
    const mu = Array.from({ length: k }, (_, i) => S.reduce((s, c) => s + c.f[i], 0) / S.length);
    const sd = Array.from({ length: k }, (_, i) => Math.sqrt(S.reduce((s, c) => s + (c.f[i] - mu[i]) ** 2, 0) / S.length) || 1e-6);
    const A = S.map((c) => expand(c.f.map((v, i) => (v - mu[i]) / sd[i])));
    const LAMBDA = 1.5;
    const dot = (w: number[], z: number[]) => w.reduce((a, wi, i) => a + wi * z[i], 0);
    // leave-one-dot-out cross-validation
    let err = 0;
    let cnt = 0;
    for (let g = 0; g < gi; g++) {
      const tr = S.map((c, i) => (c.g !== g ? i : -1)).filter((i) => i >= 0);
      const te = S.map((c, i) => (c.g === g ? i : -1)).filter((i) => i >= 0);
      if (!te.length) continue;
      const wx = ridge(tr.map((i) => A[i]), tr.map((i) => S[i].x), LAMBDA);
      const wy = ridge(tr.map((i) => A[i]), tr.map((i) => S[i].y), LAMBDA);
      const px = median(te.map((i) => dot(wx, A[i])));
      const py = median(te.map((i) => dot(wy, A[i])));
      err += Math.hypot(px - S[te[0]].x, py - S[te[0]].y);
      cnt++;
    }
    this.cvErrorPx = cnt ? err / cnt : 0;
    this.wx = ridge(A, S.map((c) => c.x), LAMBDA);
    this.wy = ridge(A, S.map((c) => c.y), LAMBDA);
    this.norm = { mu, sd };
    this.bias = { x: 0, y: 0 };
    this.calibrated = true;
    this.fx.reset();
    this.fy.reset();
    this.accuracyPx = this.cvErrorPx;
    return this.accuracyPx;
  }
}
