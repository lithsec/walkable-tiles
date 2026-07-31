#!/usr/bin/env node
// Serve a locally-baked OUT_DIR exactly like the CDN would, so the app can hit it without
// R2. Two layouts, because a bake produces both:
//
//   the ARCHIVES (what the app reads — SPEC §11)
//     /v5/archive/index.json          from <out>/archive/v5/index.json
//     /v5/archive/<slice>-<sha>.wta   from <out>/archive/v5/<slice>-<sha>.wta,
//                                     served with RANGE support and 206 responses
//   the OBJECTS (what the packer packs, and what `inspect-bake` still reads)
//     /v5/<i>/<j>.json.gz             pre-gzipped, `content-encoding: gzip`, 404 if absent
//
// RANGE SUPPORT IS THE POINT OF THIS FILE NOW. The client refuses a 200 to a ranged read —
// it has to, because a 200 there is the whole archive, and on a real slice that is a
// gigabyte onto a phone. A dev server that quietly ignored `Range` would therefore make
// every tile fail in a way that looks like a client bug, so this one implements it
// properly: `206`, a correct `content-range`, and a `416` for a range past the end.
//
// Usage: node serve-local.mjs [out-dir]        (default: ./out, PORT env or 8788)
// Then point the app at it:  EXPO_PUBLIC_TILES_HOST=http://localhost:8788
// Real device on your LAN: use your Mac's IP, e.g. http://192.168.1.20:8788
import http from 'node:http';
import { readFile, stat, open } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';

const ROOT = process.argv[2] || 'out';
const PORT = Number(process.env.PORT || 8788);

/** `bytes=<a>-<b>` only. Suffix ranges (`bytes=-500`), open-ended ranges and multi-ranges
 *  are not implemented and are answered 416 rather than silently as a 200 — the client
 *  never sends them, and a dev server that guessed would be testing the guess. */
function parseRange(header, size) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(header ?? '');
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!(start >= 0 && end >= start && end < size)) return null;
  return { start, end };
}

const server = http.createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    // Without this a browser client cannot send `Range` at all, and the failure is a CORS
    // preflight rejection that says nothing about ranges.
    'access-control-allow-headers': 'range, x-tiles-token',
    'access-control-expose-headers': 'content-range, content-length',
    'accept-ranges': 'bytes',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  try {
    const { pathname } = new URL(req.url, 'http://local');
    // Confine to /v4/, /v5/ and /v5c/; strip any ../ traversal. `/v5c/` needs its own
    // prefix test rather than riding on `/v5`: a `startsWith('/v5')` would also admit any
    // future `/v5whatever`, and the point of the list is that it is a whitelist.
    const rel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    const ver = ['/v4/', '/v5/', '/v5c/'].find((p) => rel.startsWith(p))?.slice(1, -1);
    if (!ver) {
      res.writeHead(404, cors).end();
      return;
    }

    // ── archives ────────────────────────────────────────────────────────────────────
    const arc = new RegExp(`^/${ver}/archive/(.+)$`).exec(rel);
    if (arc) {
      const file = join(ROOT, 'archive', ver, basename(arc[1]));
      if (file.endsWith('index.json') || file.endsWith('.idx.json')) {
        const buf = await readFile(file);
        res.writeHead(200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(buf);
        return;
      }
      if (!file.endsWith('.wta')) {
        res.writeHead(404, cors).end();
        return;
      }
      const { size } = await stat(file);
      const range = parseRange(req.headers.range, size);
      const fh = await open(file, 'r');
      try {
        if (!range) {
          // No `Range`, or one this server does not implement. Refuse rather than send a
          // gigabyte: 416 is the honest answer and it is the one the client can act on.
          res.writeHead(416, { ...cors, 'content-range': `bytes */${size}` }).end();
          return;
        }
        const len = range.end - range.start + 1;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, range.start);
        res.writeHead(206, {
          ...cors,
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${range.start}-${range.end}/${size}`,
          'content-length': String(len),
          'cache-control': 'no-store',
        });
        res.end(buf);
      } finally {
        await fh.close();
      }
      return;
    }

    // ── objects ─────────────────────────────────────────────────────────────────────
    if (!rel.endsWith('.json.gz')) {
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
    `serving ${ROOT} on http://localhost:${PORT}\n` +
      `  archives  /v{4,5,5c}/archive/…   (ranged, 206; 416 for an unranged .wta)\n` +
      `  objects   /v{4,5,5c}/<i>/<j>.json.gz   (404 = no tile for that cell)`,
  );
});
