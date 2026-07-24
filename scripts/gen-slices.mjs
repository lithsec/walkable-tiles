#!/usr/bin/env node
// Generate a whole-world slices.json from Geofabrik's public extract index.
//
// Picks LEAF regions only (an extract with no sub-extracts) so we never process a
// continent AND its countries — every 0.01° cell is covered by exactly one slice's data,
// and the .poly ownership rule (see SPEC.md §4) keeps each cell written once. Day-of-month
// is assigned by a stable hash of the name, so adding regions later doesn't reshuffle
// everyone else's day.
//
// Usage:  node scripts/gen-slices.mjs > slices.world.json
//         (writes JSON to stdout, a summary to stderr)
const INDEX_URL = 'https://download.geofabrik.de/index-v1.json';

const res = await fetch(INDEX_URL);
if (!res.ok) {
  console.error(`fetch ${INDEX_URL} failed: ${res.status}`);
  process.exit(1);
}
const geo = await res.json();
const feats = (geo.features ?? []).map((f) => f.properties).filter(Boolean);

// A region is a parent if some other region names it as `parent`. Leaves are the rest.
const parents = new Set(feats.map((f) => f.parent).filter(Boolean));
const leaves = feats.filter((f) => f.id && f.urls?.pbf && !parents.has(f.id));

// Stable day-of-month (1..28) from the name — order-independent, add-safe.
function dayFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 28) + 1;
}

const seen = new Set();
const slices = [];
for (const f of leaves.sort((a, b) => a.id.localeCompare(b.id))) {
  let name = f.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
  if (seen.has(name)) name = `${name}-${slices.length}`; // guard against a slug collision
  seen.add(name);
  slices.push({ name, url: f.urls.pbf, day: dayFor(name) });
}

process.stdout.write(JSON.stringify(slices, null, 2) + '\n');

// Per-day balance summary to stderr.
const perDay = {};
for (const s of slices) perDay[s.day] = (perDay[s.day] ?? 0) + 1;
const counts = Object.values(perDay);
console.error(
  `${slices.length} leaf slices across ${Object.keys(perDay).length} days ` +
    `(min ${Math.min(...counts)} / max ${Math.max(...counts)} per day)`,
);
