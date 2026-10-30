'use strict';

// Stazione meteo: server HTTP senza dipendenze esterne.
// Serve i file statici in ./public e fa da proxy (con cache) verso Open-Meteo, Nominatim
// e le mappe di OpenStreetMap.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { labelsFromTile, EMPTY_TILE } = require('./labels');

const PORT = parseInt(process.env.PORT || '8765', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS || '600', 10) * 1000;
const USER_AGENT = 'meteo-station/1.0 (self-hosted; https://github.com/Vito-Pepe/meteo)';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Mappa: i punti cambiano poco (i modelli si aggiornano ogni 1-3 ore), quindi la cache è più lunga.
const MAP_TTL_MS = parseInt(process.env.MAP_CACHE_TTL_SECONDS || '3600', 10) * 1000;
const MAP_MAX_POINTS = 100; // per richiesta, ed è anche il gruppo massimo verso Open-Meteo
const MAP_CACHE_MAX = 3000; // punti tenuti in memoria (circa 10 kB l'uno)
// Open-Meteo è gratis fino a 600 chiamate al minuto, 5000 all'ora e 10000 al giorno, e ogni punto
// conta come una chiamata: la mappa ne usa al massimo questi, il resto resta alle previsioni.
const MAP_LIMITS = {
  minute: parseInt(process.env.MAP_LIMITE_MINUTO || '400', 10),
  hour: parseInt(process.env.MAP_LIMITE_ORA || '3000', 10),
  day: parseInt(process.env.MAP_LIMITE_GIORNO || '7000', 10),
};
// 8 variabili: sotto le 10, ogni punto conta ancora come una chiamata sola
const MAP_HOURLY_VARS = [
  'temperature_2m', 'weather_code', 'precipitation_probability', 'precipitation', 'is_day',
  'wind_speed_10m', 'wind_direction_10m', 'cloud_cover',
];

// Mappe di OpenStreetMap (https://operations.osmfoundation.org/policies/tiles/): poche alla volta,
// con il nostro User-Agent e tenute in memoria, così ogni tessera si scarica una volta sola.
const TILE_URL = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_MAX_ZOOM = 19;
const TILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const TILE_PARALLEL = 4;

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
  if (!res.ok) throw httpError(res.status, `Upstream ${res.status} per ${new URL(url).host}`);
  return res.json();
}

// --- handler API --------------------------------------------------------

function parseCoord(value, min, max, decimals = 3) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n) || n < min || n > max) return null;
  const f = 10 ** decimals; // 3 decimali, ~100 m: basta per il meteo e migliora la cache
  return Math.round(n * f) / f;
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

// --- mappa: meteo di tanti punti --------------------------------------

const mapCache = new Map(); // "lat,lon" -> { value, expires }, in ordine di uso
const mapPending = new Map(); // "lat,lon" -> promessa del gruppo che lo sta scaricando
const mapUsage = { minute: { start: 0, n: 0 }, hour: { start: 0, n: 0 }, day: { start: 0, n: 0 } };
const WINDOW_MS = { minute: 60e3, hour: 3600e3, day: 86400e3 };

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Prende n chiamate dai limiti verso Open-Meteo, se ci stanno tutte.
function takeMapBudget(n) {
  const now = Date.now();
  for (const k of Object.keys(WINDOW_MS)) {
    if (now - mapUsage[k].start >= WINDOW_MS[k]) mapUsage[k] = { start: now, n: 0 };
    if (mapUsage[k].n + n > MAP_LIMITS[k]) return false;
  }
  for (const k of Object.keys(WINDOW_MS)) mapUsage[k].n += n;
  return true;
}

// "45.46,9.19;41.9,12.5" -> punti arrotondati a 2 decimali (~1 km) e senza doppioni
function parsePoints(value) {
  const parts = String(value || '').split(';').filter(Boolean);
  if (!parts.length || parts.length > MAP_MAX_POINTS) return null;
  const points = new Map();
  for (const part of parts) {
    const [a, b] = part.split(',');
    const lat = parseCoord(a, -85, 85, 2);
    const lon = parseCoord(b, -180, 180, 2);
    if (lat === null || lon === null) return null;
    points.set(`${lat},${lon}`, { key: `${lat},${lon}`, lat, lon });
  }
  return [...points.values()];
}

