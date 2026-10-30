'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const { forecastFixture, searchFixture, mapFixture, MAP_START, pngFixture, mapTileFixture } = require('./fixture');
const labels = require('../labels');

// Limite basso per provare il blocco delle richieste della mappa (va deciso prima di caricare il server).
process.env.MAP_LIMITE_MINUTO = '60';

const calls = [];
let lastOptions = null;
global.fetch = async (url, options) => {
  calls.push(String(url));
  lastOptions = options;
  const u = new URL(url);
  if (u.host === 'tile.openstreetmap.org') {
    if (u.pathname === '/3/1/1.png') return { ok: false, status: 404 };
    const png = u.pathname === '/6/30/20.png' ? mapTileFixture() : Buffer.from('finto-png');
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'cache-control': 'max-age=604800' }),
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length),
    };
  }
  let body;
  if (u.host === 'api.open-meteo.com' && u.searchParams.get('timeformat') === 'unixtime') {
    if (u.searchParams.get('latitude') === '10.5') return { ok: false, status: 429, json: async () => ({}) };
    const nums = (k) => u.searchParams.get(k).split(',').map(Number);
    body = mapFixture(nums('latitude'), nums('longitude'));
  } else if (u.host === 'api.open-meteo.com') body = forecastFixture();
  else if (u.host === 'geocoding-api.open-meteo.com') body = searchFixture;
  else if (u.host === 'nominatim.openstreetmap.org') body = { address: { town: 'Frascati', state: 'Lazio', country: 'Italia' } };
  else throw new Error('host inatteso ' + u.host);
  return { ok: true, status: 200, json: async () => body };
};

const { server } = require('../server');
let base;

test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => server.close());

// fetch globale è finto (verso le API esterne): col server di test si parla via http.
const get = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get(base + p, { headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, buffer, text: buffer.toString() });
    });
  }).on('error', reject);
});

test('serve la pagina principale', async () => {
  const r = await get('/');
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.text, /Cerca una località/);
});

test('blocca il path traversal', async () => {
  const r = await get('/..%2fserver.js');
  assert.notStrictEqual(r.status, 200);
});

test('healthz', async () => {
  assert.strictEqual((await get('/healthz')).status, 200);
});

test('ricerca località', async () => {
  const r = await get('/api/search?q=roma');
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.text);
  assert.strictEqual(body.results.length, 2);
  assert.deepStrictEqual(body.results[0], {
    name: 'Roma', region: 'Lazio, Italia', country_code: 'IT', latitude: 41.89193, longitude: 12.51133,
  });
  assert.strictEqual((await get('/api/search?q=r')).status, 400);
});

test('previsioni con cache', async () => {
  const before = calls.length;
  const r1 = await get('/api/forecast?lat=41.9&lon=12.5');
  const r2 = await get('/api/forecast?lat=41.9&lon=12.5');
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(JSON.parse(r2.text).daily.time.length, 7);
  assert.strictEqual(calls.length - before, 1, 'la seconda richiesta deve arrivare dalla cache');
  assert.match(calls[calls.length - 1], /forecast_days=7/);
  assert.match(calls[calls.length - 1], /timezone=auto/);
});

test('coordinate non valide', async () => {
  assert.strictEqual((await get('/api/forecast?lat=100&lon=12')).status, 400);
  assert.strictEqual((await get('/api/forecast?lat=&lon=12')).status, 400);
  assert.strictEqual((await get('/api/forecast?lat=abc&lon=12')).status, 400);
});

test('nome dalla posizione', async () => {
  const body = JSON.parse((await get('/api/reverse?lat=41.8&lon=12.68')).text);
  assert.deepStrictEqual(body, { name: 'Frascati', region: 'Lazio, Italia' });
});

