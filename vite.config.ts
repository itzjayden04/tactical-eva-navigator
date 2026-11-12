import { defineConfig } from 'vite';
// assets are inlined so the build can be shipped as one self-contained HTML file
export default defineConfig({ base: './', build: { target: 'es2020', chunkSizeWarningLimit: 4000, assetsInlineLimit: 10_000_000 } });
