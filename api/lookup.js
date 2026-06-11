const maxmind = require('maxmind');
const net = require('net');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

let readers = {};

async function getReader(db) {
  const key = db === 'dbip' ? 'dbip' : 'maxmind';
  if (!readers[key]) {
    const file = key === 'dbip'
      ? path.join(process.cwd(), 'data', 'dbip-city-lite.mmdb.gz')
      : path.join(process.cwd(), 'data', 'GeoLite2-City.mmdb.gz');
    const compressed = fs.readFileSync(file);
    const buffer = zlib.gunzipSync(compressed);
    readers[key] = new maxmind.Reader(buffer);
  }
  return { reader: readers[key], name: key === 'dbip' ? 'DB-IP City Lite' : 'GeoLite2-City' };
}

// Public lookups keyed on an explicit ?ip= are identical for every caller and
// can be cached at the shared edge for a day. Repeats then cost zero function
// invocations. Browsers are told not to cache (max-age=0) so a user re-checking
// their own IP always gets a fresh answer.
const CACHE_PUBLIC = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
const CACHE_PRIVATE = 'private, no-store';

function applyCache(res, cacheable) {
  if (cacheable) {
    res.setHeader('Cache-Control', CACHE_PUBLIC);
    res.setHeader('Vary', 'Accept');
  } else {
    res.setHeader('Cache-Control', CACHE_PRIVATE);
  }
}

function isReservedIPv4(addr) {
  const [a, b, c] = addr.split('.').map(Number);
  if (a === 0) return true;                              // 0.0.0.0/8 "this network"
  if (a === 10) return true;                             // 10.0.0.0/8 private
  if (a === 127) return true;                            // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true;     // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16 private
  if (a === 192 && b === 0 && c === 2) return true;      // 192.0.2.0/24 documentation
  if (a === 198 && (b === 18 || b === 19)) return true;  // 198.18.0.0/15 benchmarking
  if (a >= 224) return true;                             // 224/4 multicast + 240/4 reserved
  return false;
}

function isReservedIPv6(addr) {
  if (addr === '::' || addr === '::1') return true;      // unspecified, loopback
  if (/^fe[89ab]/.test(addr)) return true;               // fe80::/10 link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // fc00::/7 unique-local
  if (addr.startsWith('ff')) return true;                // ff00::/8 multicast
  return false;
}

// 'public' = worth a DB lookup; 'reserved' = private/loopback/etc (no geo data);
// 'invalid' = not an IP at all. net.isIP is authoritative on validity (rejects
// leading zeros, out-of-range octets, malformed v6), so the helpers above only
// judge reserved-ness. Reserved/invalid are answered without touching the 68 MB
// database.
function classifyIP(ip) {
  if (typeof ip !== 'string') return 'invalid';
  const addr = ip.split('%')[0].toLowerCase(); // drop IPv6 zone id (e.g. %eth0)
  const version = net.isIP(addr);
  if (version === 4) return isReservedIPv4(addr) ? 'reserved' : 'public';
  if (version === 6) return isReservedIPv6(addr) ? 'reserved' : 'public';
  return 'invalid';
}

function sendError(res, status, ip, message, format, cacheable) {
  applyCache(res, cacheable);
  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(status).json({ error: status === 400 ? 'Invalid request' : 'Not found', ip, message });
  } else {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(status).end(message + '\n');
  }
}

function getClientIP(req) {
  if (req.headers['cf-connecting-ip']) return req.headers['cf-connecting-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '127.0.0.1';
}

function isCLI(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const cliAgents = ['curl/', 'wget/', 'httpie/', 'go-http-client', 'python-requests', 'powershell', 'libwww-perl', 'python-urllib'];
  if (cliAgents.some(agent => ua.includes(agent))) return true;
  const accept = req.headers['accept'] || '';
  if (!accept.includes('text/html') && !accept.includes('*/*')) return true;
  return false;
}

function detectFormat(req, url) {
  const explicit = url.searchParams.get('format');
  if (explicit && ['json', 'text', 'table'].includes(explicit)) return explicit;
  const accept = req.headers['accept'] || '';
  if (accept.includes('application/json')) return 'json';
  if (accept.includes('text/plain')) return 'text';
  if (isCLI(req)) return 'text';
  return 'json';
}

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
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => c.charCodeAt(0) + 127397));
}

