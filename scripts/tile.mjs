#!/usr/bin/env node
// OSM GeoJSON-Seq (stdin) -> walkable tiles, gzipped, one file per grid cell.
// Writes BOTH formats from one pass:
//   v4 (unchanged, byte-identical to before v5 existed — Cologra depends on it)
//   v5 = the v4 payload + landcover/landmarks/habitat for Ausculta (SPEC.md §10)
//
// Grid + v4 payload match apps/mobile/src/run/osm.ts EXACTLY so tiles are a drop-in
// for the app's live fetch path:
//   TILE_DEG   = 0.01      cell key = `${floor(lat/0.01)}:${floor(lng/0.01)}`
//   BOX_HALF_M = 1200      each tile holds all data within 1200 m of the cell CENTER
//   payload v4 = { v:4, ways:[{points,foot}], names:[string|null], crossings:[{lat,lng}] }
//   payload v5 = { v:5, ...v4 keys..., landcover, landmarks, habitat }   (additive)
//     …and v5's ways may additionally carry `lit` (boolean) and `access`
//     ('private'|'no'|'permissive'), written ONLY when OSM tags them. v4's way objects
//     are spelled out field-by-field below and never see either, so v4 stays byte-identical.
//
// Input: `osmium export <filtered.pbf> -f geojsonseq --add-unique-id=type_id`
// Output: <out>/v4/<i>/<j>.json.gz  +  <out>/hashes.json  (cellKey -> sha256 of the
// uncompressed JSON, used by bake-slice.sh to upload only changed tiles), and the
// same pair for v5 (<out>/v5/…, <out>/hashes-v5.json), plus the habitat sidecar
// <out>/habitat-<slice>.jsonl (one line per non-rural spawn cell — SPEC.md §10.4) and the
// landmark anchor sidecar <out>/landmarks-<slice>.jsonl (one line per DISTINCT anchor the
// regional cap kept — SPEC.md §10.8).
//
// Usage: node tile.mjs --out <dir> [--slice <name>] [--poly <file> | --bbox minLng,minLat,maxLng,maxLat]
// Ownership: a cell is WRITTEN by this slice iff its center is inside the poly/bbox,
// so exactly one slice writes each cell even though Geofabrik extracts overlap at seams.
// The habitat sidecar applies the same rule at spawn-cell granularity.
import readline from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Dem, buildReliefGrid } from './dem.mjs';

const TILE_DEG = 0.01;
const BOX_HALF_M = 1200;
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'track', 'living_street']);
const ROAD = new Set(['residential', 'service', 'unclassified']);
const WALK = new Set([...FOOT, ...ROAD]);

// ---- v5 constants (normative — SPEC.md §10 documents these values; change both) ----
const CELL_DEG = 0.0015; // Ausculta spawn-cell grid (packages/content/src/habitat.ts density)
// TILE_DEG / CELL_DEG == 20/3 exactly (both are exact decimals), so a tile's spawn-cell
// range is pure integer math: rows/cols alternate 7,8,7 as the tile index mod 3 walks.
const CELL_RATIO_N = 20;
const CELL_RATIO_D = 3;
const M_PER_DEG = 111320; // meters per degree of latitude (and of longitude at cos(lat)=1)
const SIMPLIFY_TOL_M = 10; // Douglas-Peucker tolerance — shapes stay recognizable at ~500 m viewport
const LC_MIN_AREA_M2 = 2000; // drop landcover rings smaller than this before clipping
const LC_MIN_CLIPPED_M2 = 1000; // drop per-tile clipped slivers smaller than this
const LC_CLASSES = ['water', 'wood', 'green', 'field']; // precedence order when tags overlap
const LANDMARKS_PER_TILE = 6;
// At most this many SETTLEMENT landmarks (tier 0/1) in one tile. A metro packs several
// place=city/town nodes inside one city radius — Boston, Cambridge, Somerville, Brookline
// are all within 8 km of each other — and without a cap they would take every slot in the
// tile and push out the parks that make the drawn page legible.
const SETTLEMENTS_PER_TILE = 2;
// How far from a settlement's centre NODE that settlement is listed as a landmark.
// This is PROXIMITY, not membership: OSM maps a settlement's extent as a
// boundary=administrative relation, which this bake deliberately does not carry (see
// SPEC §10.2). A flat 1200 m would make "you walked through Provo" almost always false-
// negative — you can walk all day inside a city without passing within 1.2 km of its
// centre node — so the radius scales with the place class. It is an approximation and the
// spec says so; it never claims containment.
const PLACE_RADIUS_M = { city: 8000, town: 4000, village: 2000, suburb: 2000, hamlet: 1200 };
// Landmark kinds by TIER — the first sort key inside a tile (SPEC §10.2). Footprint area
// only breaks ties WITHIN a tier, which is what stops a zero-area settlement node from
// sorting last and being truncated away: measured on the live bake, downtown Wichita's
// three landmark slots are three city parks, so "Wichita" itself would never have shipped.
const LANDMARK_TIER = {
  city: 0,
  town: 0,
  village: 1,
  hamlet: 1,
  suburb: 1,
  peak: 2,
  national_park: 3,
  protected_area: 3,
  park: 4,
  nature_reserve: 4,
  common: 4,
  cemetery: 4,
  library: 4,
};
const PLACE_KINDS = new Set(['city', 'town', 'village', 'hamlet', 'suburb']);
// A tier-0/1 landmark is a settlement; SETTLEMENTS_PER_TILE applies to exactly these.
const isSettlement = (kind) => LANDMARK_TIER[kind] <= 1;
// Candidate-tile ceiling for containment binning of one area landmark (~a 500 km square).
// A pathological protected_area spanning an ocean must not turn into a 10^6-cell loop;
// above the cap the landmark falls back to centroid-proximity binning alone.
const LM_COVER_MAX_CELLS = 200000;

// ---- landmark significance and the regional anchor cap (SPEC §10.2, §10.8) -----------
//
// WHY THERE IS A SECOND CAP AT ALL. LANDMARKS_PER_TILE answers "what fits on the drawn
// page"; it is a per-tile budget and it stays exactly as it was. This one answers a
// different question — "which named things are significant enough to hold a creature" —
// and it has to be answered over a REGION, because significance is comparative. Measured
// on trial bakes: vermont produced 1,291 distinct named summits and the District 341
// distinct parks. Neither is a collection; both are a spreadsheet.
//
// The owner's call is ~15 anchors per ~100 km of walking radius, AREA-NORMALISED. Per
// slice would be wrong twice over: it would hand Vermont and California the same number,
// and it would make the count an artefact of where a bake was cut rather than a fact about
// the ground.
const ANCHORS_PER_100KM_RADIUS = 15;
const ANCHOR_DENSITY_PER_KM2 = ANCHORS_PER_100KM_RADIUS / (Math.PI * 100 * 100); // 4.775e-4
// Spatial spread: at most ONE anchor per cell of this size. Without it the count cap alone
// picks the five highest points on one mountain — measured, Vermont's top summits by `ele`
// are Mansfield 1340, Adams Apple 1256, Lower Lip 1256, The Nose 1225, Upper Lip 1208, of
// which four are named sub-summits OF Mansfield, all within 2 km of it. 0.5° is ~46 km
// north-south, and sqrt(1 / ANCHOR_DENSITY_PER_KM2) is 45.8 km: the cell IS the density
// expressed as a distance, so the two terms agree by construction rather than by tuning,
// and the cell nests exactly in whole degrees.
const ANCHOR_CELL_DEG = 0.5;
// An anchor must also BE significant, not merely the least insignificant thing nearby.
// 0 is "at the reference magnitude for its own kind" (LANDMARK_SIG_REF_M2 below), so this
// is the abstention half of the rule: a slice whose best named thing is a 2,000 m² lot
// emits no anchor rather than promoting the lot. It does NOT bind on either trial slice —
// the count cap binds first in both — and that is worth saying plainly rather than letting
// a reader assume it was measured.
const ANCHOR_SIG_MIN = 0;
// Latitude step for the slice-area integral that sets the anchor count. It is a scanline,
// so the cost is rows × ring points; 0.05° is ~5.6 km and lands Vermont at 24,991 km²
// against a published 24,923 (+0.3%), far inside the rounding of `round(density × area)`.
const SLICE_AREA_STEP_DEG = 0.05;
// The magnitude at which a feature of each kind becomes LOCALLY NOTABLE — the unit its
// significance is measured in. `null` means the kind is not anchorable at all.
//
// Significance is log2(magnitude / reference), so a score is a number of DOUBLINGS above
// the point where a thing of that kind starts being worth naming. That is what makes a
// cemetery comparable to a national park without either needing a hand-set prior. The
// values are read off the measured distributions of the two trial slices: park p90 is
// 64,602 m² in the District and 160,686 m² in Vermont (ref 1e5); cemetery p50 24,343 and
// 6,575 (ref 5e4); nature_reserve p50 121,513 and 234,103 (ref 5e5); protected_area p50
// 1,025,794 in Vermont (ref 5e6).
//
// SETTLEMENTS ABSTAIN, and the bake already says why in its own words a few constants up:
// a settlement is carried as its centre NODE with a proximity radius, and that "is not a
// claim of membership". A point that does not locate the thing at walking scale cannot
// anchor a creature to it, so spending a cell's single anchor on `city@Washington` would
// spend it on one arbitrary downtown intersection.
//
// national_park's reference IS its promotion threshold (NP_MIN_AREA_M2), so the smallest
// feature that survives promotion scores exactly 0.
const LANDMARK_SIG_REF_M2 = {
  city: null,
  town: null,
  village: null,
  hamlet: null,
  suburb: null,
  peak: null, // scored from `ele` instead — see landmarkSig()
  national_park: 5e7,
  protected_area: 5e6,
  park: 1e5,
  nature_reserve: 5e5,
  common: 1e5,
  cemetery: 5e4,
  // A library is a BUILDING, and most are mapped as nodes with no footprint at all. 1 ha is
  // a main-library footprint; the District's largest, the Madison Building at 18,770 m²,
  // then scores 0.91 and sits below any real park. At the 1,000 m² a branch library
  // occupies it scored 4.23 and won the entire District, which is how this number got
  // measured rather than guessed.
  library: 1e4,
};
// A summit's significance comes from its LOCAL RELIEF, and the bridge to an area is
// dimensional: at a fixed hillside slope a summit standing h metres above its own ground
// has a footprint ∝ h², so log2 of that footprint is 2·log2(h) and the slope cancels out of
// the ranking entirely. Only a reference height survives.
//
// THIS IS THE LINE THAT COPERNICUS RELIEF CHANGED (2026-07-30). It used to read `ele`,
// which is height above SEA LEVEL, so a 1,700 m bump on the Colorado plateau out-scored
// every city park in the country and the previous revision could only warn about it.
// The magnitude is now the summit's DROP into the ground within PEAK_RELIEF_R_M of it — a
// fact about the ground the summit stands on, comparable across a continent.
//
// THE MAGNITUDE IS THE DROP, `elev(summit) − min(window)`, and NOT the window's range.
// That was measured the hard way: ranking Vermont by `max − min` over a 1 km disc handed
// the state's twelve anchors to Table Rock, The Cobble (265 m) and Bear Mount and left out
// Mount Mansfield, Killington Peak and Camels Hump — because a knob beside a mountain has
// the mountain inside its window. Range detects cliffs; drop measures the summit.
//
// R = 2000 m, and it is the massif's shoulder that sets it. The window has to be wider than
// the ridge a summit sits on or it ranks the ridge instead. Measured on Vermont's own
// sub-summits, drop in metres:
//
//                       R = 1000   R = 1500   R = 2000
//   Mount Mansfield         546        729        837
//   Adams Apple             597        734        766     (a knob 1 km along the ridge)
//   Bear Head               597        663        691
//   Killington Peak         381        471        538
//   Little Killington       344        430        485
//
// At 1 km Mansfield loses its own anchor cell twice over; at 1.5 km it loses to Adams Apple
// by five metres; at 2 km it leads Vermont outright and every named sub-summit of Mansfield,
// Killington and Equinox falls behind its parent.
//
// ── R WENT 2000 -> 8000 BECAUSE 2 km WAS CALIBRATED ON VERMONT (2026-07-31) ────────────
//
// Vermont's mountains are ~1,300 m and sit on ridges a couple of kilometres wide, so a 2 km
// disc contains a Vermont summit AND its own ground. The Wasatch and the Uintas do not fit
// in it, and a window narrower than the massif measures the massif's shoulder rather than
// the mountain. Measured drop, in metres:
//
//                           r=2000   r=4000   r=8000   r=16000
//   Mount Timpanogos          1063     1614     2094      2138
//   Cascade Mountain          1316     1778     1884      1931
//   Mount Nebo                1195     1770     2118      2237
//   Lone Peak                  808     1347     1665      1740
//   Kings Peak (UT high pt)    688      844     1057      1424
//   Mount Mansfield (VT)       832     1036     1163      1200
//
// At 2 km, CASCADE MOUNTAIN OUTSCORES MOUNT TIMPANOGOS and takes their shared 0.5° anchor
// cell, which is how this was found: `verify-coverage`'s Timpanogos probe. Worse and more
// systematic, Kings Peak — the highest point in Utah — scored LOWEST of every peak in that
// table, and the shipped utah bake anchored Whiskey Knoll, Cobble Hill and Bald Knoll while
// the entire Uinta range, Timpanogos and Lone Peak got nothing. An isolated butte on a plain
// has a large 2 km drop; a 4,000 m summit in the middle of a high range does not.
//
// 8 km is where the pair inverts and stays inverted (Timpanogos passes Cascade between 4 and
// 8 km and leads by 210 m there). 16 km buys little and stops being local.
//
// WHAT THIS STILL DOES NOT FIX, said plainly: Kings Peak is last at EVERY radius on that
// ladder, because it stands on a plateau that holds above 3,600 m for tens of kilometres —
// its independence is TRUE prominence, whose key col is far outside any local window. Drop at a
// radius cannot see that. Utah's anchors will be Nebo, Timpanogos, Cascade and Peale rather
// than its literal high point, and that is a better roster for walking to than the old one
// but it is not the correct one. True prominence needs a watershed pass over the DEM.
//
// REF = 95 m, and it is DERIVED rather than re-guessed. The old 60 m was the District's
// median summit drop at 2 km, which put Point Reno — genuinely the District's high point —
// at +0.97 and the median hill at 0. Point Reno measures 84 m at 2 km (the value this
// comment recorded before the change, reproduced exactly) and 133 m at 8 km, a ratio of
// 1.58; 60 × 1.58 = 95, and 2·log2(133/95) = +0.97. So the calibration point keeps its
// score to two decimal places and the District's median hill still sits at zero.
//
// That is the property that keeps the blast radius small: because the reference moved with
// the measure, PEAKS DID NOT MOVE RELATIVE TO THE AREA KINDS. Mansfield goes 7.60 -> 7.23,
// Timpanogos 8.29 -> 8.92. The AREA references below, balanced against the old peak scores,
// still hold, and ANCHOR_SIG_MIN still means what it meant.
const PEAK_RELIEF_R_M = 8000;
const PEAK_RELIEF_REF_M = 95;
// `boundary=national_park` is an ADMINISTRATIVE tag, not a claim about scale, and in the US
// the National Park Service puts it on everything it operates. Measured in the District:
// all 37 features the old rule promoted carry it, and they are Dupont Circle (9,000 m²),
// Folger Park (7,000 m²), the Vietnam Veterans Memorial (9,000 m²) and "Anacostia Park
// Section D". `protect_class=2` fails in the other direction: Vermont's three promotions
// were all STATE parks tagged IUCN category II, and West Potomac Park carries it too.
//
// So a tag is necessary and nowhere near sufficient, and AREA is the only lever that
// generalises past one country's tagging habits. 50 km² is roughly a 7 km square — the
// smallest thing that reads as somewhere you travel to and spend a day in — and it is 7×
// the largest NPS unit in the District (Rock Creek Park, 7.2 km²), so it is not a number
// tuned to squeak past one measurement.
//
// WHAT IT COSTS, NAMED: Hot Springs NP (22 km²) and Gateway Arch NP (0.75 km²) will read as
// `park`/`protected_area`. And area cannot separate a National Park from a National
// Recreation Area of the same size — Golden Gate NRA (330 km²) will read as one. That is
// accepted: the badge's promise is about SCALE, and neither of those is a lie about the
// ground the way "Dupont Circle, National Park" is.
const NP_MIN_AREA_M2 = 5e7;

