import { defineConfig } from 'vite';
// small assets are inlined; the MediaPipe runtime + face model ship as separate static files
export default defineConfig({ base: './', build: { target: 'es2020', chunkSizeWarningLimit: 4000, assetsInlineLimit: 400_000 } });
