'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { forecastFixture, searchFixture } = require('./fixture');

const calls = [];
global.fetch = async (url) => {
  calls.push(String(url));
  const u = new URL(url);
  let body;
  if (u.host === 'api.open-meteo.com') body = forecastFixture();
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
const get = (p) => new Promise((resolve, reject) => {
  http.get(base + p, (res) => {
    let text = '';
    res.on('data', (c) => (text += c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }));
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
