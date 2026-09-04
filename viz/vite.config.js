import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defineConfig } from 'vite';

const MIME = { '.json': 'application/json', '.bin': 'application/octet-stream' };

// Vite 8's dev server fixes the public-file listing at startup, so packs the
// recorder drops in at runtime would 404 into the SPA fallback ("paket
// yüklenemedi ... <!doctype"). Serve /packs/* straight from disk instead.
function livePacks() {
  const packsDir = resolve('viz/public/packs');
  const servePacks = (server) => {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      if (!url.startsWith('/packs/')) return next();
      let file;
      try { file = resolve(join(packsDir, decodeURIComponent(url.slice('/packs/'.length)))); }
      catch { res.statusCode = 400; return res.end(); }
      if (!file.startsWith(packsDir + sep)) { res.statusCode = 403; return res.end(); }
      if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
      const ext = file.slice(file.lastIndexOf('.'));
      res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      const stream = createReadStream(file);
      stream.on('error', () => { if (!res.headersSent) res.statusCode = 404; res.end(); });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  };
  return {
    name: 'live-packs',
    configureServer: servePacks,
    configurePreviewServer: servePacks,
  };
}

export default defineConfig({
  root: 'viz',
  plugins: [livePacks()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    // the recorder drops new packs in at runtime; a watcher reload would kill
    // the live view and cancel the pack fetch right after auto-pack
    watch: { ignored: ['**/viz/public/packs/**'] },
  },
  preview: { host: '127.0.0.1' },
  // Audience packs stay local; a build contains the application and demo only.
  build: { outDir: '../dist-viz', emptyOutDir: true, copyPublicDir: false },
});
