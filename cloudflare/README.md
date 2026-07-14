# geo.wp-statistics.com — Cloudflare Worker

Runs the IP lookup site on Cloudflare instead of Vercel. Every current feature is
kept, and lookups use **your own** MaxMind / DB-IP databases.

The databases (61 MB and 125 MB) are too big to hold in a Worker's 128 MB memory,
so they live in **R2** (Cloudflare storage) and the Worker reads only the small
byte-range each lookup needs (~7–11 KB per lookup). This has been verified to give
byte-for-byte identical answers to the old code across thousands of test IPs.

## What it serves

| Request | Response |
|---|---|
| `GET /` (browser) | the landing page |
| `GET /` (curl/CLI) | the caller's own IP location |
| `GET /1.2.3.4` | look up that IPv4 |
| `GET /api/lookup?ip=&db=&format=` | full API (`db=maxmind`\|`dbip`, `format=json`\|`text`\|`table`) |

## Files

- `src/index.js` — routing, formats, CLI detection, caching (port of the Vercel `api/lookup.js` + `middleware.js`)
- `src/mmdb.js` — the byte-range database reader
- `public/index.html` — the landing page
- `scripts/upload-db.sh` — download latest databases and upload to R2
- `.github/workflows/upload-r2.yml` — keeps R2 fresh automatically (move to repo root)

## One-time deploy

From this `cloudflare/` folder:

```bash
npm install
wrangler login                          # opens the browser once

# 1. Create the storage bucket
wrangler r2 bucket create geo-databases

# 2. Upload the databases (downloads the latest, uploads uncompressed)
npm run upload-db

# 3. Deploy the Worker
npm run deploy
```

Then point the domain at it: in the Cloudflare dashboard open the Worker →
**Settings → Domains & Routes → Add → Custom domain** → `geo.wp-statistics.com`.
(`geo.wp-statistics.com` must be on a zone in this Cloudflare account.)

## Local testing

```bash
# load the databases into the local simulation once
wrangler r2 object put geo-databases/GeoLite2-City.mmdb --file /path/GeoLite2-City.mmdb --local
wrangler r2 object put geo-databases/dbip-city-lite.mmdb --file /path/dbip-city-lite.mmdb --local
npm run dev
curl 'http://localhost:8787/8.8.8.8'
```

## Keeping databases updated

`scripts/upload-db.sh` pulls the newest databases from the jsDelivr CDN and uploads
them. Run it by hand anytime, or let the included GitHub Action do it twice a week
(needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets).

## Cost

- Workers free plan: 100,000 requests/day. Above that, the $5/month plan.
- R2 free plan: 10 GB storage + generous read allowance; the two databases are ~186 MB.
- The old-IP lookups and `?ip=` lookups are edge-cached, so R2 is read rarely.
