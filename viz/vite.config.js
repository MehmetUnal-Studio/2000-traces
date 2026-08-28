import { defineConfig } from 'vite';

export default defineConfig({
  root: 'viz',
  server: { port: 5174, strictPort: true },
  build: { outDir: '../dist-viz', emptyOutDir: true },
});