// OSM `lit` -> boolean, for the values that are UNAMBIGUOUS. Everything else — `limited`,
// `interval`, `seasonal`, an unrecognised value, or no tag at all — is OMITTED rather than
// guessed. Absent means UNKNOWN and must never be read as "unlit": this field exists to
// keep street-safety from routing a player down a dark path, and a fabricated `false` is
// worse than a gap because the gap is visible and the fabrication is not.
const LIT_YES = new Set(['yes', '24/7', 'sunset-sunrise', 'dusk-dawn', 'automatic']);
const LIT_NO = new Set(['no', 'disused']);
// The three access values worth carrying: all three mean "do not route a player here".
// `destination`, `customers`, `agricultural` etc. are omitted — they are not a clean
// no, and a wrong restriction is as bad as a missing one.
const ACCESS_KINDS = new Set(['private', 'no', 'permissive']);
const HAB_STEP_M = 20; // way length is credited to spawn cells in steps of this size
// Habitat classifier — THE RULES DO NOT LIVE HERE ANY MORE (SPEC.md §10.3, §10.4).
//
// Revision 4 stopped baking a class and started baking the MEASUREMENTS. `scripts/habitat.mjs`
// holds the feature record, every threshold and the multi-label rule; this file's job is to
// produce the aggregates and write them. The reason is that a rule shipped as one character
// per cell can only be changed by re-baking every slice — `mountain`'s radius and threshold
// each moved twice in one afternoon of calibration — and a rule nobody can afford to change
// is a rule nobody changes.
//
// The line between the two files is not "constants over there". A MEASUREMENT PARAMETER
// stays here (MOUNTAIN_RELIEF_R_M below defines what the number in the record IS, so moving
// it moves the data and costs a re-bake); an INTERPRETATION goes there (the 500 m threshold
// is free to move, and has, twice).

// ---- mountain: regional relief, not slope and not altitude (SPEC §10.4) ---------------
//
// THE DEFINITION, AND THE THREE CASES THAT RULE OUT THE OBVIOUS ANSWERS. A city IN the
// mountains counts; a big hill inside a city does not; the Rockies count. Absolute
// elevation fails the first pair — a Swedish fjäll town sits lower than flat Denver at
// 1,600 m. Slope fails all three — a city hill is the steepest thing for miles and a
// Rockies valley floor is flat. What separates them is the RADIUS at which relief is
// measured: a city hill has high relief within 1 km and low within 5, and a mountain town
// is the reverse. So: elevation range over a 5 km disc, and a mountain VALLEY FLOOR is
// mountain, because the mountains are inside the window even though the ground underfoot
// is flat. That is the right answer for a game played on foot — you are IN the mountains.
//
// R = 5000 m. Measured on Vermont, 2026-07-30, the separation is widest here: at 4 km
// Stowe (a mountain village) scores 466 m and Island Pond (rolling Northeast Kingdom
// hills) scores 403 — no gap. At 6 km Montpelier climbs to 345 and erodes it from the
// other side. At 5 km the Champlain and Connecticut valley towns run 111–458 m and the
// mountain towns run 568–1074, and nothing lands in between.
//
// THRESHOLD = 500 m, which is the top of the 400–500 m band the scoping doc proposed, and
// it is set by that gap rather than by the band: 450 admits Island Pond at 458. Checked
// worldwide against the owner's own cases, disc radius 5 km:
//
//   Denver 88   Stockholm 90   Boston Common 70   Amsterdam 50   Phoenix 57   Miami 26
//   Sheffield 246 (the steepest city in England)   Colorado Springs 223   Kiruna 338
//   —— threshold 500 ——
//   SLC downtown 528   Leadville 726   Estes Park 780 (a Rockies VALLEY FLOOR)
//   Keswick 787   Boulder 868   Björkliden 956   Åre 1044 (the fjäll town)
//   Alta 1234   Provo 1371   Zermatt 2132   Chamonix 2603
//
// Flagstaff (270) and Kathmandu (455) fall below and are the honest cost: both sit on a
// plateau or a valley floor whose mountains are 10–15 km out, which is further than a walk.
const MOUNTAIN_RELIEF_R_M = 5000;

// ---- v5c: the COARSE landcover layer (SPEC §10.10) -----------------------------------
//
// THE MEASUREMENT THAT FORCES THIS ARTIFACT. A v5 tile is ~890 KB in a city (downtown SLC
// 891 KB, Boston 911 KB — measured on the live CDN), and the app's tile cache is 128 MiB
// TOTAL. Ausculta wants a map that zooms out to ~5 km while gameplay stays at 600 m, and
// the request set for a 5 km radius is ~165 cells: ~145 MB in one pinch, more than the
// entire cache. Raising the live radius cannot do it. The habitat atlas (§10.7) cannot
// either — 693 B for all of Vermont, but its blocks are 8 × 11 km, which is a pixel at the
// zoom this is for. NOTHING SERVED THE BAND BETWEEN 600 m AND 10 km.
//
// WHERE THE SAVING COMES FROM: ways. A v5 tile is 98.8% ways/names/crossings (measured:
// downtown SLC v4 880,063 B vs v5 890,931 B), and at 5 km a street is a hair. So the coarse
// artifact carries SHAPE ONLY — simplified landcover polygons and nothing else. No ways, no
// crossings, no names, no habitat grid, no landmarks. Each of those is refused for its own
// reason and §10.10 records them.
//
// GRANULARITY: ONE ARTIFACT PER v5 TILE, on the SAME 0.01° grid, at `v5c/<i>/<j>.json.gz`.
// A block of 4 × 4 or 16 × 16 tiles would cut the round trips for a 5 km view from ~165 to
// ~25 or ~9, and it was rejected because of §4. Ownership is per CELL CENTRE, so a coarser
// block is owned by whichever slice holds its centre — and that slice bakes it from an
// extract that carries its neighbour's geometry only as far as Geofabrik's buffer reaches.
// A 0.16° block therefore leaves a blank ribbon up to 17 km wide along every slice
// boundary, at exactly the zoom this artifact exists for. On the 0.01° grid that ribbon is
// the 1.1 km the v5 tiles already accept and no zoom can see. The stated problem is BYTES
// (a 128 MiB cache against a 145 MB fetch), not round trips — the client already asks for
// ~165 cells at that radius today — so the grid that costs nothing in correctness wins.
//
// CLIPPED TO THE CELL RECT, NOT TO THE ±1200 m BOX. v5 clips to the box and the client
// dedupes the seam copies; ~165 overlapping boxes would be ~9× the bytes for the same
// ground. Clipping to the cell makes the coarse tiles a PARTITION — every polygon appears
// in exactly the cells it covers, adjacent pieces abut, the union is seamless and the
// client needs no dedupe at all. The rect is padded by COARSE_CLIP_PAD_M so abutting pieces
// overlap by a hair: two exactly-abutting fills leave an antialiasing hairline, and the
// renderer composites a class's polygons under one group opacity, so a slight overlap
// unions away invisibly (the same property that already lets v5's seam duplicates paint).
const COARSE_SIMPLIFY_TOL_M = 50;
// Drop anything smaller than this BEFORE clipping. At the ~5 km span this layer is drawn
// at, a full-width phone panel is ~390 SVG units across, so one unit is ~12.8 m: a
// 50,000 m² blob is a 224 m square, 17.5 units, the smallest thing that reads as a SHAPE
// rather than as a speck. Below it a page is dots, and a page of dots is noise.
const COARSE_MIN_AREA_M2 = 50000;
// Post-clip sliver floor, half the pre-clip one — the same 2:1 ratio §10.1 uses.
const COARSE_MIN_CLIPPED_M2 = 25000;
const COARSE_CLIP_PAD_M = 40;
// Coordinate rounding. 1e-5° is ~1.1 m: 45× finer than the simplification tolerance and
// well inside the clip pad, so it cannot open a seam, and it is one character per
// coordinate cheaper than §10.1's 1e-6. A tenth of a metre on a shape that is honestly
// ±50 m is a precision this artifact does not have.
const COARSE_ROUND = 5;