test('mappa: punti in un solo gruppo, arrotondati e in cache', async () => {
  const before = calls.length;
  const r = await get('/api/map?points=45.461,9.19;41.9,12.5;45.459,9.191');
  assert.strictEqual(r.status, 200);
  const body = JSON.parse(r.text);
  assert.deepStrictEqual(body.points.map((p) => [p.lat, p.lon]), [[45.46, 9.19], [41.9, 12.5]], 'arrotondati e senza doppioni');
  assert.strictEqual(calls.length - before, 1, 'un solo gruppo verso Open-Meteo');
  const u = new URL(calls[calls.length - 1]);
  assert.strictEqual(u.searchParams.get('latitude'), '45.46,41.9');
  assert.strictEqual(u.searchParams.get('longitude'), '9.19,12.5');
  assert.strictEqual(u.searchParams.get('forecast_days'), '8');
  assert.strictEqual(u.searchParams.get('timeformat'), 'unixtime');
  const p = body.points[0];
  assert.strictEqual(p.start, MAP_START);
  assert.strictEqual(p.temperature.length, 192);
  assert.ok(p.temperature.every(Number.isInteger), 'temperature intere');
  assert.strictEqual(p.precip[72], 1.2, 'pioggia a un decimale');
  assert.deepStrictEqual([p.code[0], p.is_day[12], p.wind[23], p.precip_prob[72]], [0, 1, 29, 80]);
  assert.deepStrictEqual([p.cloud[24], p.cloud[49], p.wind_dir[2], p.wind_dir.length], [50, 100, 30, 192], 'nuvolosità e direzione del vento, intere');
  assert.match(u.searchParams.get('hourly'), /cloud_cover/);

  // Di nuovo, con un punto nuovo: a Open-Meteo va solo quello (e risponde con un oggetto, non un elenco)
  const r2 = await get('/api/map?points=45.46,9.19;41.9,12.5;44.5,11.34');
  assert.deepStrictEqual(JSON.parse(r2.text).points.map((q) => q.lat), [45.46, 41.9, 44.5]);
  assert.strictEqual(calls.length - before, 2);
  assert.strictEqual(new URL(calls[calls.length - 1]).searchParams.get('latitude'), '44.5');
});

test('mappa: punti con ";" e "," codificati, come li manda la pagina', async () => {
  // Il proxy HTTPS di Tailscale toglie i parametri con ";" non codificato: la pagina usa %3B e %2C
  const r = await get('/api/map?points=' + encodeURIComponent('45.46,9.19;41.9,12.5'));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.text).points.map((p) => [p.lat, p.lon]), [[45.46, 9.19], [41.9, 12.5]]);
});

test('mappa: punti non validi', async () => {
  assert.strictEqual((await get('/api/map')).status, 400);
  assert.strictEqual((await get('/api/map?points=95,10')).status, 400);
  assert.strictEqual((await get('/api/map?points=45,abc')).status, 400);
  assert.strictEqual((await get('/api/map?points=45')).status, 400);
  const tanti = Array.from({ length: 101 }, (_, i) => `40,${i}`).join(';');
  assert.strictEqual((await get('/api/map?points=' + tanti)).status, 400);
});

test('mappa: rispetta il limite di richieste verso Open-Meteo', async () => {
  const before = calls.length;
  const tanti = Array.from({ length: 60 }, (_, i) => `30,${i}`).join(';');
  const r = await get('/api/map?points=' + tanti);
  assert.strictEqual(r.status, 429);
  assert.match(JSON.parse(r.text).error, /Troppe richieste/);
  assert.strictEqual(calls.length, before, 'niente richieste oltre il limite');
  assert.strictEqual((await get('/api/map?points=45.46,9.19')).status, 200, 'i punti in cache si leggono lo stesso');
});

test('mappa: il 429 di Open-Meteo arriva come 429', async () => {
  const r = await get('/api/map?points=10.5,10.5');
  assert.strictEqual(r.status, 429);
  assert.match(JSON.parse(r.text).error, /troppe richieste/i);
});

test('tessere della mappa: User-Agent, cache e controlli', async () => {
  const before = calls.length;
  const r = await get('/tiles/5/16/11.png');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.type, 'image/png');
  assert.strictEqual(r.text, 'finto-png');
  assert.match(r.headers['cache-control'], /max-age=86400/);
  assert.strictEqual(calls[calls.length - 1], 'https://tile.openstreetmap.org/5/16/11.png');
  assert.match(lastOptions.headers['User-Agent'], /meteo-station/);
  assert.strictEqual((await get('/tiles/5/16/11.png')).text, 'finto-png');
  assert.strictEqual(calls.length - before, 1, 'la seconda volta dalla cache');
  assert.strictEqual((await get('/tiles/5/32/11.png')).status, 400, 'x fuori dalla mappa');
  assert.strictEqual((await get('/tiles/20/0/0.png')).status, 400, 'zoom troppo alto');
  assert.strictEqual((await get('/tiles/3/1/1.png')).status, 404);
});