// Una serie oraria per punto, dalla mezzanotte UTC di oggi per 8 giorni: copre 7 giorni
// interi in qualsiasi fuso. start è il primo orario (secondi Unix), poi un valore ogni ora.
function compactPoint(point, hourly) {
  const h = hourly || {};
  const map = (arr, f) => (arr || []).map((v) => (v == null ? null : f(v)));
  return {
    lat: point.lat,
    lon: point.lon,
    start: (h.time || [])[0] ?? null,
    temperature: map(h.temperature_2m, Math.round),
    code: map(h.weather_code, (v) => v),
    precip_prob: map(h.precipitation_probability, Math.round),
    precip: map(h.precipitation, (v) => Math.round(v * 10) / 10),
    is_day: map(h.is_day, (v) => v),
    wind: map(h.wind_speed_10m, Math.round),
    wind_dir: map(h.wind_direction_10m, Math.round),
    cloud: map(h.cloud_cover, Math.round),
  };
}

async function fetchMapPoints(points) {
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lon).join(','),
    hourly: MAP_HOURLY_VARS.join(','),
    forecast_days: '8',
    timeformat: 'unixtime',
    wind_speed_unit: 'kmh',
  });
  const data = await fetchJson(url);
  // Con più punti Open-Meteo risponde con un elenco, nello stesso ordine; con uno solo, con un oggetto.
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== points.length) throw new Error('Open-Meteo ha risposto per un numero diverso di punti');
  return list.map((d, i) => compactPoint(points[i], d && d.hourly));
}

function storeMapPoint(key, value) {
  mapCache.delete(key);
  mapCache.set(key, { value, expires: Date.now() + MAP_TTL_MS });
  if (mapCache.size <= MAP_CACHE_MAX) return;
  // Piena: via prima i punti scaduti, poi quelli usati meno di recente
  const now = Date.now();
  for (const [k, v] of mapCache) if (v.expires <= now) mapCache.delete(k);
  while (mapCache.size > MAP_CACHE_MAX) mapCache.delete(mapCache.keys().next().value);
}

async function apiMap(params) {
  const points = parsePoints(params.get('points'));
  if (!points) return { status: 400, body: { error: `Servono da 1 a ${MAP_MAX_POINTS} punti validi` } };
  const now = Date.now();
  const found = new Map();
  const missing = [];
  for (const p of points) {
    const hit = mapCache.get(p.key);
    if (hit && hit.expires > now) {
      // Usato adesso: va in fondo alla coda, così esce per ultimo quando la cache è piena
      mapCache.delete(p.key);
      mapCache.set(p.key, hit);
      found.set(p.key, hit.value);
    } else if (mapPending.has(p.key)) found.set(p.key, mapPending.get(p.key));
    else missing.push(p);
  }
  if (missing.length) {
    if (!takeMapBudget(missing.length)) {
      return { status: 429, body: { error: 'Troppe richieste per la mappa: riprova tra qualche minuto' } };
    }
    const batch = fetchMapPoints(missing).then((values) => {
      values.forEach((v, i) => storeMapPoint(missing[i].key, v));
      return values;
    });
    missing.forEach((p, i) => {
      const one = batch.then((values) => values[i]);
      mapPending.set(p.key, one);
      found.set(p.key, one);
    });
    batch.catch(() => {}).finally(() => missing.forEach((p) => mapPending.delete(p.key)));
  }
  try {
    return { status: 200, body: { points: await Promise.all(points.map((p) => found.get(p.key))) } };
  } catch (err) {
    if (err.status === 429) {
      return { status: 429, body: { error: 'Open-Meteo ha ricevuto troppe richieste: riprova tra qualche minuto' } };
    }
    throw err;
  }
}

// --- mappa: tessere di OpenStreetMap ----------------------------------

const tileCache = new Map(); // "z/x/y" -> { body, expires }, in ordine di uso
const tilePending = new Map();
let tileBytes = 0;
let tileActive = 0;
const tileQueue = [];

async function withTileSlot(fn) {
  if (tileActive >= TILE_PARALLEL) await new Promise((resolve) => tileQueue.push(resolve));
  tileActive++;
  try {
    return await fn();
  } finally {
    tileActive--;
    const next = tileQueue.shift();
    if (next) next();
  }
}

function storeTile(key, tile) {
  const old = tileCache.get(key);
  if (old) tileBytes -= old.body.length;
  tileCache.delete(key);
  tileCache.set(key, tile);
  tileBytes += tile.body.length;
  while (tileBytes > TILE_CACHE_MAX_BYTES && tileCache.size > 1) {
    const [k, v] = tileCache.entries().next().value;
    tileCache.delete(k);
    tileBytes -= v.body.length;
  }
}

