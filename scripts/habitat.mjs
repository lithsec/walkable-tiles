// The habitat classifier — FEATURES on one side, RULES on the other (SPEC.md §10.3, §10.4).
//
// ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────────────────
//
// Until revision 4 the bake ran the classifier and shipped ONE CHARACTER per spawn cell.
// Every new class and every threshold tweak then needed a full re-bake of every slice —
// and `mountain`'s radius and threshold each moved twice during a single afternoon of
// calibration. A tile is baked whole and a state is hours; a rule that can only be changed
// by re-baking is a rule nobody changes.
//
// So the bake now ships the MEASUREMENTS and the rules are interpretation. Three consumers
// read the same numbers and must agree exactly: this tiler (which still classifies, for
// the sidecar and the atlas), Ausculta's client (`packages/content/src/habitat.ts`), and
// Ausculta's server (plpgsql, re-deriving a claim). This module is the tiler's copy, and
// SPEC §10.4 is normative for all three.
//
// RELIEF STAYS BAKED and is the reason the feature record has a field the OSM extract
// cannot produce: it comes from Copernicus GLO-30 (§10.9) and we cannot ship a DEM to a
// phone. Everything else in the record is an aggregate of geometry the tile already holds.
//
// ── THE FEATURE RECORD — 48 bits, 8 base64url characters per spawn cell ───────────────
//
// Deliberately the same idea as the atlas's per-block mask (§10.7) one zoom in: a fixed
// number of base64url characters per raster slot, row-major south→north, west→east, same
// alphabet, no separators. There is no second convention to learn and no parser to write —
// index arithmetic and a table lookup, in JS or in plpgsql.
//
//   bits   field       encoding
//   ────   ─────────   ─────────────────────────────────────────────────────────────────
//   47-45  reserved    must be 0. Three bits, held for the next aggregate (a 4th sample
//                      mask needs four, so this is honestly ONE spare slot short — see
//                      the note on waterway lines below, which is what would want it).
//   44-36  relief      9 bits. 10 m units, 0-510 => 0-5100 m. 511 means NO DEM COVERAGE,
//                      which is NOT the same as 0 m of relief — an unmeasured cell is not
//                      a flat cell, and a rule must abstain rather than read it as flat.
//   35-32  waterMask   the cell's 2x2 cover samples inside a `water` landcover polygon
//   31-28  greenMask   … inside a `green` polygon
//   27-24  woodMask    … inside a `wood` polygon
//   23-16  road        8 bits. 10 m units, saturating at 2550 m
//   15-8   foot        8 bits. 10 m units, saturating at 2550 m
//    7-0   res         8 bits. 10 m units, saturating at 2550 m
//
// MASKS, NOT COUNTS, for the three cover fields. The green GATE is `popcount(wood | green)`
// — the UNION of the two masks — so counts alone cannot reproduce it: a cell with two wood
// samples and two green samples covers anywhere from 2 to 4 of its 4 samples depending on
// WHICH ones, and only the masks say. Storing masks costs the same 12 bits as three 3-bit
// counts would and answers strictly more questions.
//
// 10 m LENGTH UNITS, LINEAR, saturating. A log scale would give constant relative
// precision and cost fewer bits, and it is refused because the thresholds are absolute
// (120 m, 900 m) and must be EXACTLY representable in every port: 120/10 = 12 and 900/10 =
// 90 are integers, so a cell cannot straddle a threshold because JS and plpgsql rounded a
// logarithm differently in the last bit. The saturation point is 2,550 m of ONE way group
// inside a 167 m cell — measured across both trial slices, no cell in either comes within
// half of it (§10.4).
//
// FLOOR, NEVER ROUND, on every field. It makes the record a LOWER BOUND on the truth, and
// since every threshold is a `>=`, quantisation can then only refuse a class — never grant
// one on evidence the cell does not have. It is the same abstention the format applies to a
// missing `lit` tag and a missing DEM post, at the smallest possible scale. Measured on the
// trial slices: rounding moved 0.96% of the District's walkable cells and 3.1% of Vermont's
// across a threshold (mountain +3,208, residential +4,470, all of it upward); flooring moves
// them the other way and by less.
//
// THE QUANTISED VALUES ARE THE INPUT, not an approximation of it. Rules are applied to the
// decoded record, never to the tiler's internal float, so the tiler, the client and the
// server classify identically by construction rather than by tolerance.

