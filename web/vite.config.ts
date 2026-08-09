import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Absolute base: routing uses real paths (history API) now, not hash fragments, so asset
// URLs must resolve the same way from /jobs/:id as from /. No dev proxy for now: the API is
// hit directly on :8000 (CORS enabled backend-side) and will become same-origin once the Go
// binary serves the bundle itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