function formatText(data) {
  const flag = countryFlag(data.country_code);
  const lines = [
    `IP:          ${data.ip}`,
  ];
  if (data.city) lines.push(`City:        ${data.city}`);
  if (data.region) {
    lines.push(`Region:      ${data.region}${data.region_code ? ` (${data.region_code})` : ''}`);
  }
  if (data.country) {
    lines.push(`Country:     ${flag ? flag + ' ' : ''}${data.country}${data.country_code ? ` (${data.country_code})` : ''}`);
  }
  if (data.continent) {
    lines.push(`Continent:   ${data.continent}${data.continent_code ? ` (${data.continent_code})` : ''}`);
  }
  if (data.latitude != null && data.longitude != null) {
    lines.push(`Coordinates: ${data.latitude}, ${data.longitude}`);
  }
  if (data.timezone) lines.push(`Timezone:    ${data.timezone}`);
  if (data.postal_code) lines.push(`Postal:      ${data.postal_code}`);
  if (data.accuracy_radius != null) lines.push(`Accuracy:    ~${data.accuracy_radius} km`);
  if (data.metro_code != null) lines.push(`Metro Code:  ${data.metro_code}`);
  if (data.is_in_european_union != null) lines.push(`EU Member:   ${data.is_in_european_union ? 'Yes' : 'No'}`);
  if (data.registered_country && data.registered_country !== data.country) {
    lines.push(`Reg. Country:${data.registered_country}${data.registered_country_code ? ` (${data.registered_country_code})` : ''}`);
  }
  lines.push(`Database:    ${data.database}`);
  return lines.join('\n') + '\n';
}

function formatTable(data) {
  const rows = [
    ['IP', data.ip],
  ];
  if (data.city) rows.push(['City', data.city]);
  if (data.region) rows.push(['Region', `${data.region}${data.region_code ? ` (${data.region_code})` : ''}`]);
  if (data.country) rows.push(['Country', `${data.country}${data.country_code ? ` (${data.country_code})` : ''}`]);
  if (data.continent) rows.push(['Continent', `${data.continent}${data.continent_code ? ` (${data.continent_code})` : ''}`]);
  if (data.latitude != null && data.longitude != null) rows.push(['Coordinates', `${data.latitude}, ${data.longitude}`]);
  if (data.timezone) rows.push(['Timezone', data.timezone]);
  if (data.postal_code) rows.push(['Postal Code', data.postal_code]);
  if (data.accuracy_radius != null) rows.push(['Accuracy', `~${data.accuracy_radius} km`]);
  if (data.metro_code != null) rows.push(['Metro Code', String(data.metro_code)]);
  if (data.is_in_european_union != null) rows.push(['EU Member', data.is_in_european_union ? 'Yes' : 'No']);
  if (data.registered_country && data.registered_country !== data.country) {
    rows.push(['Reg. Country', `${data.registered_country}${data.registered_country_code ? ` (${data.registered_country_code})` : ''}`]);
  }
  rows.push(['Database', data.database]);

  const col1 = Math.max(...rows.map(r => r[0].length));
  const col2 = Math.max(...rows.map(r => r[1].length));
  const hr = `+-${'-'.repeat(col1)}-+-${'-'.repeat(col2)}-+`;
  const header = `| ${'Field'.padEnd(col1)} | ${'Value'.padEnd(col2)} |`;
  const headerHr = `+-${'-'.repeat(col1)}-+-${'-'.repeat(col2)}-+`;

  const lines = [hr, header, headerHr];
  for (const [field, value] of rows) {
    lines.push(`| ${field.padEnd(col1)} | ${String(value).padEnd(col2)} |`);
  }
  lines.push(hr);
  return lines.join('\n') + '\n';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const queryIP = url.searchParams.get('ip');
    const db = url.searchParams.get('db') || 'maxmind';
    const ip = queryIP || getClientIP(req);
    const format = detectFormat(req, url);

    // Only an explicit ?ip= produces a caller-independent answer that is safe to
    // share from the edge cache. An IP derived from the caller's own connection
    // must stay private, or the CDN would serve one visitor's location to all.
    const cacheable = Boolean(queryIP);

    // Validate before touching the 68 MB database. Invalid input and private /
    // reserved ranges (10.x, 127.x, 192.168.x, 169.254.x, ...) never have geo
    // data, so answer them with a cacheable error instead of paying for a
    // decompression + lookup on every junk request.
    const ipClass = classifyIP(ip);
    if (ipClass === 'invalid') {
      sendError(res, 400, ip, `'${ip}' is not a valid IP address`, format, cacheable);
      return;
    }
    if (ipClass === 'reserved') {
      sendError(res, 404, ip, `No geolocation data for private or reserved IP ${ip}`, format, cacheable);
      return;
    }

    const { reader, name: dbName } = await getReader(db);
    const record = reader.get(ip);

    if (!record) {
      sendError(res, 404, ip, `No geolocation data found for ${ip}`, format, cacheable);
      return;
    }

    const data = buildResult(ip, record, dbName);
    applyCache(res, cacheable);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).json(data);
    } else if (format === 'table') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).end(formatTable(data));
    } else {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).end(formatText(data));
    }
  } catch (err) {
    console.error('Lookup error:', err);
    res.setHeader('Cache-Control', CACHE_PRIVATE);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