export const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Characters per spawn cell in a v5 habitat grid's `feat` string. */
export const FEAT_CHARS = 8;
/** Length quantum, metres. */
export const LEN_STEP_M = 10;
/** Relief quantum, metres. */
export const RELIEF_STEP_M = 10;
/** The 9-bit relief field's sentinel for "the DEM publishes nothing here". */
export const RELIEF_MISSING = 511;

// ── The rules, and every threshold in them (SPEC §10.4, normative) ────────────────────
//
// Adding a class here does NOT require a re-bake. That is the whole point of the split,
// and it is worth stating what it does still require: a class that needs a NEW AGGREGATE
// (waterway lines, say) needs new bits in the record, and that is a re-bake — because it
// is new DATA, not a new rule. The line to hold is that thresholds and combinations are
// free and measurements are not.
export const HAB = {
  GREEN_COVER_MIN: 0.5, // green family: this fraction of the 2x2 samples under wood OR green
  PATH_LEN_MIN: 120, //    green family: m of pure foot way …
  PATH_SHARE_MIN: 0.7, //  … and its share of all walkable length
  URBAN_LEN_MIN: 900, //   urban: m of walkable way …
  URBAN_RES_SHARE_MAX: 0.35, // … with residential no more than this share
  RES_LEN_MIN: 120, //     residential: m of residential/living_street …
  RES_SHARE_MIN: 0.4, //   … and its share
  WATER_FRAC_MIN: 0.25, // water: this fraction of samples under a `water` polygon …
  //                        … AND foot > 0. Lower than green's 0.5 because a SHORELINE cell
  //                        is mostly land by definition: a cell that is half lake is a cell
  //                        whose walkable part is a narrow strip, which is the case worth
  //                        naming. You cannot stand in a lake and spawns snap to ways, so a
  //                        cell that is ALL water has no ways and places nothing.
  MOUNTAIN_RELIEF_MIN_M: 500, // mountain: regional relief over the 5 km disc of §10.4
};

// ── The class mask (SPEC §10.3) ───────────────────────────────────────────────────────
//
// Bits 0-5 are the atlas's existing bit order (§10.7) unchanged, so the two artifacts
// share one numbering; `water` appends at bit 6. Appending rather than inserting is what
// lets a reader of the older six bits keep every meaning it had.
export const HABITAT_BIT = {
  urban: 1,
  residential: 2,
  woodland: 4,
  greenspace: 8,
  mountain: 16,
  rural: 32,
  water: 64,
};
export const HABITAT_CLASSES = Object.keys(HABITAT_BIT);

/**
 * DISPLAY precedence — which single class paints a multi-class cell, for the map's ground
 * texture, the album's plate and any per-cell report. Display ONLY: spawning reads the
 * whole mask (see `habitatMultiplier` on the Ausculta side).
 *
 * It exists so that seven classes stay seven plates rather than 2^7 combinations, and the
 * order is coarsest-and-most-distinctive first. A wooded mountainside paints `mountain`,
 * because that is what the player is standing in; a wooded lakeshore paints `water`,
 * because the water is why anyone walks there. `rural` is last and is the floor.
 */
export const DISPLAY_ORDER = [
  'mountain',
  'water',
  'woodland',
  'greenspace',
  'urban',
  'residential',
  'rural',
];

/** Pack a feature record into `FEAT_CHARS` base64url characters. Lengths in metres. */
export function encodeFeatures({ res, foot, road, woodMask, greenMask, waterMask, reliefM }) {
  const q = (m) => Math.min(255, Math.max(0, Math.floor(m / LEN_STEP_M)));
  const relief =
    reliefM === null || reliefM === undefined || !Number.isFinite(reliefM)
      ? RELIEF_MISSING
      : Math.min(510, Math.max(0, Math.floor(reliefM / RELIEF_STEP_M)));
  // Assembled as a 48-bit integer. It fits exactly in a JS double (< 2^53) and in a
  // plpgsql bigint, so neither side needs a bignum or a byte buffer to read it.
  const lo = q(res) | (q(foot) << 8) | (q(road) << 16); // bits 0-23
  const hi = (woodMask & 15) | ((greenMask & 15) << 4) | ((waterMask & 15) << 8) | (relief << 12); // 24-44
  let n = hi * 0x1000000 + lo;
  let s = '';
  for (let i = FEAT_CHARS - 1; i >= 0; i--) {
    s = B64[n % 64] + s;
    n = Math.floor(n / 64);
  }
  return s;
}