// ---- habitat atlas (SPEC §10.7) — which classes OCCUR in each coarse block ----------
// A block is ATLAS_BLOCK_CELLS × ATLAS_BLOCK_CELLS spawn cells:
//     bx = floor(cx / 64)     by = floor(cy / 64)     (floor toward −inf, not truncation)
// 64 × 0.0015° = 0.096°, ≈ 10.7 km north-south, and 0.096°·cos(lat) east-west — 7.7 km at
// Vermont's 44°N, 8.3 km at DC's 39°N.
//
// Blocks are defined on the SPAWN-CELL grid rather than on a round decimal like 0.1°,
// because 0.1 / 0.0015 = 66.67: a 0.1° block edge cuts through spawn cells, and which
// block a cell belongs to would then depend on float rounding of the cell's centre. 64 is
// exact, is a power of two, and keeps the whole index in integers — which matters because
// Ausculta's server re-derives from this spec in plpgsql, where a disagreement of one
// block is a creature that spawns in the wrong state.
const ATLAS_BLOCK_CELLS = 64;
// One BIT per habitat class, TWO base64url characters per block. The bit table is
// `HABITAT_BIT` in scripts/habitat.mjs — one numbering shared with the per-cell grid rather
// than a second one that has to be kept in step.
//
// TWO CHARACTERS, NOT ONE, AS OF `water` (atlas v2). Six bits was exactly the class
// vocabulary's width and the seventh class overflows it. `rural` is not the bit to spend:
// mask 0 means NO DATA — this slice owns no classified cell in that block — and without an
// explicit rural bit the atlas cannot tell "90% of Vermont is rural" from "that is the next
// state". So the slot widens to 12 bits, which leaves five spare and makes the NEXT class
// free. Measured cost below in §10.7; it is tens of bytes.
const ATLAS_CHARS = 2;

// ---- args ----
import {
  B64,
  FEAT_CHARS,
  HABITAT_BIT,
  HABITAT_CLASSES,
  classifyFeatures,
  classesOf,
  decodeFeatures,
  encodeFeatures,
} from './habitat.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = opt('--out') || 'out';
const SLICE = opt('--slice') || 'slice';
const polyPath = opt('--poly');
const bboxArg = opt('--bbox');

let ownRings = null;
let bbox = null;
if (polyPath) ownRings = parsePoly(readFileSync(polyPath, 'utf8'));
else if (bboxArg) {
  const b = bboxArg.split(',').map(Number);
  bbox = { minLng: b[0], minLat: b[1], maxLng: b[2], maxLat: b[3] };
}

const cellCenter = (i, j) => ({ lat: (i + 0.5) * TILE_DEG, lng: (j + 0.5) * TILE_DEG });

function ownsLatLng(lat, lng) {
  if (ownRings) return pointInRings(lng, lat, ownRings);
  if (bbox) return lat >= bbox.minLat && lat <= bbox.maxLat && lng >= bbox.minLng && lng <= bbox.maxLng;
  return true; // unconstrained -> own everything (single-slice local test)
}

