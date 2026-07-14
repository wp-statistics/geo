// Cloudflare Worker for geo.wp-statistics.com
//
// Feature-for-feature port of the Vercel deployment (api/lookup.js + middleware.js):
//   GET /                      landing page (browser) or your-own-IP lookup (curl/CLI)
//   GET /1.2.3.4               look up an IPv4 in the path
//   GET /api/lookup?ip=&db=&format=   full lookup API
// Databases are read from R2 in small byte-ranges via ./mmdb.js — never fully loaded.

import { openReader } from './mmdb.js';

const DBS = {
  maxmind: { key: 'GeoLite2-City.mmdb', name: 'GeoLite2-City' },
  dbip: { key: 'dbip-city-lite.mmdb', name: 'DB-IP City Lite' },
};

// Per-isolate reader cache. Each reader keeps its own warm R2 block cache, so a
// busy isolate rarely re-reads the same part of the database.
const READERS = {};
function getReader(env, dbKey) {
  if (!READERS[dbKey]) {
    READERS[dbKey] = openReader(env.GEO_DB, DBS[dbKey].key).catch((err) => {
      READERS[dbKey] = undefined; // allow a later request to retry after a transient failure
      throw err;
    });
  }
  return READERS[dbKey];
}

const CACHE_PUBLIC = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
const CACHE_PRIVATE = 'private, no-store';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

const CLI_AGENTS = ['curl/', 'wget/', 'httpie/', 'go-http-client', 'python-requests', 'powershell', 'libwww-perl', 'python-urllib'];

// ---- IP validation (equivalent to Node's net.isIP) ------------------------

function isIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    if (p.length > 1 && p[0] === '0') return false; // reject leading zeros
    if (Number(p) > 255) return false;
  }
  return true;
}