/** Unpack one cell's record. `relief` is `null` where the DEM publishes nothing. */
export function decodeFeatures(str, at = 0) {
  let n = 0;
  for (let i = 0; i < FEAT_CHARS; i++) {
    const v = B64.indexOf(str[at * FEAT_CHARS + i]);
    if (v < 0) return null; // a malformed record decodes to nothing, never to a guess
    n = n * 64 + v;
  }
  const lo = n % 0x1000000;
  const hi = Math.floor(n / 0x1000000);
  const relief = (hi >> 12) & 511;
  return {
    res: (lo & 255) * LEN_STEP_M,
    foot: ((lo >> 8) & 255) * LEN_STEP_M,
    road: ((lo >> 16) & 255) * LEN_STEP_M,
    woodMask: hi & 15,
    greenMask: (hi >> 4) & 15,
    waterMask: (hi >> 8) & 15,
    relief: relief === RELIEF_MISSING ? null : relief * RELIEF_STEP_M,
  };
}

const popcount4 = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

/**
 * Which of the two green-family classes, once something has decided a cell IS one. A
 * PARTITION, not a third and fourth independent rule — the album paints one plate per
 * class and "wooded AND open green" is not a place. woodland takes the tie because §10.1's
 * landcover precedence is already `water > wood > green`, so a polygon tagged both
 * resolves to `wood` at the polygon layer and letting greenspace win here would leave the
 * two layers disagreeing about the same square metre. With NO cover evidence at all (the
 * path rule) the answer is `greenspace`: woodland is a claim about tree cover and there is
 * none to support it.
 */
function greenKind(f) {
  const w = popcount4(f.woodMask);
  return w > 0 && w >= popcount4(f.greenMask) ? 'woodland' : 'greenspace';
}

/**
 * MULTI-LABEL: a cell is everything it is (SPEC §10.4). Every rule is evaluated
 * independently and the result is the union.
 *
 * FIRST-MATCH-WINS WAS A LIVE BUG, and it is worth naming the case rather than the
 * principle. When `mountain` landed it claimed first, and Vermont's woodland fell from
 * 3.8% of spawn cells to 1.4% — `skitter` is a SHIPPED woodland creature and it lost most
 * of its Green Mountain habitat overnight, not because the ground changed but because a
 * new class was inserted above it in a list. Real ground is a wooded mountainside; the
 * data should say so, and then the ordering argument disappears entirely.
 *
 * `rural` is the ABSENCE of every other class, so it is emitted alone or not at all.
 *
 * The `all === 0` short-circuit states one invariant once, where the old rules stated it
 * three times (`all > 0` on mountain, `foot > 0` on green): spawns snap to walkable ways,
 * so a cell with no walkable way of any kind places nothing, and classifying it would put
 * a creature where nobody can stand.
 */
export function classifyFeatures(f) {
  const all = f.res + f.foot + f.road;
  if (all === 0) return HABITAT_BIT.rural;
  let m = 0;
  // mountain — regional relief, and a missing relief never matches (abstention: an
  // unmeasured cell is not a flat cell).
  if (f.relief !== null && f.relief >= HAB.MOUNTAIN_RELIEF_MIN_M) m |= HABITAT_BIT.mountain;
  // water — SHORELINE, never open water. The `foot > 0` guard is the green rule's lesson
  // repeated at the strength open water needs.
  if (popcount4(f.waterMask) / 4 >= HAB.WATER_FRAC_MIN && f.foot > 0) m |= HABITAT_BIT.water;
  // green family — either the cover gate or the path gate; the two are alternatives, and
  // whichever fires, `greenKind` picks the member.
  const coverFrac = popcount4(f.woodMask | f.greenMask) / 4;
  if (
    (coverFrac >= HAB.GREEN_COVER_MIN && f.foot > 0) ||
    (f.foot >= HAB.PATH_LEN_MIN && f.foot / all >= HAB.PATH_SHARE_MIN)
  )
    m |= HABITAT_BIT[greenKind(f)];
  if (all >= HAB.URBAN_LEN_MIN && f.res / all <= HAB.URBAN_RES_SHARE_MAX) m |= HABITAT_BIT.urban;
  if (f.res >= HAB.RES_LEN_MIN && f.res / all >= HAB.RES_SHARE_MIN) m |= HABITAT_BIT.residential;
  return m === 0 ? HABITAT_BIT.rural : m;
}

