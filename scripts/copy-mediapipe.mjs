// Copies the MediaPipe WASM runtime into public/ so gaze tracking is served
// from our own origin (works offline and on any static host). Runs before dev/build.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const src = 'node_modules/@mediapipe/tasks-vision/wasm';
const dst = 'public/mediapipe';
if (!existsSync(src)) {
  console.warn('[mediapipe] package missing, gaze will load the runtime from the CDN');
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log('[mediapipe] wasm runtime copied to public/mediapipe');
