'use strict';

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

module.exports = { forecastFixture, searchFixture, mapFixture, MAP_START };
