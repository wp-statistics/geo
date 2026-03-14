const maxmind = require('maxmind');
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

function getClientIP(req) {
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

function detectFormat(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
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

function formatText(data) {
  const lines = [
    `IP:          ${data.ip}`,
  ];
  if (data.city) lines.push(`City:        ${data.city}`);
  if (data.region) {
    lines.push(`Region:      ${data.region}${data.region_code ? ` (${data.region_code})` : ''}`);
  }
  if (data.country) {
    lines.push(`Country:     ${data.country}${data.country_code ? ` (${data.country_code})` : ''}`);
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

    const { reader, name: dbName } = await getReader(db);
    const record = reader.get(ip);

    if (!record) {
      const format = detectFormat(req);
      if (format === 'json') {
        res.status(404).json({ error: 'Not found', ip, message: `No geolocation data found for ${ip}` });
      } else {
        res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8').end(`No geolocation data found for ${ip}\n`);
      }
      return;
    }

    const data = buildResult(ip, record, dbName);
    const format = detectFormat(req);

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
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
