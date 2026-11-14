// Serving order: a fresh archive outranks a July per-cell object. The other order froze
// every legacy cell at its July contents while each monthly bake published unread archives
// underneath (no `access`, no `surface`, no OSM edit since). Fully synthetic — an archive is
// built in memory with the reference packer, R2 and the Cache API are fakes — so it runs in
// CI without the multi-GB fixtures. Run from the repo root: node --test worker/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { buildArchive } from '../../scripts/archive.mjs';

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const gz = (o) => gzipSync(Buffer.from(JSON.stringify(o)));
const FRESH = { v: 5, ways: [{ points: [], foot: true, access: 'private' }], names: [null], crossings: [] };
const JULY = { v: 5, ways: [{ points: [], foot: true }], names: [null], crossings: [] };

function fakeR2({ index = true, legacy = {} } = {}) {
  const { buffer, meta } = buildArchive({ slice: 'testland', version: 'v5', tiles: [{ i: 4235, j: -7106, body: gz(FRESH) }] });
  const entry = { ...meta, path: 'v5/archive/testland-abc.wta', sha256: 'abc0123456789def' };
  const objects = new Map(Object.entries(legacy).map(([k, v]) => [k, gz(v)]));
  objects.set(entry.path, buffer);
  if (index) objects.set('v5/archive/index.json', Buffer.from(JSON.stringify({ v: 1, version: 'v5', slices: [entry] })));
  return {
    get: async (key, opts) => {
      const b = objects.get(key);
      if (!b) return null;
      const body = opts?.range ? b.subarray(opts.range.offset, opts.range.offset + opts.range.length) : b;
      return { arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), json: async () => JSON.parse(body.toString()) };
    },
  };
}
let n = 0;
async function get(path, env) {
  const worker = (await import(`../src/worker.mjs?fresh=${n++}`)).default; // fresh module caches
  const res = await worker.fetch(new Request(`https://tiles.test${path}`), { TILES: env }, { waitUntil() {} });
  const body = res.status === 200 ? JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()) : null;
  return { res, body };
}

test('a covered cell serves the archive even when a July object exists', async () => {
  const env = fakeR2({ legacy: { 'v5/4235/-7106.json.gz': JULY } });
  const { res, body } = await get('/v5/4235/-7106.json.gz', env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-tiles-source'), /^archive /);
  assert.equal(body.ways[0].access, 'private');
});

test('a cell no archive covers still serves its July object', async () => {
  const env = fakeR2({ legacy: { 'v5/1000/1000.json.gz': JULY } });
  const { res } = await get('/v5/1000/1000.json.gz', env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-tiles-source'), 'object');
});

test('with no archive index at all, July objects keep working', async () => {
  const env = fakeR2({ index: false, legacy: { 'v5/4235/-7106.json.gz': JULY } });
  const { res } = await get('/v5/4235/-7106.json.gz', env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-tiles-source'), 'object');
});

test('unbaked with no object is still a 404', async () => {
  const { res } = await get('/v5/1000/1000.json.gz', fakeR2());
  assert.equal(res.status, 404);
});