async function fetchTile(z, x, y) {
  const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/png' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw httpError(res.status, `Upstream ${res.status} per ${new URL(url).host}`);
  const body = Buffer.from(await res.arrayBuffer());
  // Si rispetta la durata data dal server delle mappe, tra 1 ora e 7 giorni (1 giorno se non la dice).
  const m = /max-age=(\d+)/.exec((res.headers && res.headers.get('cache-control')) || '');
  const seconds = Math.min(Math.max(m ? Number(m[1]) : 86400, 3600), 7 * 86400);
  return { body, expires: Date.now() + seconds * 1000 };
}

async function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit && hit.expires > Date.now()) {
    storeTile(key, hit);
    return hit.body;
  }
  if (!tilePending.has(key)) {
    const job = withTileSlot(() => fetchTile(z, x, y))
      .then((tile) => { storeTile(key, tile); return tile.body; })
      .finally(() => tilePending.delete(key));
    tilePending.set(key, job);
  }
  return tilePending.get(key);
}

// Solo le scritte della tessera (labels.js), da mettere sopra il disegno del meteo, a 1x, 2x o 3x
// come lo schermo che le chiede. Si ricavano dalla tessera già in cache: a OpenStreetMap ogni
// tessera si chiede una volta sola.
async function getLabels(z, x, y, scale) {
  const key = `labels/${z}/${x}/${y}@${scale}`;
  const hit = tileCache.get(key);
  if (hit && hit.expires > Date.now()) {
    storeTile(key, hit);
    return hit.body;
  }
  const base = await getTile(z, x, y);
  let body;
  try {
    body = labelsFromTile(base, scale);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] scritte ${z}/${x}/${y}: ${err.message}`);
    body = EMPTY_TILE;
  }
  const entry = tileCache.get(`${z}/${x}/${y}`);
  storeTile(key, { body, expires: entry ? entry.expires : Date.now() + 86400e3 });
  return body;
}

async function serveTile(req, res, match) {
  const labels = match[1] === 'labels';
  const [z, x, y] = match.slice(2, 5).map(Number);
  const scale = Number(match[5] || 1);
  const n = 2 ** z;
  if (z > TILE_MAX_ZOOM || x >= n || y >= n || (scale > 1 && !labels)) return send(res, 400, 'Tessera non valida', { 'Content-Type': 'text/plain' });
  try {
    const body = labels ? await getLabels(z, x, y, scale) : await getTile(z, x, y);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    if (err.status === 404) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    console.error(`[${new Date().toISOString()}] tessera ${z}/${x}/${y}: ${err.message}`);
    return send(res, 502, 'Mappa non raggiungibile', { 'Content-Type': 'text/plain' });
  }
}

const ROUTES = {
  '/api/search': apiSearch,
  '/api/reverse': apiReverse,
  '/api/forecast': apiForecast,
  '/api/map': apiMap,
};

// --- server -------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

function sendJson(req, res, status, obj) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  let body = JSON.stringify(obj);
  // I punti della mappa pesano qualche centinaio di kB: compressi diventano un quinto.
  if (body.length > 1024 && acceptsGzip(req)) {
    body = zlib.gzipSync(body);
    Object.assign(headers, { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  }
  send(res, status, body, headers);
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
    const type = MIME[ext] || 'application/octet-stream';
    const gzip = /^(text\/|application\/(json|manifest)|image\/svg)/.test(type) && acceptsGzip(req);
    res.writeHead(200, {
      'Content-Type': type,
      ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : { 'Content-Length': stat.size }),
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    if (gzip) stream.pipe(zlib.createGzip()).pipe(res);
    else stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  if (url.pathname === '/healthz') return sendJson(req, res, 200, { ok: true });

  const tile = /^\/(tiles|labels)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:@([23])x)?\.png$/.exec(url.pathname);
  if (tile) return serveTile(req, res, tile);

  const route = ROUTES[url.pathname];
  if (route) {
    try {
      const { status, body } = await route(url.searchParams);
      return sendJson(req, res, status, body);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${url.pathname}: ${err.message}`);
      return sendJson(req, res, 502, { error: 'Servizio meteo non raggiungibile, riprova tra poco' });
    }
  }

  if (url.pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'Not found' });
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
