#!/usr/bin/env node
// Serve locally-baked tiles exactly like the CDN would, so the app can hit them
// without R2. Sets Content-Encoding: gzip + Content-Type: application/json on the
// pre-gzipped .json.gz files, and returns 404 for missing cells (same as prod).
//
// Usage: node serve-local.mjs [out-dir]        (default: ./out, PORT env or 8788)
// Then point the app at it:  EXPO_PUBLIC_TILES_HOST=http://localhost:8788
// Real device on your LAN: use your Mac's IP, e.g. http://192.168.1.20:8788
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

const ROOT = process.argv[2] || 'out';
const PORT = Number(process.env.PORT || 8788);

const server = http.createServer(async (req, res) => {
  const cors = { 'access-control-allow-origin': '*' };
  try {
    const { pathname } = new URL(req.url, 'http://local');
    // Confine to /v4/**/*.json.gz; strip any ../ traversal.
    const rel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    if (!rel.startsWith('/v4/') || !rel.endsWith('.json.gz')) {
      res.writeHead(404, cors).end();
      return;
    }
    const buf = await readFile(join(ROOT, rel));
    res.writeHead(200, {
      ...cors,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'cache-control': 'no-store', // always fresh in dev
    });
    res.end(buf);
  } catch {
    res.writeHead(404, cors).end(); // missing tile = empty cell, just like prod
  }
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT}/v4 on http://localhost:${PORT}  (404 = no tile for that cell)`);
});