function owns(i, j) {
  const c = cellCenter(i, j);
  return ownsLatLng(c.lat, c.lng);
}

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR;
  const dLng = (bLng - aLng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Cells whose CENTER is within `radiusM` of (lat,lng). At the default BOX_HALF_M and
// 0.01 deg (~1.1 km) that's this cell plus the ring of neighbors it reaches — ~3x3
// candidates, filtered by true distance. Landmark binning passes a larger radius for
// settlement nodes (PLACE_RADIUS_M); ways and crossings always use BOX_HALF_M, so v4 is
// untouched by the parameter existing.
function cellsNear(lat, lng, radiusM = BOX_HALF_M) {
  const latPad = radiusM / 111320 + TILE_DEG;
  const lngPad = radiusM / (111320 * Math.cos(lat * Math.PI / 180)) + TILE_DEG;
  const iMin = Math.floor((lat - latPad) / TILE_DEG);
  const iMax = Math.floor((lat + latPad) / TILE_DEG);
  const jMin = Math.floor((lng - lngPad) / TILE_DEG);
  const jMax = Math.floor((lng + lngPad) / TILE_DEG);
  const out = [];
  for (let i = iMin; i <= iMax; i++) {
    for (let j = jMin; j <= jMax; j++) {
      const c = cellCenter(i, j);
      if (haversineM(lat, lng, c.lat, c.lng) <= radiusM) out.push(i + ':' + j);
    }
  }
  return out;
}

const cells = new Map(); // key -> { ways:Map<id,way>, crossings:Map<coord,{lat,lng}> }
function cell(key) {
  let c = cells.get(key);
  if (!c) {
    c = { ways: new Map(), crossings: new Map() };
    cells.set(key, c);
  }
  return c;
}

function addWay(id, points, foot, name, lit, access) {
  const touched = new Set();
  for (const p of points) for (const k of cellsNear(p.lat, p.lng)) touched.add(k);
  for (const k of touched) {
    const c = cell(k);
    // points shared by ref, not copied. `lit`/`access` are undefined for the vast
    // majority of ways and are only ever WRITTEN into the v5 payload (SPEC §10.6) —
    // the v4 write loop below spells its way objects out field by field, so v4 stays
    // byte-identical whatever is attached here.
    if (!c.ways.has(id)) c.ways.set(id, { points, foot, name, lit, access });
  }
}

// OSM `lit=*` -> boolean | undefined. See LIT_YES/LIT_NO: undefined is ABSTENTION.
function wayLit(pr) {
  const v = pr.lit;
  if (LIT_YES.has(v)) return true;
  if (LIT_NO.has(v)) return false;
  return undefined;
}

// OSM `access=*` -> one of ACCESS_KINDS | undefined. Absent means no restriction is
// mapped, which is not the same claim as "public" — it is the absence of one.
function wayAccess(pr) {
  return ACCESS_KINDS.has(pr.access) ? pr.access : undefined;
}

function addCrossing(lat, lng) {
  const ck = lat.toFixed(6) + ',' + lng.toFixed(6);
  for (const k of cellsNear(lat, lng)) cell(k).crossings.set(ck, { lat, lng });
}

// ================================ v5 state =================================
// Kept OUT of `cells` so the v4 write loop below (and hashes.json) is untouched
// by landcover-only or landmark-only cells — v4 output stays byte-identical.
const lcPolys = []; // { cls, rings:[[ [lng,lat], … ]…] } — rings open (no dup last), [0]=outer
const lcByCell = new Map(); // tileKey -> [lcPolys index]  (clipped lazily at write time)
const lmByCell = new Map(); // tileKey -> [{ name, lat, lng, kind, area, ele, key }]
const anchorCands = new Map(); // anchorKey -> { key, kind, lat, lng, ele, sig, name } —
//                                one entry per DISTINCT anchor point owned by this slice,
//                                which is what the sidecar counts (SPEC §10.8). A landmark
//                                is listed from every tile that reaches it; it is a
//                                candidate exactly once.
const hab = new Map(); // `${cx}:${cy}` (Ausculta cellId order: cx=lng, cy=lat) ->
//                        { foot, res, road, wmask, gmask, amask } — meters per way group +
//                        the 2x2 cover-sample bits, wood / green / water kept APART. These
//                        ARE the feature record of SPEC §10.4; nothing else is measured.

function landcoverClass(pr) {
  // Precedence when a feature carries tags from several classes: LC_CLASSES order.
  if (pr.natural === 'water' || pr.waterway === 'riverbank' || pr.landuse === 'reservoir' || pr.landuse === 'basin')
    return 'water';
  if (pr.natural === 'wood' || pr.landuse === 'forest') return 'wood';
  if (
    pr.leisure === 'park' || pr.leisure === 'garden' || pr.leisure === 'common' ||
    pr.landuse === 'grass' || pr.landuse === 'meadow' || pr.landuse === 'recreation_ground' ||
    pr.landuse === 'village_green'
  )
    return 'green';
  if (pr.landuse === 'farmland' || pr.landuse === 'farmyard' || pr.landuse === 'orchard') return 'field';
  return null;
}

// Landmark kind, most-specific tag first (SPEC §10.2). Order is load-bearing for the
// three US national parks this was checked against — Everglades, Grand Canyon and Zion
// are ALL tagged `boundary=protected_area` + `leisure=nature_reserve` and NONE of them
// carries `boundary=national_park`, so a `leisure` test placed first would have quietly
// classed every US national park as a local nature reserve. `protect_class=2` is IUCN
// category II ("National Park") and `protected_area=national_park` is the US tagging;
// Grand Canyon has only the latter, Everglades and Zion have both.
//
// `national_park` now needs AREA as well as a tag (NP_MIN_AREA_M2 — see the measurements
// there). What happens to a feature whose national-park claim is REFUSED depends on which
// tag made the claim, and the two are genuinely different:
//
//   • `boundary=protected_area` says "protected area" INDEPENDENTLY of the claim, so a
//     refused promotion leaves it exactly where it was — this line is unchanged, and
//     Vermont's three state parks land on `protected_area` where they belong.
//   • `boundary=national_park` IS the claim and says nothing else, so refusing it means the
//     tag carries no weight at all and whatever else the feature is tagged describes it
//     better. Every NPS unit in the District also carries `leisure=park`, so "Anacostia
//     Park Section D" becomes a `park` — which is what it is. The last line catches the
//     handful with no other tag (memorials) so that nothing NAMED is silently dropped.
//
// `areaM2` is 0 for nodes and for the candidacy call made before an area is known; that is
// safe because area can only ever PROMOTE, so a zero-area call returns non-null on exactly
// the same features a full one does.
function landmarkKind(pr, areaM2) {
  const npClaim =
    pr.boundary === 'national_park' ||
    (pr.boundary === 'protected_area' &&
      (pr.protect_class === '2' || pr.protected_area === 'national_park'));
  if (npClaim && areaM2 >= NP_MIN_AREA_M2) return 'national_park';
  if (pr.boundary === 'protected_area') return 'protected_area';
  if (pr.natural === 'peak') return 'peak';
  if (PLACE_KINDS.has(pr.place)) return pr.place;
  if (pr.leisure === 'park') return 'park';
  if (pr.amenity === 'library') return 'library';
  if (pr.landuse === 'cemetery') return 'cemetery';
  if (pr.leisure === 'nature_reserve') return 'nature_reserve';
  if (pr.leisure === 'common') return 'common';
  if (pr.boundary === 'national_park') return 'protected_area';
  return null;
}

// How significant a landmark is, in doublings above its kind's locally-notable reference
// (LANDMARK_SIG_REF_M2). `null` means the kind cannot anchor a creature at all.
//
// -Infinity is a real answer and not a bug: a peak the DEM does not cover, and an area kind
// whose parts all fell under LC_MIN_AREA_M2, have no magnitude to measure, so they sort
// below everything that does and below ANCHOR_SIG_MIN. An unmeasured thing is not a small
// thing, but it is not evidence of a large one either, and this cap is spending scarce
// slots.
function landmarkSig(kind, areaM2, reliefM) {
  // NaN reaches here from a peak the DEM does not cover (SPEC §10.4's abstention: ocean,
  // above the archive's northern limit) and falls through to -Infinity with everything
  // else unmeasurable. `NaN > 0` is false, which is the whole guard.
  if (kind === 'peak') return reliefM > 0 ? 2 * Math.log2(reliefM / PEAK_RELIEF_REF_M) : -Infinity;
  const ref = LANDMARK_SIG_REF_M2[kind];
  if (ref == null) return null;
  return areaM2 > 0 ? Math.log2(areaM2 / ref) : -Infinity;
}

// The anchor identity, and it is the COORDINATE, not the name (docs/LANDMARK-SPAWNS.md
// §"Identity is the coordinate"). Integer micro-degrees, because `Math.round(lat * 1e6)`
// and plpgsql's `round(lat * 1e6)` are the same integer with nothing in between, whereas a
// name hash diverges between JS UTF-16 code units and Postgres code points above U+FFFF —
// it would ship green and fire in whichever country first maps a landmark with an
// astral-plane character in its name.
//
// Built from the ROUNDED lat/lng the tile itself carries, so the client can recompute the
// key of an entry it read and get the same string. It is emitted by the bake all the same;
// the ingester must never recompute it.
const anchorKey = (kind, lat6, lng6) =>
  `${kind}@${Math.round(lat6 * 1e6)},${Math.round(lng6 * 1e6)}`;

// OSM `ele` -> integer metres, peaks only. Values carry units and separators in the wild
// ("3581", "3581 m", "1,234"), so parse the leading float and refuse anything outside the
// range a terrestrial summit can occupy — a bad `ele` in a calibration set is worse than
// a missing one, and this set exists to calibrate the future mountain classifier.
function parseEle(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const e = Number.parseFloat(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(e) || e < -500 || e > 9000) return undefined;
  return Math.round(e);
}

const round6 = (x) => Number(x.toFixed(6));
const mPerDegLng = (lat) => M_PER_DEG * Math.cos(lat * Math.PI / 180);

// Douglas-Peucker on an open ring, tolerance in meters (planar approximation is fine
// at these sizes). First/last points anchored; degenerate anchors fall back to
// point-distance so closed shapes still simplify.
// The tolerance is a PARAMETER with §10.1's value as its default, so the v5 call site is
// character-for-character what it was and only the coarse layer (§10.10) passes anything
// else. Re-simplifying an already-simplified ring is not the same as simplifying the
// original at the coarser tolerance — the deviations compose — so a coarse ring is within
// SIMPLIFY_TOL_M + COARSE_SIMPLIFY_TOL_M of the OSM geometry, not within the latter alone.
// At 60 m against a layer drawn at 12.8 m per unit that is under five units, and paying a
// second full pass over the raw rings to save it would double the tiler's landcover cost.
function simplifyRing(ring, cosLat, tolM = SIMPLIFY_TOL_M) {
  const pts = ring;
  const n = pts.length;
  if (n <= 4) return pts.slice();
  const sx = M_PER_DEG * cosLat;
  const sy = M_PER_DEG;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tolM * tolM;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a][0] * sx, ay = pts[a][1] * sy;
    const dx = pts[b][0] * sx - ax, dy = pts[b][1] * sy - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * sx - ax, py = pts[i][1] * sy - ay;
      let d;
      if (len2 === 0) d = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx, ey = py - t * dy;
        d = ex * ex + ey * ey;
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// Shoelace area in m² of an open ring (implicit closure).
function ringAreaM2(ring, cosLat) {
  const sx = M_PER_DEG * cosLat;
  const sy = M_PER_DEG;
  let sum = 0;
  for (let a = 0; a < ring.length; a++) {
    const p = ring[a], q = ring[(a + 1) % ring.length];
    sum += p[0] * sx * q[1] * sy - q[0] * sx * p[1] * sy;
  }
  return Math.abs(sum / 2);
}

function ringCentroid(ring) {
  // Planar centroid in degrees — landmarks only need a plausible label point.
  let a2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const cross = p[0] * q[1] - q[0] * p[1];
    a2 += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  if (Math.abs(a2) < 1e-12) return { lat: ring[0][1], lng: ring[0][0] }; // degenerate
  return { lng: cx / (3 * a2), lat: cy / (3 * a2) };
}

// Tiles a landmark is listed in: every cell whose CENTER is within `radiusM` of the
// label point, UNION every cell whose center falls INSIDE the landmark's own footprint.
//
// The union is the fix for the field this bake exists to add. Centroid proximity alone is
// right for a town park (smaller than the 1200 m box) and useless for a national park —
// measured on the live v5 tiles: the cell over Royal Palm, 6 km inside Everglades National
// Park, carries ZERO landmarks today, even though the park IS already in the osmium filter
// (`a/leisure=nature_reserve` matches it). The park was never missing from the bake; it was
// only ever listed within 1200 m of its centroid, which is open sawgrass nobody walks.
// Keeping the proximity term as well means nothing that ships today stops shipping — a
// small polygon containing no tile center at all still gets its neighbourhood.
function addLandmark(name, lat, lng, kind, area, ele, radiusM, coverRings) {
  const key = anchorKey(kind, round6(lat), round6(lng));
  // Anchor candidacy is decided HERE, once per feature, on the slice's own ownership rule
  // (SPEC §4) applied to the landmark's POINT — never to the tiles it happens to be listed
  // in, which is a much larger and slice-overlapping set. Ownership is applied BEFORE the
  // ranking, not after, so the anchor set is a function of this slice's extract alone and
  // reproduces from it; ranking first and filtering after would make the result depend on
  // how much of the neighbouring state a Geofabrik extract's buffer happened to include.
  // A peak's magnitude is its LOCAL RELIEF, and the DEM has not been read yet — that pass
  // runs once, after the whole extract, because it is bounded by the slice's own candidate
  // set rather than by the stream. Peaks enter at -Infinity and are re-scored there; two
  // peaks rounding to the same micro-degree point are the same point, so the first wins.
  const sig = kind === 'peak' ? -Infinity : landmarkSig(kind, area);
  if (sig !== null && ownsLatLng(lat, lng)) {
    const prev = anchorCands.get(key);
    if (!prev || sig > prev.sig)
      anchorCands.set(key, { key, kind, lat: round6(lat), lng: round6(lng), ele, sig, name });
  }
  const keys = new Set(cellsNear(lat, lng, radiusM ?? BOX_HALF_M));
  if (coverRings) for (const k of cellsInsideRings(coverRings)) keys.add(k);
  for (const k of keys) {
    let list = lmByCell.get(k);
    if (!list) lmByCell.set(k, (list = []));
    list.push({ name, lat, lng, kind, area, ele, key });
  }
}

// Cell keys whose CENTER falls inside the (even-odd) ring set.
//
// SCANLINE, not a point-in-polygon per candidate cell, and the difference is not
// cosmetic: the polygons this runs on are state-scale (Utah is ~65% federal land, most of
// it one boundary=protected_area or another), so the naive form is O(rows x cols x
// ringPoints) — for one 5,000-point polygon over a 300 x 300 tile bbox that is 4.5x10^9
// operations, minutes per feature. Crossings are computed ONCE per row and filled as
// spans instead: O(rows x ringPoints + cells). Same even-odd rule as `rasterizeCover`
// above, which solves the identical problem one grid finer, so holes work.
//
// Bounded by LM_COVER_MAX_CELLS: above that the polygon is not a landmark anyone walks
// through, it is a mapping artefact, and the caller falls back to proximity alone.
function cellsInsideRings(rings) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const r of rings)
    for (const [x, y] of r) {
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
      if (x < minLng) minLng = x;
      if (x > maxLng) maxLng = x;
    }
  if (!Number.isFinite(minLat)) return [];
  const iMin = Math.floor(minLat / TILE_DEG), iMax = Math.floor(maxLat / TILE_DEG);
  const jMin = Math.floor(minLng / TILE_DEG), jMax = Math.floor(maxLng / TILE_DEG);
  if ((iMax - iMin + 1) * (jMax - jMin + 1) > LM_COVER_MAX_CELLS) return [];
  const out = [];
  for (let i = iMin; i <= iMax; i++) {
    const y = (i + 0.5) * TILE_DEG;
    if (y < minLat || y > maxLat) continue;
    const xs = [];
    for (const r of rings)
      for (let a = 0; a < r.length; a++) {
        const [x1, y1] = r[a];
        const [x2, y2] = r[(a + 1) % r.length];
        if (y1 > y !== y2 > y) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
      }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = xs[k], xb = xs[k + 1];
      for (let j = Math.floor(xa / TILE_DEG); j <= Math.floor(xb / TILE_DEG); j++) {
        const x = (j + 0.5) * TILE_DEG;
        if (x >= xa && x < xb) out.push(i + ':' + j);
      }
    }
  }
  return out;
}

// Bin a landcover polygon to every tile whose ±1200 m clip box intersects its bbox.
function binLandcover(idx) {
  const outer = lcPolys[idx].rings[0];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [x, y] of outer) {
    if (y < minLat) minLat = y;
    if (y > maxLat) maxLat = y;
    if (x < minLng) minLng = x;
    if (x > maxLng) maxLng = x;
  }
  const latHalf = BOX_HALF_M / M_PER_DEG;
  const iMin = Math.floor((minLat - latHalf) / TILE_DEG) - 1;
  const iMax = Math.floor((maxLat + latHalf) / TILE_DEG) + 1;
  for (let i = iMin; i <= iMax; i++) {
    const cLat = (i + 0.5) * TILE_DEG;
    if (cLat + latHalf < minLat || cLat - latHalf > maxLat) continue;
    const lngHalf = BOX_HALF_M / mPerDegLng(cLat);
    const jMin = Math.floor((minLng - lngHalf) / TILE_DEG) - 1;
    const jMax = Math.floor((maxLng + lngHalf) / TILE_DEG) + 1;
    for (let j = jMin; j <= jMax; j++) {
      const cLng = (j + 0.5) * TILE_DEG;
      if (cLng + lngHalf < minLng || cLng - lngHalf > maxLng) continue;
      const k = i + ':' + j;
      let list = lcByCell.get(k);
      if (!list) lcByCell.set(k, (list = []));
      list.push(idx);
    }
  }
}

