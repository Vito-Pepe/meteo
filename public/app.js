(function () {
  'use strict';

  var STORAGE_KEY = 'meteo:lastPlace';
  var REFRESH_MS = 15 * 60 * 1000;
  var COL = 60; // larghezza in px di una colonna oraria (grafico + celle)

  // Codici meteo WMO usati da Open-Meteo.
  var WMO = {
    0: ['Sereno', '☀️', '🌙'],
    1: ['Prevalentemente sereno', '🌤️', '🌙'],
    2: ['Parzialmente nuvoloso', '⛅', '☁️'],
    3: ['Coperto', '☁️', '☁️'],
    45: ['Nebbia', '🌫️', '🌫️'],
    48: ['Nebbia con brina', '🌫️', '🌫️'],
    51: ['Pioviggine leggera', '🌦️', '🌧️'],
    53: ['Pioviggine', '🌦️', '🌧️'],
    55: ['Pioviggine intensa', '🌧️', '🌧️'],
    56: ['Pioviggine gelata', '🌧️', '🌧️'],
    57: ['Pioviggine gelata intensa', '🌧️', '🌧️'],
    61: ['Pioggia debole', '🌦️', '🌧️'],
    63: ['Pioggia', '🌧️', '🌧️'],
    65: ['Pioggia forte', '🌧️', '🌧️'],
    66: ['Pioggia gelata', '🌧️', '🌧️'],
    67: ['Pioggia gelata forte', '🌧️', '🌧️'],
    71: ['Neve debole', '🌨️', '🌨️'],
    73: ['Neve', '🌨️', '🌨️'],
    75: ['Neve forte', '❄️', '❄️'],
    77: ['Granelli di neve', '🌨️', '🌨️'],
    80: ['Rovesci deboli', '🌦️', '🌧️'],
    81: ['Rovesci', '🌧️', '🌧️'],
    82: ['Rovesci violenti', '⛈️', '⛈️'],
    85: ['Rovesci di neve', '🌨️', '🌨️'],
    86: ['Rovesci di neve forti', '❄️', '❄️'],
    95: ['Temporale', '⛈️', '⛈️'],
    96: ['Temporale con grandine', '⛈️', '⛈️'],
    99: ['Temporale con grandine forte', '⛈️', '⛈️'],
  };
  var DAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
  var MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

  var state = { place: null, data: null, day: 0, loading: false };
  var $ = function (id) { return document.getElementById(id); };

  // --- utilità ----------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function wmo(code, isDay) {
    var w = WMO[code] || ['—', '🌡️', '🌡️'];
    return { text: w[0], icon: isDay === 0 ? w[2] : w[1] };
  }
  function round(n) { return n == null ? '–' : Math.round(n); }
  function deg(n) { return n == null ? '–' : Math.round(n) + '°'; }
  function one(n) { return n == null ? '–' : (Math.round(n * 10) / 10).toLocaleString('it-IT'); }
  function compass(d) { return d == null ? '' : COMPASS[Math.round(d / 45) % 8]; }
  function hhmm(iso) { return iso ? iso.slice(11, 16) : '–'; }
  function parseDate(ymd) {
    var p = ymd.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function dayLabel(ymd, index, long) {
    if (index === 0) return 'Oggi';
    if (index === 1) return 'Domani';
    var d = parseDate(ymd);
    var name = DAYS[d.getDay()];
    if (!long) name = name.slice(0, 3);
    return name.charAt(0).toUpperCase() + name.slice(1) + ' ' + d.getDate() + (long ? ' ' + MONTHS[d.getMonth()] : '');
  }
  function windArrow(dir) {
    if (dir == null) return '';
    // La direzione indica da dove soffia il vento: la freccia punta dove va.
    return '<span class="arrow" style="transform:rotate(' + (dir + 180) + 'deg)">↑</span>';
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || 'Errore ' + res.status);
        return body;
      });
    });
  }

  function savePlace(place) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(place)); } catch (e) { /* storage non disponibile */ }
  }
  function loadSavedPlace() {
    try {
      var p = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (p && typeof p.latitude === 'number' && typeof p.longitude === 'number') return p;
    } catch (e) { /* ignorato */ }
    return null;
  }

  function showMessage(html) {
    var m = $('message');
    m.innerHTML = html;
    m.hidden = false;
  }
  function hideMessage() { $('message').hidden = true; }

  // --- caricamento dati -------------------------------------------------

  function loadPlace(place, opts) {
    opts = opts || {};
    state.place = place;
    if (!opts.keepDay) state.day = 0;
    state.loading = true;
    if (!state.data || !opts.silent) {
      showMessage('<div class="spinner"></div><p>Carico il meteo di <strong>' + esc(place.name) + '</strong>…</p>');
      $('weather').hidden = true;
    }
    return getJson('api/forecast?lat=' + place.latitude + '&lon=' + place.longitude)
      .then(function (data) {
        state.data = data;
        state.loading = false;
        savePlace(place);
        hideMessage();
        render();
      })
      .catch(function (err) {
        state.loading = false;
        if (opts.silent && state.data) return; // un refresh fallito non cancella i dati mostrati
        showMessage('<p>⚠️ ' + esc(err.message) + '</p><button class="btn" id="retry-btn">Riprova</button>');
        $('retry-btn').onclick = function () { loadPlace(place); };
      });
  }

  function locate(fallback) {
    if (!('geolocation' in navigator)) return fallback('Questo browser non supporta la geolocalizzazione.');
    if (window.isSecureContext === false) {
      return fallback('La posizione è disponibile solo aprendo la pagina in HTTPS.');
    }
    showMessage('<div class="spinner"></div><p>Rilevo la tua posizione…</p>');
    $('weather').hidden = true;
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var lat = Math.round(pos.coords.latitude * 1000) / 1000;
        var lon = Math.round(pos.coords.longitude * 1000) / 1000;
        var place = { name: 'La tua posizione', region: lat + ', ' + lon, latitude: lat, longitude: lon, gps: true };
        loadPlace(place);
        getJson('api/reverse?lat=' + lat + '&lon=' + lon).then(function (r) {
          if (!r.name || state.place !== place) return;
          place.name = r.name;
          place.region = r.region;
          savePlace(place);
          renderPlace();
        }).catch(function () { /* resta "La tua posizione" */ });
      },
      function (err) {
        var why = err.code === 1 ? 'Accesso alla posizione negato.' : 'Posizione non disponibile.';
        fallback(why);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 }
    );
  }

  function noLocation(reason) {
    var saved = loadSavedPlace();
    if (saved) return loadPlace(saved);
    showMessage('<p class="big">📍</p><p>' + esc(reason) + '</p><p class="muted">Cerca una località qui sopra.</p>');
    $('weather').hidden = true;
    $('search-input').focus();
  }

  // --- render -----------------------------------------------------------

  function render() {
    var d = state.data;
    if (!d) return;
    $('weather').hidden = false;
    renderPlace();
    renderNow(d);
    renderDay(d);
    renderWeek(d);
    $('updated').textContent = hhmm(d.current && d.current.time);
  }

  function renderPlace() {
    $('place-name').textContent = state.place.name;
    $('place-region').textContent = state.place.region || '';
    document.title = 'Meteo · ' + state.place.name;
  }

  function renderNow(d) {
    var c = d.current;
    var daily = d.daily;
    var w = wmo(c.weather_code, c.is_day);
    $('now').innerHTML =
      '<div class="now-main">' +
        '<div class="now-icon">' + w.icon + '</div>' +
        '<div>' +
          '<div class="now-temp">' + round(c.temperature_2m) + '<span>°C</span></div>' +
          '<div class="now-desc">' + esc(w.text) + '</div>' +
          '<div class="muted">Percepita ' + deg(c.apparent_temperature) +
            ' · Max ' + deg(daily.temperature_2m_max[0]) + ' · Min ' + deg(daily.temperature_2m_min[0]) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="stats">' +
        stat('Vento', windArrow(c.wind_direction_10m) + round(c.wind_speed_10m) + ' km/h ' + compass(c.wind_direction_10m)) +
        stat('Raffiche', round(c.wind_gusts_10m) + ' km/h') +
        stat('Umidità', round(c.relative_humidity_2m) + '%') +
        stat('Pressione', round(c.pressure_msl) + ' hPa') +
        stat('Nuvolosità', round(c.cloud_cover) + '%') +
        stat('Precipitazioni', one(c.precipitation) + ' mm') +
      '</div>';
  }

  function stat(label, value) {
    return '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + '</div></div>';
  }

  function hourIndexes(d) {
    var h = d.hourly;
    var date = d.daily.time[state.day];
    var idx = [];
    if (state.day === 0) {
      // Oggi: le prossime 24 ore a partire dall'ora corrente.
      var nowKey = d.current.time.slice(0, 13);
      var start = 0;
      for (var i = 0; i < h.time.length; i++) {
        if (h.time[i].slice(0, 13) >= nowKey) { start = i; break; }
      }
      for (var j = start; j < Math.min(start + 24, h.time.length); j++) idx.push(j);
    } else {
      for (var k = 0; k < h.time.length; k++) if (h.time[k].slice(0, 10) === date) idx.push(k);
    }
    return idx;
  }

  function renderDay(d) {
    var i = state.day;
    var daily = d.daily;
    var w = wmo(daily.weather_code[i], 1);
    $('day-title').textContent = i === 0 ? 'Oggi · prossime 24 ore' : dayLabel(daily.time[i], i, true) + ' · ora per ora';
    $('day-summary').textContent = w.icon + ' ' + w.text;
    $('day-stats').innerHTML =
      stat('Max / Min', deg(daily.temperature_2m_max[i]) + ' / ' + deg(daily.temperature_2m_min[i])) +
      stat('Pioggia', one(daily.precipitation_sum[i]) + ' mm · ' + round(daily.precipitation_probability_max[i]) + '%') +
      stat('Vento max', windArrow(daily.wind_direction_10m_dominant[i]) + round(daily.wind_speed_10m_max[i]) + ' km/h') +
      stat('Raffiche max', round(daily.wind_gusts_10m_max[i]) + ' km/h') +
      stat('UV max', one(daily.uv_index_max[i])) +
      stat('Alba / Tramonto', hhmm(daily.sunrise[i]) + ' / ' + hhmm(daily.sunset[i]));

    var idx = hourIndexes(d);
    var h = d.hourly;
    var cells = idx.map(function (k) {
      var hw = wmo(h.weather_code[k], h.is_day[k]);
      var p = h.precipitation_probability[k];
      return '<div class="hour" title="' + esc(hw.text) + '">' +
        '<div class="h-time">' + hhmm(h.time[k]) + '</div>' +
        '<div class="h-icon">' + hw.icon + '</div>' +
        '<div class="h-temp">' + deg(h.temperature_2m[k]) + '</div>' +
        '<div class="h-feel muted">' + deg(h.apparent_temperature[k]) + '</div>' +
        '<div class="h-rain' + (p >= 30 ? ' wet' : '') + '">' + round(p) + '%</div>' +
        '<div class="h-mm muted">' + (h.precipitation[k] > 0 ? one(h.precipitation[k]) + ' mm' : '–') + '</div>' +
        '<div class="h-wind">' + windArrow(h.wind_direction_10m[k]) + round(h.wind_speed_10m[k]) + '</div>' +
        '<div class="h-hum muted">' + round(h.relative_humidity_2m[k]) + '%</div>' +
      '</div>';
    }).join('');

    $('hours').innerHTML =
      '<div class="hours-inner" style="width:' + (idx.length * COL + 56) + 'px">' +
        '<div class="hours-legend muted">' +
          '<div class="lg-chart"></div><div>Ora</div><div class="lg-icon"></div><div>Temp</div><div>Perc.</div>' +
          '<div>Pioggia</div><div>mm</div><div>km/h</div><div>Umid.</div>' +
        '</div>' +
        '<div class="hours-cols">' + chart(idx.map(function (k) { return h.temperature_2m[k]; }),
          idx.map(function (k) { return h.precipitation_probability[k]; })) +
          '<div class="hours-row">' + cells + '</div>' +
        '</div>' +
      '</div>';
    $('hours').scrollLeft = 0;
  }

  // Grafico SVG: linea della temperatura e barre di probabilità di pioggia.
  function chart(temps, probs) {
    var n = temps.length;
    if (!n) return '';
    var W = n * COL, H = 90, top = 18, bottom = 14;
    var valid = temps.filter(function (t) { return t != null; });
    var min = Math.min.apply(null, valid), max = Math.max.apply(null, valid);
    if (max - min < 4) { var mid = (max + min) / 2; min = mid - 2; max = mid + 2; }
    var x = function (i) { return i * COL + COL / 2; };
    var y = function (t) { return top + (1 - (t - min) / (max - min)) * (H - top - bottom); };

    var bars = probs.map(function (p, i) {
      if (!p) return '';
      var bh = (p / 100) * (H - 4);
      return '<rect x="' + (i * COL + 8) + '" y="' + (H - bh) + '" width="' + (COL - 16) + '" height="' + bh + '" rx="3" class="c-bar"/>';
    }).join('');
    var pts = [];
    temps.forEach(function (t, i) { if (t != null) pts.push(x(i).toFixed(1) + ',' + y(t).toFixed(1)); });
    var area = 'M' + pts[0] + ' L' + pts.join(' L') + ' L' + x(n - 1) + ',' + H + ' L' + x(0) + ',' + H + ' Z';
    var labels = temps.map(function (t, i) {
      return t == null ? '' : '<text x="' + x(i) + '" y="' + (y(t) - 6).toFixed(1) + '" class="c-label">' + Math.round(t) + '°</text>';
    }).join('');

    return '<svg class="chart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
      '<path d="' + area + '" class="c-area"/>' +
      bars +
      '<polyline points="' + pts.join(' ') + '" class="c-line"/>' +
      labels +
    '</svg>';
  }

  function renderWeek(d) {
    var daily = d.daily;
    var lo = Math.min.apply(null, daily.temperature_2m_min.filter(function (v) { return v != null; }));
    var hi = Math.max.apply(null, daily.temperature_2m_max.filter(function (v) { return v != null; }));
    var span = Math.max(hi - lo, 1);
    $('week').innerHTML = daily.time.map(function (t, i) {
      var w = wmo(daily.weather_code[i], 1);
      var tmin = daily.temperature_2m_min[i], tmax = daily.temperature_2m_max[i];
      var left = ((tmin - lo) / span) * 100, width = Math.max(((tmax - tmin) / span) * 100, 4);
      var p = daily.precipitation_probability_max[i];
      return '<li><button type="button" class="day' + (i === state.day ? ' active' : '') + '" data-day="' + i + '" aria-pressed="' + (i === state.day) + '">' +
        '<span class="d-name">' + dayLabel(t, i, false) + '</span>' +
        '<span class="d-icon" title="' + esc(w.text) + '">' + w.icon + '</span>' +
        '<span class="d-rain' + (p >= 30 ? ' wet' : '') + '">' + (p ? '💧' + round(p) + '%' : '') + '</span>' +
        '<span class="d-min muted">' + deg(tmin) + '</span>' +
        '<span class="d-range"><span style="left:' + left + '%;width:' + width + '%"></span></span>' +
        '<span class="d-max">' + deg(tmax) + '</span>' +
        '<span class="d-extra muted">' + esc(w.text) + ' · ' + windArrow(daily.wind_direction_10m_dominant[i]) +
          round(daily.wind_speed_10m_max[i]) + ' km/h · ' + one(daily.precipitation_sum[i]) + ' mm</span>' +
      '</button></li>';
    }).join('');
  }

  $('week').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-day]');
    if (!btn || !state.data) return;
    state.day = +btn.getAttribute('data-day');
    renderDay(state.data);
    renderWeek(state.data);
    $('day-title').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // --- ricerca ----------------------------------------------------------

  var searchTimer = null, searchSeq = 0, results = [], active = -1;

  function renderResults() {
    var ul = $('search-results');
    if (!results.length) { ul.hidden = true; ul.innerHTML = ''; return; }
    ul.innerHTML = results.map(function (r, i) {
      if (r.empty) return '<li class="empty muted">' + esc(r.empty) + '</li>';
      return '<li role="option" data-i="' + i + '" class="' + (i === active ? 'active' : '') + '">' +
        '<strong>' + esc(r.name) + '</strong> <span class="muted">' + esc(r.region) + '</span></li>';
    }).join('');
    ul.hidden = false;
  }

  function closeResults() { results = []; active = -1; renderResults(); }

  function choose(r) {
    if (!r || r.empty) return;
    closeResults();
    $('search-input').value = '';
    $('search-input').blur();
    loadPlace({ name: r.name, region: r.region, latitude: r.latitude, longitude: r.longitude });
  }

  function search(q) {
    var seq = ++searchSeq;
    getJson('api/search?q=' + encodeURIComponent(q)).then(function (body) {
      if (seq !== searchSeq) return;
      results = body.results.length ? body.results : [{ empty: 'Nessuna località trovata' }];
      active = body.results.length ? 0 : -1;
      renderResults();
    }).catch(function (err) {
      if (seq !== searchSeq) return;
      results = [{ empty: err.message }];
      active = -1;
      renderResults();
    });
  }

  $('search-input').addEventListener('input', function (e) {
    var q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { searchSeq++; closeResults(); return; }
    searchTimer = setTimeout(function () { search(q); }, 250);
  });

  $('search-input').addEventListener('keydown', function (e) {
    var selectable = results.filter(function (r) { return !r.empty; }).length;
    if (e.key === 'ArrowDown' && selectable) { active = (active + 1) % selectable; renderResults(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && selectable) { active = (active - 1 + selectable) % selectable; renderResults(); e.preventDefault(); }
    else if (e.key === 'Escape') closeResults();
  });

  $('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (active >= 0) choose(results[active]);
    else {
      var q = $('search-input').value.trim();
      if (q.length >= 2) { clearTimeout(searchTimer); search(q); }
    }
  });

  $('search-results').addEventListener('mousedown', function (e) {
    var li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); choose(results[+li.getAttribute('data-i')]); }
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('#search-form')) closeResults();
  });

  $('locate-btn').addEventListener('click', function () {
    locate(function (reason) {
      if (state.data) { render(); hideMessage(); alert(reason); }
      else noLocation(reason);
    });
  });

  // --- avvio ------------------------------------------------------------

  setInterval(function () {
    if (state.place && !state.loading && document.visibilityState === 'visible') {
      loadPlace(state.place, { silent: true, keepDay: true });
    }
  }, REFRESH_MS);

  locate(noLocation);
})();
