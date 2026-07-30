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
    // Confine to /v4/, /v5/ and /v5c/ **/*.json.gz; strip any ../ traversal. `/v5c/` needs
    // its own prefix test rather than riding on `/v5`: a `startsWith('/v5')` would also
    // admit any future `/v5whatever`, and the point of the list is that it is a whitelist.
    const rel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    const served = rel.startsWith('/v4/') || rel.startsWith('/v5/') || rel.startsWith('/v5c/');
    if (!served || !rel.endsWith('.json.gz')) {
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
  console.log(
    `serving ${ROOT}/v4 + ${ROOT}/v5 + ${ROOT}/v5c on http://localhost:${PORT}` +
      `  (404 = no tile for that cell)`,
  );
});