function habCell(cx, cy) {
  const k = cx + ':' + cy;
  // wmask / gmask / amask: the 2x2 sample bits covered by `wood`, by `green` and by
  // `water` landcover respectively. Revision 1 kept one shared `mask`, which is the whole
  // reason a deep forest and a municipal park collapsed into one class: the tiler HAS the
  // distinction at the landcover layer (LC_CLASSES separates all four kinds) and threw it
  // away here. `amask` is revision 4's addition and it was the same oversight — the
  // `water` polygons have shipped in `landcover` since the first v5 bake and the habitat
  // layer simply never looked at them.
  let st = hab.get(k);
  if (!st) hab.set(k, (st = { foot: 0, res: 0, road: 0, wmask: 0, gmask: 0, amask: 0 }));
  return st;
}

// Credit a walkable way's length to the spawn cells it crosses: each segment is cut
// into ceil(len / HAB_STEP_M) equal steps and each step's length goes to the cell
// containing the step midpoint (normative — SPEC.md §10.4).
function habAddWay(points, hw) {
  const grp =
    hw === 'residential' || hw === 'living_street' ? 'res' : FOOT.has(hw) ? 'foot' : 'road';
  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s], b = points[s + 1];
    const len = haversineM(a.lat, a.lng, b.lat, b.lng);
    if (!len) continue;
    const n = Math.max(1, Math.ceil(len / HAB_STEP_M));
    const step = len / n;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      habCell(Math.floor(lng / CELL_DEG), Math.floor(lat / CELL_DEG))[grp] += step;
    }
  }
}

// Mark each spawn cell's 2x2 samples (at 0.25/0.75 of the cell in each axis) covered by
// this polygon — scanline over all rings, even-odd (holes work). `field` selects which
// mask: 'wmask' for a `wood` polygon, 'gmask' for a `green` one, 'amask' for `water`. A
// sample inside both a wood and a park sets both bits, which is what lets greenKind() see
// the overlap — and a sample inside both a lake and a park sets both, which is what lets a
// wooded lakeshore be BOTH classes now that the labels no longer compete.
function rasterizeCover(rings, field) {
  let minLat = Infinity, maxLat = -Infinity;
  for (const r of rings)
    for (const p of r) {
      if (p[1] < minLat) minLat = p[1];
      if (p[1] > maxLat) maxLat = p[1];
    }
  const cyMin = Math.floor(minLat / CELL_DEG);
  const cyMax = Math.floor(maxLat / CELL_DEG);
  for (let cy = cyMin; cy <= cyMax; cy++) {
    for (const subY of [0.25, 0.75]) {
      const y = (cy + subY) * CELL_DEG;
      if (y < minLat || y > maxLat) continue;
      const xs = [];
      for (const r of rings) {
        for (let a = 0; a < r.length; a++) {
          const [x1, y1] = r[a];
          const [x2, y2] = r[(a + 1) % r.length];
          if (y1 > y !== y2 > y) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = xs[k], xb = xs[k + 1];
        for (let cx = Math.floor(xa / CELL_DEG); cx <= Math.floor(xb / CELL_DEG); cx++) {
          for (const subX of [0.25, 0.75]) {
            const x = (cx + subX) * CELL_DEG;
            if (x >= xa && x < xb)
              habCell(cx, cy)[field] |= 1 << ((subY === 0.75 ? 2 : 0) + (subX === 0.75 ? 1 : 0));
          }
        }
      }
    }
  }
}

// Landcover/landmark area feature: simplify + area-threshold each polygon, then bin.
// `pr` is carried through only so the landmark KIND can be settled once `totalArea` is
// known — `national_park` is the one kind whose tags are not enough on their own.
function addArea(g, cls, kind, name, pr) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let totalArea = 0;
  let best = null; // largest outer ring, for the landmark centroid
  let bestArea = -1;
  const coverRings = []; // every kept ring across every part — even-odd, so holes work
  for (const rings of polys) {
    let outer = rings[0];
    if (!outer || outer.length < 4) continue;
    const cosLat = Math.cos(outer[0][1] * Math.PI / 180);
    outer = simplifyRing(outer, cosLat);
    if (outer.length && outer[0][0] === outer[outer.length - 1][0] && outer[0][1] === outer[outer.length - 1][1])
      outer = outer.slice(0, -1); // store rings open; closure is implicit
    if (outer.length < 3) continue;
    const area = ringAreaM2(outer, cosLat);
    if (area < LC_MIN_AREA_M2) continue;
    totalArea += area;
    if (area > bestArea) { bestArea = area; best = outer; }
    const kept = [outer];
    for (let r = 1; r < rings.length; r++) {
      let hole = simplifyRing(rings[r], cosLat);
      if (hole.length && hole[0][0] === hole[hole.length - 1][0] && hole[0][1] === hole[hole.length - 1][1])
        hole = hole.slice(0, -1);
      if (hole.length >= 3 && ringAreaM2(hole, cosLat) >= LC_MIN_AREA_M2) kept.push(hole);
    }
    if (kind && name) for (const r of kept) coverRings.push(r);
    if (cls) {
      const idx = lcPolys.push({ cls, rings: kept }) - 1;
      binLandcover(idx);
      if (cls === 'wood') rasterizeCover(kept, 'wmask');
      else if (cls === 'green') rasterizeCover(kept, 'gmask');
      else if (cls === 'water') rasterizeCover(kept, 'amask');
    }
  }
  if (kind && name && best) {
    const c = ringCentroid(best);
    // Re-ask now that the footprint is known. The candidacy call above used area 0 and can
    // only ever have under-claimed (area promotes, never demotes), so this cannot turn a
    // landmark into a non-landmark — it can only settle national_park.
    const settled = landmarkKind(pr, totalArea) ?? kind;
    addLandmark(name, c.lat, c.lng, settled, totalArea, undefined, BOX_HALF_M, coverRings);
  }
}

// ---- read features ----
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let auto = 0;
for await (let line of rl) {
  line = line.replace(/^\x1e/, '').trim(); // strip RFC 8142 record separator if present
  if (!line) continue;
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    continue;
  }
  const g = f.geometry;
  const pr = f.properties || {};
  if (!g) continue;
  const id = String(f.id ?? pr['@id'] ?? 'x' + auto++);
  if (g.type === 'LineString') {
    const hw = pr.highway;
    if (WALK.has(hw)) {
      const points = g.coordinates.map((c) => ({ lat: c[1], lng: c[0] }));
      // `lit` and `access` need NO osmium filter line: tags-filter SELECTS objects and
      // keeps every tag on the ones it selects, so these already arrive on every way the
      // highway filter matched. They cost a filter change of exactly zero.
      addWay(id, points, FOOT.has(hw), pr.name || null, wayLit(pr), wayAccess(pr));
      habAddWay(points, hw);
    }
    if (pr.footway === 'crossing' && g.coordinates.length) {
      const mid = g.coordinates[Math.floor(g.coordinates.length / 2)];
      addCrossing(mid[1], mid[0]);
    }
  } else if (g.type === 'Point') {
    if (pr.highway === 'crossing') addCrossing(g.coordinates[1], g.coordinates[0]);
    // POINT landmarks were already the path for `n/amenity=library`, so settlements and
    // peaks — which OSM maps as nodes, not areas — need no new machinery, only a radius.
    // Area 0 is what made them fragile: see LANDMARK_TIER.
    const kind = landmarkKind(pr, 0);
    if (kind && pr.name)
      addLandmark(
        pr.name,
        g.coordinates[1],
        g.coordinates[0],
        kind,
        0,
        kind === 'peak' ? parseEle(pr.ele) : undefined,
        PLACE_RADIUS_M[kind] ?? BOX_HALF_M,
        null,
      );
  } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
    const cls = landcoverClass(pr);
    const kind = landmarkKind(pr, 0);
    if (cls || (kind && pr.name)) addArea(g, cls, kind, pr.name || null, pr);
  }
}

// ---- write owned, non-empty cells ----
mkdirSync(join(OUT, 'v4'), { recursive: true });
const hashes = {};
let written = 0;
for (const [key, c] of cells) {
  const [i, j] = key.split(':').map(Number);
  if (!owns(i, j)) continue;
  if (c.ways.size === 0 && c.crossings.size === 0) continue;
  const ways = [];
  const names = [];
  for (const w of c.ways.values()) {
    ways.push({ points: w.points, foot: w.foot });
    names.push(w.name);
  }
  const payload = { v: 4, ways, names, crossings: [...c.crossings.values()] };
  const json = JSON.stringify(payload);
  hashes[key] = createHash('sha256').update(json).digest('hex');
  const dir = join(OUT, 'v4', String(i));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(j) + '.json.gz'), gzipSync(Buffer.from(json)));
  written++;
}
writeFileSync(join(OUT, 'hashes.json'), JSON.stringify(hashes));
console.error(`[tile] ${written} tiles written to ${OUT}/v4`);

// ================================ v5 write =================================

// Sutherland-Hodgman clip of an open ring against a lat/lng rectangle.
function clipRingRect(ring, rect) {
  let pts = ring;
  for (let side = 0; side < 4; side++) {
    const out = [];
    for (let a = 0; a < pts.length; a++) {
      const p = pts[a];
      const q = pts[(a + 1) % pts.length];
      const pin = insideSide(p, side, rect);
      const qin = insideSide(q, side, rect);
      if (pin) out.push(p);
      if (pin !== qin) out.push(intersectSide(p, q, side, rect));
    }
    if (out.length < 3) return null;
    pts = out;
  }
  return pts;
}
function insideSide(p, side, r) {
  if (side === 0) return p[0] >= r.minLng;
  if (side === 1) return p[0] <= r.maxLng;
  if (side === 2) return p[1] >= r.minLat;
  return p[1] <= r.maxLat;
}
function intersectSide(p, q, side, r) {
  if (side < 2) {
    const x = side === 0 ? r.minLng : r.maxLng;
    return [x, p[1] + ((q[1] - p[1]) * (x - p[0])) / (q[0] - p[0])];
  }
  const y = side === 2 ? r.minLat : r.maxLat;
  return [p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]), y];
}

const toLatLng = (ring) => ring.map(([lng, lat]) => ({ lat: round6(lat), lng: round6(lng) }));

