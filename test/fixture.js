'use strict';

const zlib = require('node:zlib');

// Risposta finta di Open-Meteo, usata dai test (le API reali non servono).
function forecastFixture() {
  const days = [], hours = [];
  for (let d = 0; d < 7; d++) {
    const ymd = `2026-10-${String(23 + d).padStart(2, '0')}`;
    days.push(ymd);
    for (let h = 0; h < 24; h++) hours.push(`${ymd}T${String(h).padStart(2, '0')}:00`);
  }
  const H = (fn) => hours.map((_, i) => fn(i % 24, Math.floor(i / 24)));
  const D = (fn) => days.map((_, d) => fn(d));
  const codes = [0, 2, 3, 61, 80, 95, 1];
  return {
    current: {
      time: '2026-10-23T14:45', temperature_2m: 18.4, relative_humidity_2m: 62, apparent_temperature: 17.1,
      is_day: 1, precipitation: 0, weather_code: 2, cloud_cover: 40, pressure_msl: 1016.2,
      wind_speed_10m: 12.3, wind_direction_10m: 225, wind_gusts_10m: 25.1,
    },
    hourly: {
      time: hours,
      temperature_2m: H((h, d) => 12 + d + 7 * Math.sin(((h - 8) / 24) * 2 * Math.PI)),
      apparent_temperature: H((h, d) => 11 + d + 7 * Math.sin(((h - 8) / 24) * 2 * Math.PI)),
      relative_humidity_2m: H((h) => 60 + (h % 10)),
      precipitation_probability: H((h, d) => (d === 3 || (d === 0 && h > 17) ? 70 : h % 7 === 0 ? 20 : 0)),
      precipitation: H((h, d) => (d === 3 ? 1.2 : 0)),
      weather_code: H((h, d) => codes[d]),
      cloud_cover: H(() => 40),
      wind_speed_10m: H((h) => 8 + (h % 5)),
      wind_direction_10m: H((h) => h * 15),
      wind_gusts_10m: H((h) => 15 + h),
      uv_index: H((h) => (h > 7 && h < 18 ? 3 : 0)),
      is_day: H((h) => (h >= 7 && h < 18 ? 1 : 0)),
    },
    daily: {
      time: days,
      weather_code: codes,
      temperature_2m_max: D((d) => 19 + d), temperature_2m_min: D((d) => 5 + d),
      apparent_temperature_max: D((d) => 18 + d), apparent_temperature_min: D((d) => 4 + d),
      precipitation_sum: D((d) => (d === 3 ? 12.5 : 0)),
      precipitation_probability_max: D((d) => (d === 3 ? 90 : d * 5)),
      precipitation_hours: D((d) => (d === 3 ? 8 : 0)),
      wind_speed_10m_max: D((d) => 15 + d), wind_gusts_10m_max: D((d) => 30 + d),
      wind_direction_10m_dominant: D((d) => d * 40),
      sunrise: D((d) => `${days[d]}T07:25`), sunset: D((d) => `${days[d]}T18:10`),
      uv_index_max: D(() => 3.4),
    },
  };
}

const searchFixture = {
  results: [
    { name: 'Roma', admin1: 'Lazio', country: 'Italia', country_code: 'IT', latitude: 41.89193, longitude: 12.51133 },
    { name: 'Roma', admin1: 'Queensland', country: 'Australia', country_code: 'AU', latitude: -26.56, longitude: 148.78 },
  ],
};

// Risposta finta di Open-Meteo per la mappa: serie oraria di 8 giorni da mezzanotte UTC,
// orari in secondi Unix. Con un punto solo Open-Meteo risponde con un oggetto, con più punti con un elenco.
const MAP_START = Date.UTC(2026, 9, 30) / 1000;

function mapPointFixture(lat, lon) {
  const time = Array.from({ length: 192 }, (_, i) => MAP_START + i * 3600);
  const H = (fn) => time.map((_, i) => fn(i % 24, Math.floor(i / 24)));
  return {
    latitude: lat,
    longitude: lon,
    hourly: {
      time,
      temperature_2m: H((h, d) => 10.4 + lat / 10 + d + 6 * Math.sin(((h - 9) / 24) * 2 * Math.PI)),
      weather_code: H((h, d) => [0, 2, 3, 61, 80, 95, 71, 1][d]),
      precipitation_probability: H((h, d) => (d === 3 ? 80 : 10)),
      precipitation: H((h, d) => (d === 3 ? 1.234 : 0)),
      is_day: H((h) => (h >= 6 && h < 17 ? 1 : 0)),
      wind_speed_10m: H((h) => 5.6 + h),
      wind_direction_10m: H((h) => (h * 15 + 0.4) % 360),
      cloud_cover: H((h, d) => [0, 50, 100, 100, 90, 100, 100, 20][d] - (h % 2 ? 0.4 : 0)),
    },
  };
}

function mapFixture(lats, lons) {
  const list = lats.map((lat, i) => mapPointFixture(lat, lons[i]));
  return list.length === 1 ? list[0] : list;
}

// PNG per i test, con un filtro diverso per ogni riga (0-4) come fanno i PNG veri.
// color 3: tavolozza (pixel = indice), 2: RGB, 6: RGBA (pixel = elenco di canali).
function pngFixture(width, height, pixel, { color = 3, palette = [] } = {}) {
  const channels = color === 3 ? 1 : color === 2 ? 3 : 4;
  const stride = width * channels;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) [].concat(pixel(x, y)).forEach((v, k) => { cur[x * channels + k] = v; });
    const filter = y % 5;
    const line = Buffer.alloc(stride + 1);
    line[0] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i + 1] = (cur[i] - p) & 255;
    }
    rows.push(line);
    prev = cur;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = color;
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (color === 3) parts.push(chunk('PLTE', Buffer.from(palette.flat())));
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// Tessera come quelle di OpenStreetMap, 32x32, sfondo chiaro: una "scritta" scura 4x4 con accanto
// una lettera sottile (la "l", a cavallo di due pixel) e il pezzo grigio chiaro del bordo di una
// strada piccola, poi una ferrovia grigia, il bordo colorato di una strada e una macchia grigia
// lontana dal testo
function mapTileFixture() {
  return pngFixture(32, 32, (x, y) => {
    if (x >= 6 && x <= 9 && y >= 6 && y <= 9) return 1;
    if (x === 12 && y >= 5 && y <= 10) return 3;
    if (x === 4 && y >= 5 && y <= 9) return 5;
    if (y === 20) return 2;
    if (x === 26) return 4;
    if (x >= 2 && x <= 3 && y >= 28 && y <= 29) return 5;
    return 0;
  }, {
    palette: [[242, 239, 233], [34, 34, 34], [112, 112, 112], [118, 118, 118], [160, 107, 0], [143, 143, 143]],
  });
}

module.exports = { forecastFixture, searchFixture, mapFixture, MAP_START, pngFixture, mapTileFixture };
