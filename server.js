'use strict';

// Stazione meteo: server HTTP senza dipendenze esterne.
// Serve i file statici in ./public e fa da proxy (con cache) verso Open-Meteo e Nominatim.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8765', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '600', 10) * 1000;
const USER_AGENT = 'meteo-station/1.0 (self-hosted; https://github.com/Vito-Pepe/meteo)';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CURRENT_VARS = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day',
  'precipitation', 'weather_code', 'cloud_cover', 'pressure_msl',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
];
const HOURLY_VARS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
  'precipitation_probability', 'precipitation', 'weather_code', 'cloud_cover',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'uv_index', 'is_day',
];
const DAILY_VARS = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min',
  'apparent_temperature_max', 'apparent_temperature_min',
  'precipitation_sum', 'precipitation_probability_max', 'precipitation_hours',
  'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
  'sunrise', 'sunset', 'uv_index_max',
];

// --- cache in memoria ---------------------------------------------------

const cache = new Map();

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await loader();
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  }
  return value;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Upstream ${res.status} per ${new URL(url).host}`);
  return res.json();
}

// --- handler API --------------------------------------------------------

function parseCoord(value, min, max) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 1000) / 1000; // ~100 m: basta per il meteo e migliora la cache
}

async function apiSearch(params) {
  const q = (params.get('q') || '').trim();
  if (q.length < 2) return { status: 400, body: { error: 'Scrivi almeno 2 caratteri' } };
  const url = 'https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({
    name: q.slice(0, 100), count: '8', language: 'it', format: 'json',
  });
  const data = await cached('search:' + q.toLowerCase(), () => fetchJson(url));
  const results = (data.results || []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    country_code: r.country_code,
    latitude: r.latitude,
    longitude: r.longitude,
  }));
  return { status: 200, body: { results } };
}

async function apiReverse(params) {
  const lat = parseCoord(params.get('lat'), -90, 90);
  const lon = parseCoord(params.get('lon'), -180, 180);
  if (lat === null || lon === null) return { status: 400, body: { error: 'Coordinate non valide' } };
  const url = 'https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({
    lat: String(lat), lon: String(lon), format: 'jsonv2', zoom: '10', 'accept-language': 'it',
  });
  try {
    const data = await cached(`rev:${lat},${lon}`, () => fetchJson(url));
    const a = data.address || {};
    const name = a.city || a.town || a.village || a.municipality || a.hamlet || a.county || data.name;
    const region = [a.state || a.county, a.country].filter(Boolean).join(', ');
    return { status: 200, body: { name: name || null, region } };
  } catch (err) {
    // Il nome è un dettaglio: se il servizio non risponde il client mostra le coordinate.
    return { status: 200, body: { name: null, region: '' } };
  }
}

async function apiForecast(params) {
  const lat = parseCoord(params.get('lat'), -90, 90);
  const lon = parseCoord(params.get('lon'), -180, 180);
  if (lat === null || lon === null) return { status: 400, body: { error: 'Coordinate non valide' } };
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: CURRENT_VARS.join(','),
    hourly: HOURLY_VARS.join(','),
    daily: DAILY_VARS.join(','),
    timezone: 'auto',
    forecast_days: '7',
    wind_speed_unit: 'kmh',
  });
  const data = await cached(`fc:${lat},${lon}`, () => fetchJson(url));
  return { status: 200, body: data };
}

const ROUTES = {
  '/api/search': apiSearch,
  '/api/reverse': apiReverse,
  '/api/forecast': apiForecast,
};

// --- server -------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

  const route = ROUTES[url.pathname];
  if (route) {
    try {
      const { status, body } = await route(url.searchParams);
      return sendJson(res, status, body);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${url.pathname}: ${err.message}`);
      return sendJson(res, 502, { error: 'Servizio meteo non raggiungibile, riprova tra poco' });
    }
  }

  if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
  return serveStatic(req, res, url.pathname);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Stazione meteo in ascolto su http://${HOST}:${PORT}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { server };