test('risposte compresse con gzip, se il browser le accetta', async () => {
  const gz = { 'Accept-Encoding': 'gzip, deflate, br' };
  const r = await get('/api/map?points=45.46,9.19', gz);
  assert.strictEqual(r.headers['content-encoding'], 'gzip');
  assert.strictEqual(JSON.parse(zlib.gunzipSync(r.buffer)).points.length, 1);
  const js = await get('/vendor/leaflet/leaflet.js', gz);
  assert.strictEqual(js.status, 200);
  assert.match(js.type, /javascript/);
  assert.match(zlib.gunzipSync(js.buffer).toString(), /Leaflet/);
  assert.strictEqual((await get('/healthz', gz)).headers['content-encoding'], undefined, 'le risposte piccole no');
  assert.strictEqual((await get('/api/map?points=45.46,9.19')).headers['content-encoding'], undefined);
});

const pixel = (img, x, y) => Array.from(img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

test('PNG: legge tavolozza, RGB e RGBA con tutti i filtri, e scrive PNG che rilegge uguali', () => {
  const pal = labels.decodePng(mapTileFixture());
  assert.strictEqual(pal.width, 16);
  assert.deepStrictEqual(pixel(pal, 0, 0), [242, 239, 233, 255]);
  assert.deepStrictEqual(pixel(pal, 7, 7), [34, 34, 34, 255]);
  assert.deepStrictEqual(pixel(pal, 3, 13), [112, 112, 112, 255]);
  const rgb = labels.decodePng(pngFixture(7, 6, (x, y) => [x * 30, y * 40, (x + y) * 10], { color: 2 }));
  assert.deepStrictEqual(pixel(rgb, 5, 4), [150, 160, 90, 255]);
  const rgba = labels.decodePng(pngFixture(5, 6, (x, y) => [x, y, 7, x * 50], { color: 6 }));
  assert.deepStrictEqual(pixel(rgba, 4, 3), [4, 3, 7, 200]);
  const back = labels.decodePng(labels.encodePng(rgba.width, rgba.height, rgba.rgba));
  assert.deepStrictEqual(Array.from(back.rgba), Array.from(rgba.rgba));
  assert.throws(() => labels.decodePng(Buffer.from('finto-png')), /non è un PNG/);
});

test('scritte della mappa: nere, con alone bianco, sfondo trasparente, una sola richiesta a OSM', async () => {
  const before = calls.length;
  assert.strictEqual((await get('/tiles/6/30/20.png')).status, 200);
  const r = await get('/labels/6/30/20.png');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.type, 'image/png');
  assert.strictEqual(calls.length - before, 1, 'mappa e scritte dalla stessa tessera');
  const img = labels.decodePng(r.buffer);
  assert.deepStrictEqual(pixel(img, 7, 7), [0, 0, 0, 255], 'scritta nera e piena');
  const halo = pixel(img, 4, 7);
  assert.deepStrictEqual(halo.slice(0, 3), [255, 255, 255], 'alone bianco');
  assert.ok(halo[3] > 200 && halo[3] < 230, 'alone quasi pieno: ' + halo[3]);
  assert.strictEqual(pixel(img, 0, 0)[3], 0, 'sfondo trasparente');
  assert.strictEqual(pixel(img, 3, 7)[3], 0, 'oltre l\'alone, trasparente');
  const rail = pixel(img, 1, 13);
  assert.ok(rail[3] > 90 && rail[0] < 128, 'la ferrovia grigia resta, più leggera: ' + rail);
});

test('scritte: se la tessera non si legge arriva una tessera trasparente', async () => {
  const r = await get('/labels/5/16/11.png');
  assert.strictEqual(r.status, 200);
  const img = labels.decodePng(r.buffer);
  assert.strictEqual(img.width, 256);
  assert.ok(img.rgba.every((v, i) => i % 4 !== 3 || v === 0));
  assert.strictEqual((await get('/labels/3/1/1.png')).status, 404);
  assert.strictEqual((await get('/labels/20/0/0.png')).status, 400);
});
