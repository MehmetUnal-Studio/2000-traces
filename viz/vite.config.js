import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defineConfig } from 'vite';

const MIME = { '.json': 'application/json', '.bin': 'application/octet-stream' };

// Vite 8's dev server fixes the public-file listing at startup, so packs the
// recorder drops in at runtime would 404 into the SPA fallback ("paket
// yüklenemedi ... <!doctype"). Serve /packs/* straight from disk instead.
function livePacks() {
  const packsDir = resolve('viz/public/packs');
  return {
    name: 'live-packs',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/packs/')) return next();
        const file = resolve(join(packsDir, decodeURIComponent(url.slice('/packs/'.length))));
        if (!file.startsWith(packsDir + sep)) { res.statusCode = 403; return res.end(); }
        if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
        const ext = file.slice(file.lastIndexOf('.'));
        res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
        res.setHeader('cache-control', 'no-store'); // index.json changes on every pack
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: 'viz',
  plugins: [livePacks()],
  server: {
    port: 5174,
    strictPort: true,
    // the recorder drops new packs in at runtime; a watcher reload would kill
    // the live view and cancel the pack fetch right after auto-pack
    watch: { ignored: ['**/viz/public/packs/**'] },
  },
  build: { outDir: '../dist-viz', emptyOutDir: true },
});
