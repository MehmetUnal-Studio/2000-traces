import { defineConfig } from 'vite';

export default defineConfig({
  root: 'viz',
  server: {
    port: 5174,
    strictPort: true,
    // the recorder drops new packs in at runtime; a watcher reload would kill
    // the live view and cancel the pack fetch right after auto-pack
    watch: { ignored: ['**/viz/public/packs/**'] },
  },
  build: { outDir: '../dist-viz', emptyOutDir: true },
});