// Landcover for one tile: clip each binned polygon to the tile's ±1200 m box,
// drop slivers, order by clipped area desc (big washes paint first).
function buildLandcover(i, j, idxs) {
  if (!idxs) return [];
  const c = cellCenter(i, j);
  const rect = {
    minLat: c.lat - BOX_HALF_M / M_PER_DEG,
    maxLat: c.lat + BOX_HALF_M / M_PER_DEG,
    minLng: c.lng - BOX_HALF_M / mPerDegLng(c.lat),
    maxLng: c.lng + BOX_HALF_M / mPerDegLng(c.lat),
  };
  const cosLat = Math.cos(c.lat * Math.PI / 180);
  const out = [];
  for (const idx of idxs) {
    const poly = lcPolys[idx];
    const outer = clipRingRect(poly.rings[0], rect);
    if (!outer) continue;
    const area = ringAreaM2(outer, cosLat);
    if (area < LC_MIN_CLIPPED_M2) continue;
    const rings = [outer];
    for (let r = 1; r < poly.rings.length; r++) {
      const hole = clipRingRect(poly.rings[r], rect);
      if (hole) rings.push(hole);
    }
    out.push({ kind: poly.cls, area, rings });
  }
  out.sort((a, b) => b.area - a.area);
  return out.map((p) => ({ kind: p.kind, rings: p.rings.map(toLatLng) }));
}

// Top LANDMARKS_PER_TILE, deduped on kind+name, ordered TIER first (SPEC §10.2).
//
// Ordering by footprint alone — what this did before — is exactly backwards for the kinds
// this bake adds. A `place=city` node has no footprint at all, so it sorted LAST and was
// truncated away; a national park has an enormous one, so it would take slot 1 in every
// tile it covers. Measured on the live bake: downtown Wichita's three slots hold three
// city parks, so "Wichita" would never have shipped from the cell it names.
//
// Within a tier: area descending (unchanged for the pre-existing kinds), then distance to
// the tile centre ascending — the meaningful key for the zero-area point kinds, and a
// deterministic tiebreak for the rest in place of the old name-only one.
//
// ANCHORS SORT FIRST, ahead of tier, and carry `anchor: true`. The tile is where a client
// learns an anchor exists, so an anchor truncated out of its own tile is an anchor no
// client can ever spawn at — the exact "a downtown tile whose six slots are full of parks
// silently drops a peak" failure docs/LANDMARK-SPAWNS.md §3 records. It costs almost
// nothing: there is at most one anchor per 0.5° cell, so a 1.2 km tile carrying two is one
// sitting on a cell corner, and five slots remain either way.
//
// The flag is a HINT and never the authority — `v5/landmarks/<slice>.jsonl` is (SPEC
// §10.8). A tile near a slice border can list a landmark this slice does not own and
// therefore never ranked, so the flag will be absent on an entry the neighbouring slice
// does anchor. That degrades to a GAP (the client derives no spawn) and never to a
// fabrication, which is the direction every other truncation in this format fails in.
function buildLandmarks(i, j, list) {
  if (!list) return [];
  const byId = new Map();
  for (const lm of list) {
    const id = lm.kind + ' ' + lm.name;
    const prev = byId.get(id);
    if (!prev || lm.area > prev.area) byId.set(id, lm);
  }
  const c = cellCenter(i, j);
  const ranked = [...byId.values()]
    .map((lm) => ({ lm, dist: haversineM(c.lat, c.lng, lm.lat, lm.lng), anchor: anchorKeys.has(lm.key) }))
    .sort(
      (a, b) =>
        (b.anchor ? 1 : 0) - (a.anchor ? 1 : 0) ||
        LANDMARK_TIER[a.lm.kind] - LANDMARK_TIER[b.lm.kind] ||
        b.lm.area - a.lm.area ||
        a.dist - b.dist ||
        (a.lm.name < b.lm.name ? -1 : a.lm.name > b.lm.name ? 1 : 0),
    );
  const out = [];
  let settlements = 0;
  for (const { lm, anchor } of ranked) {
    if (out.length >= LANDMARKS_PER_TILE) break;
    if (isSettlement(lm.kind) && ++settlements > SETTLEMENTS_PER_TILE) continue;
    const e = { name: lm.name, lat: round6(lm.lat), lng: round6(lm.lng), kind: lm.kind };
    if (lm.ele !== undefined) e.ele = lm.ele;
    if (anchor) e.anchor = true;
    out.push(e);
  }
  return out;
}

// One spawn cell's FEATURE RECORD — the measurements, quantised exactly as SPEC §10.4
// specifies, with the rules applied to the QUANTISED values and never to these floats.
// That is what makes the tiler, the client and the plpgsql port classify identically by
// construction rather than by tolerance.
//
// Relief is read for EVERY cell, including cells with no walkable way. It is a fact about
// the ground rather than about the ways, it is the one field a phone cannot recompute, and
// a future rule that wants it on a cell today's rules ignore should not need a re-bake to
// get it. `null` (encoded as the 511 sentinel) means the DEM publishes nothing here, which
// is not the same claim as 0 m.
function featuresAt(cx, cy) {
  const st = hab.get(cx + ':' + cy);
  const relief = reliefGrid === null ? null : reliefGrid.at(cx, cy);
  return {
    res: st ? st.res : 0,
    foot: st ? st.foot : 0,
    road: st ? st.road : 0,
    woodMask: st ? st.wmask : 0,
    greenMask: st ? st.gmask : 0,
    waterMask: st ? st.amask : 0,
    reliefM: relief === null || !Number.isFinite(relief) ? null : relief,
  };
}

/** This cell's class MASK — multi-label, from the record as it will be READ, not as it was
 *  measured. Going through encode/decode is deliberate: the sidecar, the atlas and the
 *  client must all be classifying the same eight characters. */
function habitatMask(cx, cy) {
  return classifyFeatures(decodeFeatures(encodeFeatures(featuresAt(cx, cy))));
}

// Per-tile habitat block: every spawn cell intersecting the tile's 0.01° extent,
// row-major, south→north rows (cy ascending), west→east within a row (cx ascending) —
// unchanged from revision 3. What changed is the payload per slot: `cells`, one class
// character, is GONE, and `feat` carries FEAT_CHARS base64url characters of measurement.
//
// `cells` is removed rather than kept alongside, and that is the one non-additive change
// in this format's history. Keeping both would leave two sources of truth for the same
// cell's class — the bake's answer and the client's — and the entire point of revision 4
// is that the client stops trusting a character somebody else's thresholds chose. A
// revision-3 client finds no `cells`, decodes nothing, and every cell falls back to rural:
// the same quiet degradation `w`/`s`/`m` already rely on, in the direction that
// under-claims.
function buildHabitat(i, j) {
  const cy0 = Math.floor((i * CELL_RATIO_N) / CELL_RATIO_D);
  const cy1 = Math.ceil(((i + 1) * CELL_RATIO_N) / CELL_RATIO_D) - 1;
  const cx0 = Math.floor((j * CELL_RATIO_N) / CELL_RATIO_D);
  const cx1 = Math.ceil(((j + 1) * CELL_RATIO_N) / CELL_RATIO_D) - 1;
  let s = '';
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cx = cx0; cx <= cx1; cx++) s += encodeFeatures(featuresAt(cx, cy));
  return { cellDeg: CELL_DEG, cx0, cy0, cols: cx1 - cx0 + 1, rows: cy1 - cy0 + 1, feat: s };
}

// Area of the slice's ownership polygon, in km². Same scanline and the same even-odd rule
// as `cellsInsideRings` / `pointInRings`, so "inside" here means exactly what it means to
// `owns()`. A spherical-shoelace formula would instead have to agree with the winding of
// every Geofabrik .poly, and one `!hole` ring taken the wrong way round would be a silent
// factor of two in the anchor count. This integrates what the ownership test actually says.
function sliceAreaKm2() {
  if (bbox)
    return (
      ((bbox.maxLng - bbox.minLng) *
        mPerDegLng((bbox.minLat + bbox.maxLat) / 2) *
        (bbox.maxLat - bbox.minLat) *
        M_PER_DEG) /
      1e6
    );
  if (!ownRings) return null; // unconstrained local test — no count cap (see selectAnchors)
  let minLat = Infinity, maxLat = -Infinity;
  for (const r of ownRings)
    for (const [, y] of r) {
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
    }
  if (!Number.isFinite(minLat)) return 0;
  let m2 = 0;
  for (let i = Math.floor(minLat / SLICE_AREA_STEP_DEG); i <= Math.floor(maxLat / SLICE_AREA_STEP_DEG); i++) {
    const y = (i + 0.5) * SLICE_AREA_STEP_DEG;
    if (y < minLat || y > maxLat) continue;
    const xs = [];
    for (const r of ownRings)
      for (let a = 0; a < r.length; a++) {
        const [x1, y1] = r[a];
        const [x2, y2] = r[(a + 1) % r.length];
        if (y1 > y !== y2 > y) xs.push(x1 + ((x2 - x1) * (y - y1)) / (y2 - y1));
      }
    xs.sort((p, q) => p - q);
    let dLng = 0;
    for (let k = 0; k + 1 < xs.length; k += 2) dLng += xs[k + 1] - xs[k];
    m2 += dLng * mPerDegLng(y) * SLICE_AREA_STEP_DEG * M_PER_DEG;
  }
  return m2 / 1e6;
}

