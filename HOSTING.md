# Hosting, cost & abuse hardening

The tiles sit on a public CDN, so the natural worry is "what if strangers hammer
it and I get a bill?" This is far lower-risk than typical CDN abuse, and this doc
explains why, then gives concrete Cloudflare settings ranked cheapest → strongest.

## Why the bandwidth-bill nightmare doesn't apply

The "$10k surprise CDN bill" story is always an **egress/bandwidth** story
(S3, CloudFront — billed per GB served). **R2 has zero egress fees.** No matter
how much anyone downloads, you are never billed for the bytes served.

What R2 *does* bill (all tiny here):

| Item | Price | Free tier / month | Who triggers it |
|---|---|---|---|
| Storage | $0.015 / GB-mo | 10 GB | your bake job |
| Class A (writes) | $4.50 / M | 1 M | your bake job only — the public can't write |
| Class B (reads) | $0.36 / M | 10 M | cache **misses** only |
| Egress | **$0** | ∞ | — |

Cloudflare's cache sits in front of R2, so a tile served from edge cache **never
touches R2** and costs nothing. You only pay Class B on a cache *miss*.

### Realistic worst case

- Someone scrapes the whole tile set (~5–10 M tiles) cold, once → ~5–10 M Class B
  reads, right around the free tier → **$0–2**. Then it's cached (free).
- To actually run up a bill an attacker must *deliberately* defeat the cache
  (cache-buster query strings) at scale. Even 100 M forced misses ≈ **$32** — and
  a rate-limit rule (below) kills that. There is **no runaway bandwidth term.**

Under normal use (device 60-day cache + edge cache) origin reads are negligible —
on the order of **$0–5/mo even at ~1 M MAU**.

## Two things already in your favor

1. **This repo does not leak the CDN host.** The app reads it from a build-time
   env var (`TILES_HOST`); it appears in no file here. Reading this public repo
   teaches someone your *pipeline*, not your *tile URL*. The URL only exists inside
   the shipped app binary.
2. **ODbL does not force you to serve everyone unlimited.** Share-alike is
   satisfied by this public pipeline (anyone can regenerate the tiles from OSM),
   optionally plus a bulk dump. That is independent of your production CDN, so you
   may gate the CDN to your app without breaking the license.

## Levers (cheapest → strongest)

### 1. Billing alert (do this first)

Cloudflare Dashboard → **Notifications** → create alerts for R2 storage/ops
approaching your comfort threshold, and a general **billing** alert. Given the
economics above, alert-only is a defensible baseline.

### 2. Aggressive cache (rare misses)

R2 → your bucket → **Settings → Public access → Custom Domain** = `tiles.yourdomain`.
Then Cloudflare → that domain → **Caching → Cache Rules**:

- Match: `URI Path starts with /v4/`
- **Eligible for cache: yes**, **Edge TTL: 7–30 days**, **Browser TTL: 7 days**.

The bake writes `Cache-Control: public, max-age=604800` already; this makes the
edge honor it aggressively so misses are rare. (Bump the `v4/` path prefix on a
major rebuild to bust cache.)

### 3. Per-IP rate limit (hard ceiling on abuse)

Cloudflare → **Security → WAF → Rate limiting rules**:

- Match: `URI Path starts with /v4/`
- e.g. **> 300 requests / 1 min per IP → Block (or Managed Challenge)** for 1 min.

A real user crosses a handful of cells per minute; 300 is generous. This caps the
deliberate cache-buster scenario at a trickle. Free plan includes basic rate
limiting; tune the threshold to your traffic.

### 4. Bot mitigation (free)

Cloudflare → **Security → Bots → Bot Fight Mode: on**. Challenges obvious bots.
Cheap insurance against drive-by scrapers.

### 5. Optional: edge token gate (only if abuse actually shows up)

A soft gate — the token ships in the app binary and can be extracted — but it
filters ~all casual/bot traffic. Serve tiles via a Worker with an R2 binding
instead of the direct custom domain:

```js
// worker.js — bind R2 bucket as TILES, set secret TILES_TOKEN
const KEY = /^\/v4\/-?\d+\/-?\d+\.json\.gz$/;
export default {
  async fetch(req, env, ctx) {
    if (req.headers.get('x-tiles-token') !== env.TILES_TOKEN)
      return new Response('forbidden', { status: 403 });

    const url = new URL(req.url);
    if (!KEY.test(url.pathname)) return new Response('not found', { status: 404 });

    // Cache by URL only (token is constant), so the gate doesn't kill edge caching.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    let res = await cache.match(cacheKey);
    if (res) return res;

    const obj = await env.TILES.get(url.pathname.slice(1));
    if (!obj) return new Response('not found', { status: 404 });
    res = new Response(obj.body, {
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'cache-control': 'public, max-age=604800',
      },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
```

App side is already forward-compatible: `fetchTileR2` sends an `x-tiles-token`
header when `EXPO_PUBLIC_TILES_TOKEN` is set (unset = no header, current behavior).
So enabling the gate is: deploy the Worker, set both secrets, ship a build with the
token env var. No client code change.

## Recommendation

Ship with **#1 + #3** (billing alert + per-IP rate limit), keep the aggressive
cache from **#2**. That's a few minutes of dashboard config, costs nothing, and
caps the only non-trivial scenario. Add the token gate (#5) only if you ever see
real scraping — it's pre-wired but not worth the complexity up front.