/** The classes in a mask, in `DISPLAY_ORDER`. */
export function classesOf(mask) {
  return DISPLAY_ORDER.filter((c) => mask & HABITAT_BIT[c]);
}

/** The one class that paints. Never null: `rural` is the floor and every mask is non-zero. */
export function displayClass(mask) {
  return DISPLAY_ORDER.find((c) => mask & HABITAT_BIT[c]) ?? 'rural';
}

// A live self-check, run by `node scripts/habitat.mjs`. This repo has no test harness, and
// the feature record is a contract with two other languages — so it asserts on VALUES, the
// way dem.mjs does, for the reason CLAUDE-adjacent notes keep repeating: `typeof f ===
// 'object'` is true of an empty decode, and a record read one field short returns perfectly
// plausible numbers from the wrong offset.
if (import.meta.url === `file://${process.argv[1]}`) {
  let bad = 0;
  const check = (label, got, want) => {
    const okay = JSON.stringify(got) === JSON.stringify(want);
    if (!okay) bad++;
    console.log(`${okay ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${okay ? '' : ` != ${JSON.stringify(want)}`}`);
  };

  const round = decodeFeatures(
    encodeFeatures({ res: 349, foot: 91, road: 1271, woodMask: 0b1010, greenMask: 0b0100, waterMask: 0b1000, reliefM: 517 }),
  );
  check('every field lands at its own offset (floored to 10 m)', round, {
    res: 340, foot: 90, road: 1270, woodMask: 0b1010, greenMask: 0b0100, waterMask: 0b1000, relief: 510,
  });
  check('a record is exactly FEAT_CHARS characters', encodeFeatures({ res: 0, foot: 0, road: 0, woodMask: 0, greenMask: 0, waterMask: 0, reliefM: null }).length, FEAT_CHARS);
  check('no DEM coverage decodes to null, not to 0 m', decodeFeatures(encodeFeatures({ res: 10, foot: 0, road: 0, woodMask: 0, greenMask: 0, waterMask: 0, reliefM: null })).relief, null);
  check('0 m of MEASURED relief is a different answer', decodeFeatures(encodeFeatures({ res: 10, foot: 0, road: 0, woodMask: 0, greenMask: 0, waterMask: 0, reliefM: 0 })).relief, 0);
  check('the top field survives the 32-bit boundary', decodeFeatures(encodeFeatures({ res: 0, foot: 0, road: 0, woodMask: 0, greenMask: 0, waterMask: 0, reliefM: 5100 })).relief, 5100);
  check('a character outside the alphabet decodes to nothing', decodeFeatures('AAAAAA*A'), null);

  const cls = (o) => classesOf(classifyFeatures(decodeFeatures(encodeFeatures({ res: 0, foot: 0, road: 0, woodMask: 0, greenMask: 0, waterMask: 0, reliefM: null, ...o }))));
  check('a wooded mountainside is BOTH — the multi-label case', cls({ foot: 200, road: 100, woodMask: 15, reliefM: 900 }), ['mountain', 'woodland']);
  check('a wooded lakeshore is water and woodland', cls({ foot: 300, waterMask: 0b1100, woodMask: 15 }), ['water', 'woodland']);
  check('open water with no way is rural — you cannot stand in a lake', cls({ waterMask: 15 }), ['rural']);
  check('no relief measurement is never mountain', cls({ road: 500, reliefM: null }), ['rural']);
  check('the mountain threshold is inclusive', cls({ road: 500, reliefM: 500 }), ['mountain']);
  check('and exclusive one quantum below', cls({ road: 500, reliefM: 490 }), ['rural']);
  check('a downtown park is urban AND greenspace', cls({ foot: 900, road: 100, greenMask: 15 }), ['greenspace', 'urban']);
  check('the display class of that cell is the park', [displayClass(classifyFeatures(decodeFeatures(encodeFeatures({ res: 0, foot: 900, road: 100, woodMask: 0, greenMask: 15, waterMask: 0, reliefM: null }))))], ['greenspace']);

  console.log(bad === 0 ? '\nall habitat checks pass' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