// The slice's anchor set — the few named things significant enough to hold a creature.
// Three terms, each doing a job the other two cannot (SPEC §10.8):
//
//   1. RANK by significance, descending, ties broken by KEY ascending so a re-bake of
//      unchanged data produces the identical set.
//   2. SPREAD — at most one per ANCHOR_CELL_DEG cell. This is what turns "the 12 highest
//      points in Vermont", four of which are named bumps on Mount Mansfield, into "the 12
//      best places in Vermont".
//   3. COUNT — round(ANCHOR_DENSITY_PER_KM2 × slice area), at least 1. Area-normalised, so
//      Vermont gets 12 and California would get ~200; a flat per-slice number gives them
//      the same and is the thing this cap exists not to be.
//
// The floor of 1 and ANCHOR_SIG_MIN pull in opposite directions ON PURPOSE: the floor says
// every slice gets its best thing, the minimum says only if that thing is significant at
// all. A slice with nothing above its kinds' references emits an empty sidecar, and that is
// an answer rather than a failure.
function selectAnchors() {
  const areaKm2 = sliceAreaKm2();
  const limit =
    areaKm2 === null ? Infinity : Math.max(1, Math.round(ANCHOR_DENSITY_PER_KM2 * areaKm2));
  const ranked = [...anchorCands.values()]
    .filter((a) => a.sig >= ANCHOR_SIG_MIN)
    .sort((a, b) => b.sig - a.sig || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const takenCells = new Set();
  const out = [];
  for (const a of ranked) {
    if (out.length >= limit) break;
    const ck = Math.floor(a.lat / ANCHOR_CELL_DEG) + ':' + Math.floor(a.lng / ANCHOR_CELL_DEG);
    if (takenCells.has(ck)) continue;
    takenCells.add(ck);
    out.push(a);
  }
  // Sorted by KEY for the sidecar — by identity, not by score, so the file diffs
  // line-for-line against the previous bake instead of reshuffling when one score moves.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { anchors: out, areaKm2, limit, eligible: ranked.length };
}

// ---- the elevation pass (SPEC §10.4, §10.8, §10.9) -----------------------------------
//
// One pass, after the whole extract and before anything is ranked or written, because both
// consumers need the DEM and both are bounded by sets this slice already knows: the spawn
// cells that have data, and the named peaks it owns. Doing it inside the read loop would
// mean an await per feature against a remote archive.
//
// DEM_DISABLE=1 exists for a network-free run and prints a banner rather than degrading
// quietly, because "no mountain anywhere" and "no mountains here" are the same output and
// only one of them is true.
const DEM_OFF = process.env.DEM_DISABLE === '1';
let reliefGrid = null; // read by classifyHabitat; null means "no elevation, abstain"
if (DEM_OFF) {
  console.error('[tile] !! DEM_DISABLE=1 — no elevation source for this bake.');
  console.error('[tile] !! No cell can classify `mountain`, and no named peak can rank as');
  console.error('[tile] !! an anchor. Both are ABSENCES, and neither is visible in the output.');
} else if (hab.size === 0) {
  console.error('[tile] no spawn cell carries data — elevation pass skipped');
} else {
  const dem = new Dem({});
  let cxLo = Infinity, cxHi = -Infinity, cyLo = Infinity, cyHi = -Infinity;
  for (const k of hab.keys()) {
    const c = k.indexOf(':');
    const cx = Number(k.slice(0, c)), cy = Number(k.slice(c + 1));
    if (cx < cxLo) cxLo = cx;
    if (cx > cxHi) cxHi = cx;
    if (cy < cyLo) cyLo = cy;
    if (cy > cyHi) cyHi = cy;
  }
  const t0 = Date.now();
  let lastPct = -1;
  reliefGrid = await buildReliefGrid(dem, {
    cxLo, cxHi, cyLo, cyHi,
    cellDeg: CELL_DEG,
    mPerDeg: M_PER_DEG,
    radiusM: MOUNTAIN_RELIEF_R_M,
    onBand: (done, total) => {
      const pct = Math.floor((10 * done) / total) * 10;
      if (pct > lastPct) { lastPct = pct; console.error(`[tile] dem: sampled ${pct}%`); }
    },
  });
  console.error(
    `[tile] relief: ${reliefGrid.cols}x${reliefGrid.rows} cells, disc r=${MOUNTAIN_RELIEF_R_M} m ` +
      `(${reliefGrid.ry} rows x ${reliefGrid.rx[0]} cols at the widest), ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  // Peaks, sorted south-to-north so consecutive lookups share COG blocks — the same
  // locality the band loop above relies on, applied to a scattered set.
  const peaks = [...anchorCands.values()]
    .filter((a) => a.kind === 'peak')
    .sort((a, b) => a.lat - b.lat || a.lng - b.lng);
  for (const a of peaks) {
    a.relief = await dem.dropAtPoint(a.lat, a.lng, PEAK_RELIEF_R_M, M_PER_DEG);
    a.sig = landmarkSig('peak', 0, a.relief);
  }
  const scored = peaks.filter((a) => Number.isFinite(a.sig));
  console.error(
    `[tile] peaks: ${scored.length} of ${peaks.length} owned summits scored from local ` +
      `drop (r=${PEAK_RELIEF_R_M} m, ref ${PEAK_RELIEF_REF_M} m); ` +
      `${peaks.length - scored.length} abstained (no DEM coverage)`,
  );
  console.error(`[tile] dem: ${dem.summary()}`);
}

const anchorSel = selectAnchors();
const anchorKeys = new Set(anchorSel.anchors.map((a) => a.key));

mkdirSync(join(OUT, 'v5'), { recursive: true });
const v5Keys = new Set([...cells.keys(), ...lcByCell.keys(), ...lmByCell.keys()]);
const hashes5 = {};
let written5 = 0;
for (const key of v5Keys) {
  const [i, j] = key.split(':').map(Number);
  if (!owns(i, j)) continue;
  const c = cells.get(key);
  const ways = [];
  const names = [];
  if (c)
    for (const w of c.ways.values()) {
      // v5 ONLY: the per-way attributes ride ON the way object rather than in a parallel
      // array (SPEC §10.6). The client's seam-dedupe merge carries the way object by
      // reference and drops anything not attached to it, so a parallel array would force a
      // second, divergent dedupe app-side — which is precisely how a seam-duplicated way
      // quietly doubles a street's weight in the walk graph. Written only when tagged, so
      // an untagged way costs nothing and ABSENT keeps meaning UNKNOWN.
      const way = { points: w.points, foot: w.foot };
      if (w.lit !== undefined) way.lit = w.lit;
      if (w.access !== undefined) way.access = w.access;
      ways.push(way);
      names.push(w.name);
    }
  const crossings = c ? [...c.crossings.values()] : [];
  const landcover = buildLandcover(i, j, lcByCell.get(key));
  const landmarks = buildLandmarks(i, j, lmByCell.get(key));
  if (!ways.length && !crossings.length && !landcover.length && !landmarks.length) continue;
  const payload = { v: 5, ways, names, crossings, landcover, landmarks, habitat: buildHabitat(i, j) };
  const json = JSON.stringify(payload);
  hashes5[key] = createHash('sha256').update(json).digest('hex');
  const dir = join(OUT, 'v5', String(i));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(j) + '.json.gz'), gzipSync(Buffer.from(json)));
  written5++;
}
writeFileSync(join(OUT, 'hashes-v5.json'), JSON.stringify(hashes5));

// ================================ v5c write ================================
// The coarse landcover layer — SHAPE ONLY, for the 600 m → 10 km band the v5 tiles cannot
// afford and the habitat atlas is too blunt for. See the constants block near the top for
// why this is per-TILE rather than per-block and why it clips to the cell rect. Everything
// here is derived from `lcPolys`, the SAME polygons v5's washes come from, so the two
// layers can never disagree about where a lake is — only about how carefully it is drawn.

// Rings go out as FLAT [lat, lng, lat, lng, …] number arrays rather than §10.1's
// {lat,lng} objects. v5 uses objects because its ways inherited them from v4 and the client
// parses them by reference on a hot path; this artifact has no such lineage, and the flat
// form is ~2× smaller before gzip for a payload that is almost entirely coordinates. The
// client turns them back into {lat,lng} once, at parse.
const roundC = (x) => Number(x.toFixed(COARSE_ROUND));
const toFlat = (ring) => {
  const a = [];
  for (const [lng, lat] of ring) a.push(roundC(lat), roundC(lng));
  return a;
};

// The padded cell rectangle a coarse polygon is clipped to. Exactly 0.01° plus the hairline
// pad — NOT v5's ±1200 m box (see the constants block).
function coarseRect(i, j) {
  const cLat = (i + 0.5) * TILE_DEG;
  const latPad = COARSE_CLIP_PAD_M / M_PER_DEG;
  const lngPad = COARSE_CLIP_PAD_M / mPerDegLng(cLat);
  return {
    minLat: i * TILE_DEG - latPad,
    maxLat: (i + 1) * TILE_DEG + latPad,
    minLng: j * TILE_DEG - lngPad,
    maxLng: (j + 1) * TILE_DEG + lngPad,
  };
}

const coarsePolys = []; // { cls, rings } — open rings of [lng, lat], simplified to 50 m
const coarseByCell = new Map(); // 'i:j' -> [idx]

// Bin one coarse polygon to every cell whose padded rect its bbox reaches. By BBOX, so a
// long diagonal river bins into cells it never actually enters — the clip below then
// produces nothing and the cell is simply not written. Same shape as `binLandcover`, one
// grid tighter: the fine binner has to allow for a ±1200 m box that overspills the cell by
// more than two cells in each direction, and this one only for the pad.
function binCoarse(idx) {
  const outer = coarsePolys[idx].rings[0];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [x, y] of outer) {
    if (y < minLat) minLat = y;
    if (y > maxLat) maxLat = y;
    if (x < minLng) minLng = x;
    if (x > maxLng) maxLng = x;
  }
  const latPad = COARSE_CLIP_PAD_M / M_PER_DEG;
  const iMin = Math.floor((minLat - latPad) / TILE_DEG);
  const iMax = Math.floor((maxLat + latPad) / TILE_DEG);
  for (let i = iMin; i <= iMax; i++) {
    const lngPad = COARSE_CLIP_PAD_M / mPerDegLng((i + 0.5) * TILE_DEG);
    const jMin = Math.floor((minLng - lngPad) / TILE_DEG);
    const jMax = Math.floor((maxLng + lngPad) / TILE_DEG);
    for (let j = jMin; j <= jMax; j++) {
      const k = i + ':' + j;
      let list = coarseByCell.get(k);
      if (!list) coarseByCell.set(k, (list = []));
      list.push(idx);
    }
  }
}

// The area gate throws polygons away, so the tiler REPORTS what it threw away — as area,
// not as a count. "186 of 1664 polys survived" reads like a massacre and says nothing; the
// question a person actually has is how much GROUND stopped being drawn, and the two
// numbers are wildly different because the discarded polygons are by construction the
// small ones.
let coarseAreaIn = 0;
let coarseAreaOut = 0;
for (const p of lcPolys) {
  const outer0 = p.rings[0];
  if (!outer0 || outer0.length < 3) continue;
  const cosLat = Math.cos((outer0[0][1] * Math.PI) / 180);
  coarseAreaIn += ringAreaM2(outer0, cosLat);
  const outer = simplifyRing(outer0, cosLat, COARSE_SIMPLIFY_TOL_M);
  if (outer.length < 3) continue;
  // The area gate is applied to the SIMPLIFIED ring, not the original: the drawn shape is
  // what has to be big enough to read, and a 50 m simplification can only shrink a small
  // one further. Holes get the same gate — a clearing too small to draw is not a clearing.
  const outerArea = ringAreaM2(outer, cosLat);
  if (outerArea < COARSE_MIN_AREA_M2) continue;
  coarseAreaOut += outerArea;
  const rings = [outer];
  for (let r = 1; r < p.rings.length; r++) {
    const hole = simplifyRing(p.rings[r], cosLat, COARSE_SIMPLIFY_TOL_M);
    if (hole.length >= 3 && ringAreaM2(hole, cosLat) >= COARSE_MIN_AREA_M2) rings.push(hole);
  }
  binCoarse(coarsePolys.push({ cls: p.cls, rings }) - 1);
}

// Clip one cell's coarse polygons, drop slivers, order by clipped area descending — the
// same ordering contract §10.1 gives, so big washes paint first at either fidelity.
function buildCoarse(i, j, idxs) {
  const rect = coarseRect(i, j);
  const cosLat = Math.cos(((i + 0.5) * TILE_DEG * Math.PI) / 180);
  const out = [];
  for (const idx of idxs) {
    const poly = coarsePolys[idx];
    const outer = clipRingRect(poly.rings[0], rect);
    if (!outer) continue;
    const area = ringAreaM2(outer, cosLat);
    if (area < COARSE_MIN_CLIPPED_M2) continue;
    const rings = [outer];
    for (let r = 1; r < poly.rings.length; r++) {
      const hole = clipRingRect(poly.rings[r], rect);
      if (hole) rings.push(hole);
    }
    out.push({ kind: poly.cls, area, rings });
  }
  out.sort((a, b) => b.area - a.area);
  return out.map((p) => ({ kind: p.kind, rings: p.rings.map(toFlat) }));
}

mkdirSync(join(OUT, 'v5c'), { recursive: true });
const hashesC = {};
let writtenC = 0;
let coarseRings = 0;
for (const [key, idxs] of coarseByCell) {
  const [i, j] = key.split(':').map(Number);
  if (!owns(i, j)) continue; // §4's exactly-one-writer rule, unchanged and on the same grid
  const landcover = buildCoarse(i, j, idxs);
  if (!landcover.length) continue;
  for (const lc of landcover) coarseRings += lc.rings.length;
  // `v: 1` is this ARTIFACT's own version and is deliberately not 5. It is a separate
  // object at a separate prefix with a separate shape; giving it the tile version would
  // promise that a v5 parser can read it, which it cannot and never should try to.
  const payload = { v: 1, landcover };
  const json = JSON.stringify(payload);
  hashesC[key] = createHash('sha256').update(json).digest('hex');
  const dir = join(OUT, 'v5c', String(i));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(j) + '.json.gz'), gzipSync(Buffer.from(json)));
  writtenC++;
}
writeFileSync(join(OUT, 'hashes-v5c.json'), JSON.stringify(hashesC));
console.error(
  `[tile] v5c: ${writtenC} coarse tiles, ${coarsePolys.length} of ${lcPolys.length} polys ` +
    `survived the ${COARSE_MIN_AREA_M2 / 1000}k m² gate — ` +
    `${((100 * coarseAreaOut) / Math.max(1, coarseAreaIn)).toFixed(1)}% of the landcover AREA ` +
    `kept, ${coarseRings} clipped rings -> ${OUT}/v5c`,
);

// ---- Landmark anchor sidecar (SPEC §10.8, docs/LANDMARK-SPAWNS.md Option A) ----------
// One line per DISTINCT anchor, sorted by key. Not one per tile LISTING: proximity and
// containment binning list the same feature from every tile it touches, so the District's
// 341 "parks" were 121 places and its 1,183 listings were 242 anchors. The dedupe happens
// HERE, where the whole slice is in scope, and never client-side, where the set is already
// truncated to six per tile.
//
// `key` is emitted, not left to the ingester to recompute. It is the identity of the row;
// it should be produced once, by the thing that owns the coordinate.
//
// `name` is here and is NOT in the server's table sketch, deliberately. The sidecar is the
// only artifact outside the tiles that holds the key→name mapping, and an operator reading
// `peak@44544...` needs to be able to tell it is Mount Mansfield without re-baking a state.
writeFileSync(
  join(OUT, `landmarks-${SLICE}.jsonl`),
  anchorSel.anchors
    .map((a) =>
      JSON.stringify(
        a.ele === undefined
          ? { key: a.key, kind: a.kind, lat: a.lat, lng: a.lng, name: a.name }
          : { key: a.key, kind: a.kind, lat: a.lat, lng: a.lng, ele: a.ele, name: a.name },
      ),
    )
    .join('\n') + (anchorSel.anchors.length ? '\n' : ''),
);

// ---- Slice-owned spawn cells -> the habitat sidecar AND the habitat atlas ------------
// One pass, one ownership rule. §4's exactly-one-writer rule applies here at spawn-cell
// granularity: a cell counts for this slice iff its CENTRE is inside the slice poly. Both
// artifacts must use it, and neither may be derived from the per-tile habitat grids, which
// include cells classified from the buffer geometry a Geofabrik extract carries from its
// neighbours — reading DC off the grids said 38% rural, which is not a fact about DC.
// A one-off audit, gated off: how many cells the 10 m / 10 m QUANTISATION moves across a
// threshold, against classifying the tiler's own floats. Reported once and kept because the
// number is the honest cost of a fixed-width record, and it is the first thing to re-measure
// if a threshold ever lands near a quantum.
const QUANT_AUDIT = process.env.HAB_QUANT_AUDIT === '1';
let quantMoved = 0;
const quantBy = new Map();

const sidecar = [];
const atlas = new Map(); // `${bx}:${by}` -> class-occurrence mask (HABITAT_BIT)
for (const k of hab.keys()) {
  const [cx, cy] = k.split(':').map(Number);
  if (!ownsLatLng((cy + 0.5) * CELL_DEG, (cx + 0.5) * CELL_DEG)) continue;
  const feat = encodeFeatures(featuresAt(cx, cy));
  const dec = decodeFeatures(feat);
  // ONE GATE FOR BOTH ARTIFACTS, and it is `all > 0` rather than "non-rural".
  //
  // "Non-rural" is a fact about TODAY's rules — a cell this bake calls rural is exactly the
  // cell a new rule might want, and omitting it would put back the re-bake revision 4 exists
  // to remove. `all > 0` is structural instead: spawns snap to walkable ways, so a cell with
  // no walkable way places nothing under any rule anybody can write, and it is the only
  // thing that can be dropped without a guess.
  //
  // The ATLAS obeys it too, which it did not before. A block whose only owned cells are
  // trackless forest used to set the atlas's `rural` bit, and the app would then tell
  // somebody there is open country 40 km east of ground nobody can walk on. Mask 0 means NO
  // DATA and that is the truthful answer there. It also makes the two artifacts the same
  // set again, which is what lets inspect-bake's cross-check be total.
  if (dec.res + dec.foot + dec.road === 0) continue;
  const mask = classifyFeatures(dec);
  const classes = classesOf(mask);
  // The ATLAS records rural; the sidecar (below) omits it. Not an inconsistency — the two
  // pay for it differently. The sidecar is one LINE per cell and rural is the default, so
  // listing it would multiply a 5 MB file by ten to say "nothing here". The atlas is a
  // fixed-size raster where rural costs one BIT that is already allocated, and without it
  // the atlas could not answer "where is rural" at all — which in Vermont is 90% of the
  // state and the single most likely habitat a player is standing in.
  const ak = Math.floor(cx / ATLAS_BLOCK_CELLS) + ':' + Math.floor(cy / ATLAS_BLOCK_CELLS);
  atlas.set(ak, (atlas.get(ak) ?? 0) | mask);
  sidecar.push({ cx, cy, feat, classes });
  if (QUANT_AUDIT) {
    const exact = classifyFeatures({ ...featuresAt(cx, cy), relief: featuresAt(cx, cy).reliefM });
    if (exact !== mask) {
      quantMoved++;
      for (const c of HABITAT_CLASSES) {
        const a = (exact & HABITAT_BIT[c]) !== 0, b = (mask & HABITAT_BIT[c]) !== 0;
        if (a !== b) quantBy.set(c, (quantBy.get(c) ?? 0) + (b ? 1 : -1));
      }
    }
  }
}

// Habitat sidecar: one line per OWNED spawn cell that has any walkable way. Sorted by cy,
// then cx — deterministic.
//
// `f` IS THE ROW AND `classes` IS THE CONVENIENCE. The server re-derives every spawn from
// the same rules the client runs (SPEC §10.4), so what it has to store is the measurement;
// `classes` is written beside it so an operator can read a line, and so `inspect-bake.mjs`
// can cross-check the atlas against something other than its own arithmetic. `class`
// (singular) is gone rather than widened — a list under a singular key would be a key
// changing meaning, which is the one thing §10.0 does not do.
sidecar.sort((a, b) => a.cy - b.cy || a.cx - b.cx);
writeFileSync(
  join(OUT, `habitat-${SLICE}.jsonl`),
  sidecar.map((s) => JSON.stringify({ cx: s.cx, cy: s.cy, f: s.feat, classes: s.classes })).join('\n') +
    (sidecar.length ? '\n' : ''),
);

// Habitat atlas: a DENSE raster over the slice's block bounding box, row-major
// south→north (by ascending outer) and west→east within a row — the same order as the
// per-tile habitat grid of §10.3, one zoom out, so there is no second convention to learn.
//
// Dense rather than a sparse {blockKey: mask} map for two reasons. Size: a JSON object
// entry costs ~20 B against 1 B for a raster slot, and a state's block bbox is well over
// 5% occupied (Vermont, a diagonal wedge, is 346/504 = 69%), so sparse loses by an order.
// And shape: the query this exists to answer is "walk outward from my block until one has
// bit X", which over a raster is index arithmetic with no allocation and no hashing.
//
// A block with mask 0 means NO DATA — this slice owns no classified spawn cell there. It
// does NOT mean "empty land": the block may be ocean, or it may belong to the next state
// and be densely urban. The distinction is the whole abstention contract; a consumer that
// reads 0 as "rural" would fabricate a wilderness out of a state line.
let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
for (const k of atlas.keys()) {
  const [bx, by] = k.split(':').map(Number);
  if (bx < bx0) bx0 = bx;
  if (bx > bx1) bx1 = bx;
  if (by < by0) by0 = by;
  if (by > by1) by1 = by;
}
const hasBlocks = atlas.size > 0;
const aCols = hasBlocks ? bx1 - bx0 + 1 : 0;
const aRows = hasBlocks ? by1 - by0 + 1 : 0;
let blocks = '';
for (let by = by0; by <= by1; by++)
  for (let bx = bx0; bx <= bx1; bx++) {
    const m = atlas.get(bx + ':' + by) ?? 0;
    blocks += B64[(m >> 6) & 63] + B64[m & 63]; // most significant character first
  }
writeFileSync(
  join(OUT, `atlas-${SLICE}.json`),
  JSON.stringify({
    v: 2, // 2: two characters per block, and `water` at bit 6 (SPEC §10.7)
    slice: SLICE,
    cellDeg: CELL_DEG,
    blockCells: ATLAS_BLOCK_CELLS,
    blockChars: ATLAS_CHARS,
    bx0: hasBlocks ? bx0 : 0,
    by0: hasBlocks ? by0 : 0,
    cols: aCols,
    rows: aRows,
    classes: HABITAT_CLASSES, // index i is bit (1 << i) — bit order is key order
    blocks,
  }) + '\n',
);

if (QUANT_AUDIT)
  console.error(
    `[tile] quantisation: ${quantMoved} of ${sidecar.length} walkable cells change mask; ` +
      [...quantBy].map(([c, n]) => `${c} ${n > 0 ? '+' : ''}${n}`).join(', '),
  );
console.error(
  `[tile] v5: ${written5} tiles, ${lcPolys.length} landcover polys, ` +
    `${sidecar.length} walkable habitat cells -> ${OUT}/v5, ${OUT}/habitat-${SLICE}.jsonl; ` +
    `atlas ${atlas.size} blocks in a ${aCols}x${aRows} raster -> ${OUT}/atlas-${SLICE}.json`,
);
console.error(
  `[tile] anchors: ${anchorSel.anchors.length} of ${anchorSel.eligible} eligible ` +
    `(${anchorCands.size} owned candidates), cap ${anchorSel.limit} from ` +
    `${anchorSel.areaKm2 === null ? 'unconstrained' : Math.round(anchorSel.areaKm2) + ' km2'} ` +
    `-> ${OUT}/landmarks-${SLICE}.jsonl`,
);

// ---- Geofabrik .poly parser + even-odd point test ----
// Even-odd across ALL rings handles holes correctly regardless of winding: a point
// inside an outer ring AND a hole ring counts twice (even) -> outside.
function parsePoly(text) {
  const rings = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const t = lines[k].trim();
    if (t === '') continue;
    if (k === 0) continue; // polygon file name
    if (t === 'END') {
      if (cur) {
        rings.push(cur);
        cur = null;
      }
      continue; // a second END (cur null) closes the file
    }
    const parts = t.split(/\s+/);
    if (parts.length === 1) {
      cur = []; // ring header: "1", "2", "!3", ...
      continue;
    }
    if (cur && parts.length >= 2) cur.push([Number(parts[0]), Number(parts[1])]);
  }
  return rings;
}

function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const xi = ring[a][0];
      const yi = ring[a][1];
      const xj = ring[b][0];
      const yj = ring[b][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