const IPV6_RE = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,7}:|([0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|([0-9a-f]{1,4}:){1,5}(:[0-9a-f]{1,4}){1,2}|([0-9a-f]{1,4}:){1,4}(:[0-9a-f]{1,4}){1,3}|([0-9a-f]{1,4}:){1,3}(:[0-9a-f]{1,4}){1,4}|([0-9a-f]{1,4}:){1,2}(:[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:((:[0-9a-f]{1,4}){1,6})|:((:[0-9a-f]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-f]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/;
function isIPv6(s) { return IPV6_RE.test(s); }

function isReservedIPv4(addr) {
  const [a, b, c] = addr.split('.').map(Number);
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isReservedIPv6(addr) {
  if (addr === '::' || addr === '::1') return true;
  if (/^fe[89ab]/.test(addr)) return true;
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true;
  if (addr.startsWith('ff')) return true;
  return false;
}

function classifyIP(ip) {
  if (typeof ip !== 'string') return 'invalid';
  const addr = ip.split('%')[0].toLowerCase();
  if (isIPv4(addr)) return isReservedIPv4(addr) ? 'reserved' : 'public';
  if (isIPv6(addr)) return isReservedIPv6(addr) ? 'reserved' : 'public';
  return 'invalid';
}

// ---- request helpers ------------------------------------------------------

function getClientIP(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip') || '127.0.0.1';
}

function isCLI(request) {
  const ua = (request.headers.get('user-agent') || '').toLowerCase();
  if (CLI_AGENTS.some((a) => ua.includes(a))) return true;
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/html') && !accept.includes('*/*')) return true;
  return false;
}

function detectFormat(request, url) {
  const explicit = url.searchParams.get('format');
  if (explicit && ['json', 'text', 'table'].includes(explicit)) return explicit;
  const accept = request.headers.get('accept') || '';
  if (accept.includes('application/json')) return 'json';
  if (accept.includes('text/plain')) return 'text';
  if (isCLI(request)) return 'text';
  return 'json';
}

// ---- result shaping (identical fields to the Vercel version) --------------

function buildResult(ip, record, dbName) {
  return {
    ip,
    city: record?.city?.names?.en || null,
    region: record?.subdivisions?.[0]?.names?.en || null,
    region_code: record?.subdivisions?.[0]?.iso_code || null,
    country: record?.country?.names?.en || null,
    country_code: record?.country?.iso_code || null,
    continent: record?.continent?.names?.en || null,
    continent_code: record?.continent?.code || null,
    latitude: record?.location?.latitude || null,
    longitude: record?.location?.longitude || null,
    timezone: record?.location?.time_zone || null,
    postal_code: record?.postal?.code || null,
    accuracy_radius: record?.location?.accuracy_radius || null,
    metro_code: record?.location?.metro_code || null,
    is_in_european_union: record?.country?.is_in_european_union ?? null,
    registered_country: record?.registered_country?.names?.en || null,
    registered_country_code: record?.registered_country?.iso_code || null,
    city_geoname_id: record?.city?.geoname_id || null,
    country_geoname_id: record?.country?.geoname_id || null,
    database: dbName,
  };
}

function countryFlag(code) {
  if (!code) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => c.charCodeAt(0) + 127397));
}

function formatText(d) {
  const flag = countryFlag(d.country_code);
  const lines = [`IP:          ${d.ip}`];
  if (d.city) lines.push(`City:        ${d.city}`);
  if (d.region) lines.push(`Region:      ${d.region}${d.region_code ? ` (${d.region_code})` : ''}`);
  if (d.country) lines.push(`Country:     ${flag ? flag + ' ' : ''}${d.country}${d.country_code ? ` (${d.country_code})` : ''}`);
  if (d.continent) lines.push(`Continent:   ${d.continent}${d.continent_code ? ` (${d.continent_code})` : ''}`);
  if (d.latitude != null && d.longitude != null) lines.push(`Coordinates: ${d.latitude}, ${d.longitude}`);
  if (d.timezone) lines.push(`Timezone:    ${d.timezone}`);
  if (d.postal_code) lines.push(`Postal:      ${d.postal_code}`);
  if (d.accuracy_radius != null) lines.push(`Accuracy:    ~${d.accuracy_radius} km`);
  if (d.metro_code != null) lines.push(`Metro Code:  ${d.metro_code}`);
  if (d.is_in_european_union != null) lines.push(`EU Member:   ${d.is_in_european_union ? 'Yes' : 'No'}`);
  if (d.registered_country && d.registered_country !== d.country) {
    lines.push(`Reg. Country:${d.registered_country}${d.registered_country_code ? ` (${d.registered_country_code})` : ''}`);
  }
  lines.push(`Database:    ${d.database}`);
  return lines.join('\n') + '\n';
}

function formatTable(d) {
  const rows = [['IP', d.ip]];
  if (d.city) rows.push(['City', d.city]);
  if (d.region) rows.push(['Region', `${d.region}${d.region_code ? ` (${d.region_code})` : ''}`]);
  if (d.country) rows.push(['Country', `${d.country}${d.country_code ? ` (${d.country_code})` : ''}`]);
  if (d.continent) rows.push(['Continent', `${d.continent}${d.continent_code ? ` (${d.continent_code})` : ''}`]);
  if (d.latitude != null && d.longitude != null) rows.push(['Coordinates', `${d.latitude}, ${d.longitude}`]);
  if (d.timezone) rows.push(['Timezone', d.timezone]);
  if (d.postal_code) rows.push(['Postal Code', d.postal_code]);
  if (d.accuracy_radius != null) rows.push(['Accuracy', `~${d.accuracy_radius} km`]);
  if (d.metro_code != null) rows.push(['Metro Code', String(d.metro_code)]);
  if (d.is_in_european_union != null) rows.push(['EU Member', d.is_in_european_union ? 'Yes' : 'No']);
  if (d.registered_country && d.registered_country !== d.country) {
    rows.push(['Reg. Country', `${d.registered_country}${d.registered_country_code ? ` (${d.registered_country_code})` : ''}`]);
  }
  rows.push(['Database', d.database]);

  const col1 = Math.max(...rows.map((r) => r[0].length));
  const col2 = Math.max(...rows.map((r) => r[1].length));
  const hr = `+-${'-'.repeat(col1)}-+-${'-'.repeat(col2)}-+`;
  const lines = [hr, `| ${'Field'.padEnd(col1)} | ${'Value'.padEnd(col2)} |`, hr];
  for (const [f, v] of rows) lines.push(`| ${f.padEnd(col1)} | ${String(v).padEnd(col2)} |`);
  lines.push(hr);
  return lines.join('\n') + '\n';
}

// ---- responses ------------------------------------------------------------

function makeHeaders(contentType, cacheable) {
  const h = { 'Content-Type': contentType, ...CORS };
  if (cacheable) { h['Cache-Control'] = CACHE_PUBLIC; h['Vary'] = 'Accept'; }
  else h['Cache-Control'] = CACHE_PRIVATE;
  return h;
}

function errorResponse(status, ip, message, format, cacheable) {
  if (format === 'json') {
    const body = JSON.stringify({ error: status === 400 ? 'Invalid request' : 'Not found', ip, message });
    return new Response(body, { status, headers: makeHeaders('application/json; charset=utf-8', cacheable) });
  }
  return new Response(message + '\n', { status, headers: makeHeaders('text/plain; charset=utf-8', cacheable) });
}

async function lookupResponse(request, env, ctx, queryIP, url) {
  const cacheable = Boolean(queryIP);

  // Serve edge-cached answers for explicit ?ip= lookups (identical for everyone).
  const cache = caches.default;
  if (cacheable) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  const dbKey = url.searchParams.get('db') === 'dbip' ? 'dbip' : 'maxmind';
  const ip = queryIP || getClientIP(request);
  const format = detectFormat(request, url);

  let response;
  try {
    const ipClass = classifyIP(ip);
    if (ipClass === 'invalid') {
      response = errorResponse(400, ip, `'${ip}' is not a valid IP address`, format, cacheable);
    } else if (ipClass === 'reserved') {
      response = errorResponse(404, ip, `No geolocation data for private or reserved IP ${ip}`, format, cacheable);
    } else {
      const reader = await getReader(env, dbKey);
      const record = await reader.get(ip);
      if (!record) {
        response = errorResponse(404, ip, `No geolocation data found for ${ip}`, format, cacheable);
      } else {
        const data = buildResult(ip, record, DBS[dbKey].name);
        let body, type;
        if (format === 'table') { body = formatTable(data); type = 'text/plain; charset=utf-8'; }
        else if (format === 'text') { body = formatText(data); type = 'text/plain; charset=utf-8'; }
        else { body = JSON.stringify(data); type = 'application/json; charset=utf-8'; }
        response = new Response(body, { status: 200, headers: makeHeaders(type, cacheable) });
      }
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal server error', message: String(err && err.message || err) }), {
      status: 500,
      headers: makeHeaders('application/json; charset=utf-8', false),
    });
  }

  if (cacheable && request.method === 'GET') {
    ctx.waitUntil(cache.put(request, response.clone()).catch(() => {}));
  }
  return response;
}

function serveAsset(request, env) {
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed\n', { status: 405, headers: { 'Content-Type': 'text/plain', ...CORS } });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/') {
      if (isCLI(request)) return lookupResponse(request, env, ctx, null, url);
      return serveAsset(request, env);
    }
    if (path === '/api/lookup') {
      return lookupResponse(request, env, ctx, url.searchParams.get('ip'), url);
    }
    const m = path.match(/^\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m) return lookupResponse(request, env, ctx, m[1], url);

    return serveAsset(request, env);
  },
};
