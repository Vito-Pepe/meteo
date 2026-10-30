(function () {
  'use strict';

  // Mappa del meteo: una griglia di punti sulla parte visibile, con il simbolo del tempo e la
  // temperatura all'ora scelta. Ogni punto arriva con 8 giorni ora per ora, quindi cambiare
  // giorno e ora non chiede niente al server: solo spostando la mappa arrivano i punti nuovi.

  var A = window.MeteoApp;
  if (!A || !window.L) return;

  var MIN_ZOOM = 4, MAX_ZOOM = 13, START_ZOOM = 8;
  // Oltre lo zoom 11 i modelli meteo non hanno più dettaglio: la griglia resta quella dell'11.
  var GRID_MIN_ZOOM = 4, GRID_MAX_ZOOM = 11;
  var MAX_POINTS = 100; // per richiesta, come il server
  var STALE_MS = 30 * 60 * 1000; // dopo mezz'ora un punto si richiede (il server lo tiene un'ora)
  var CACHE_MAX = 3000;
  var DEFAULT_CENTER = [42.5, 12.5]; // l'Italia, finché non c'è un luogo
  var DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  var MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  // Colori della temperatura, dal viola del gelo al rosso scuro del caldo forte.
  var COLORS = [
    [-20, [91, 42, 134]], [-10, [59, 76, 192]], [0, [79, 157, 224]], [8, [87, 196, 192]], [14, [143, 209, 106]],
    [20, [244, 211, 74]], [25, [246, 162, 60]], [30, [236, 106, 53]], [35, [210, 47, 47]], [40, [142, 21, 56]],
  ];
  var ICON = L.divIcon({
    className: 'mm-point',
    html: '<span class="mm-icon"></span><span class="mm-temp"></span>',
    iconSize: [56, 48],
    iconAnchor: [28, 24],
  });

  var $ = function (id) { return document.getElementById(id); };
  var map = null, layer = null, here = null, popup = null, popupKey = null;
  var spacing = 96; // distanza tra i punti, in pixel
  var data = new Map(); // "lat,lon" -> { p: dati del punto, at: quando sono arrivati }
  var markers = new Map(); // "lat,lon" -> marker sulla mappa
  var pending = {}; // "lat,lon" -> true mentre arriva
  var loading = 0, failed = null, moveTimer = null, frame = 0;
  var place = null, centerOnShow = false;
  var sel = { day: 0, hour: new Date().getHours() };

  // --- utilità ----------------------------------------------------------

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function round2(n) { return Math.round(n * 100) / 100; }

  function dayLabel(date, d, long) {
    if (d === 0) return 'Oggi';
    if (d === 1) return 'Domani';
    return DAYS[date.getDay()] + ' ' + date.getDate() + (long ? ' ' + MONTHS[date.getMonth()] : '');
  }

  function selectedDate() {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + sel.day, sel.hour);
  }

  // Posizione dell'ora scelta nella serie del punto (-1 se fuori)
  function indexAt(p, time) {
    if (p.start == null) return -1;
    var i = Math.round((time - p.start) / 3600);
    return i >= 0 && i < p.temperature.length ? i : -1;
  }

  function tempColor(t) {
    var c = COLORS[COLORS.length - 1][1];
    if (t <= COLORS[0][0]) c = COLORS[0][1];
    else {
      for (var i = 1; i < COLORS.length; i++) {
        if (t <= COLORS[i][0]) {
          var a = COLORS[i - 1], b = COLORS[i], f = (t - a[0]) / (b[0] - a[0]);
          c = [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * f); });
          break;
        }
      }
    }
    var light = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.6;
    return { bg: 'rgb(' + c.join(',') + ')', fg: light ? '#0f172a' : '#ffffff' };
  }

  function status(text) {
    $('map-status').textContent = text || '';
    $('map-status').hidden = !text;
  }

  // --- griglia e dati ---------------------------------------------------

  function gridZoom() {
    return Math.max(GRID_MIN_ZOOM, Math.min(GRID_MAX_ZOOM, Math.round(map.getZoom())));
  }

  // Punti della griglia nella parte visibile, con mezzo passo di margine. La griglia è fatta in
  // pixel allo zoom della griglia: i punti di uno zoom sono anche in quello dopo, quindi
  // allontanandosi tornano dalla cache.
  function visibleGrid() {
    var gz = gridZoom();
    var scale = Math.pow(2, gz - map.getZoom());
    var b = map.getPixelBounds();
    var half = spacing / 2;
    var x0 = Math.ceil((b.min.x * scale - half) / spacing), x1 = Math.floor((b.max.x * scale + half) / spacing);
    var y0 = Math.ceil((b.min.y * scale - half) / spacing), y1 = Math.floor((b.max.y * scale + half) / spacing);
    var out = [];
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var ll = map.unproject([x * spacing, y * spacing], gz);
        if (ll.lat < -85 || ll.lat > 85 || ll.lng < -180 || ll.lng > 180) continue;
        var lat = round2(ll.lat), lon = round2(ll.lng);
        out.push({ key: lat + ',' + lon, lat: lat, lon: lon, ll: ll });
      }
    }
    return out;
  }

  function remember(key, value) {
    data.delete(key);
    data.set(key, value);
    if (data.size > CACHE_MAX) data.delete(data.keys().next().value);
  }

  function refresh() {
    if (!map || $('view-map').hidden) return;
    var now = Date.now();
    var need = visibleGrid().filter(function (g) {
      var d = data.get(g.key);
      return !pending[g.key] && (!d || now - d.at > STALE_MS);
    });
    draw();
    for (var i = 0; i < need.length; i += MAX_POINTS) load(need.slice(i, i + MAX_POINTS));
  }

  function load(points) {
    points.forEach(function (g) { pending[g.key] = true; });
    loading++;
    status('Carico il meteo…');
    A.getJson('/api/map?points=' + points.map(function (g) { return g.lat + ',' + g.lon; }).join(';'))
      .then(function (body) {
        var at = Date.now();
        body.points.forEach(function (p) { remember(p.lat + ',' + p.lon, { p: p, at: at }); });
        failed = null;
      })
      .catch(function (err) { failed = err.message; })
      .then(function () {
        points.forEach(function (g) { delete pending[g.key]; });
        loading--;
        if (!loading) status(failed ? '⚠️ ' + failed : '');
        draw();
      });
  }

  // --- simboli sulla mappa ----------------------------------------------

  function paint(marker, p, time) {
    var el = marker.getElement();
    if (!el) return;
    var i = indexAt(p, time);
    var temp = i < 0 ? null : p.temperature[i];
    var icon = el.firstChild, label = el.lastChild;
    if (temp == null) {
      el.classList.add('mm-empty');
      icon.textContent = '';
      label.textContent = '–';
      label.style.background = '';
      label.style.color = '';
      el.title = 'Nessun dato per quest\'ora';
      return;
    }
    var w = A.wmo(p.code[i], p.is_day[i]);
    var c = tempColor(temp);
    el.classList.remove('mm-empty');
    icon.textContent = w.icon;
    label.textContent = temp + '°';
    label.style.background = c.bg;
    label.style.color = c.fg;
    el.title = w.text + ', ' + temp + '°';
  }

  function draw() {
    if (!map) return;
    var time = selectedDate().getTime() / 1000;
    var seen = new Set();
    visibleGrid().forEach(function (g) {
      var d = data.get(g.key);
      if (!d) return;
      seen.add(g.key);
      var m = markers.get(g.key);
      if (!m) {
        m = L.marker(g.ll, { icon: ICON, keyboard: false, riseOnHover: true });
        m.on('click', function () { openPopup(m, g.key); });
        m.addTo(layer);
        markers.set(g.key, m);
      }
      paint(m, d.p, time);
    });
    markers.forEach(function (m, key) {
      if (!seen.has(key)) {
        layer.removeLayer(m);
        markers.delete(key);
      }
    });
    if (popup && map.hasLayer(popup)) popup.setContent(popupHtml(popupKey));
  }

  // --- scheda del punto -------------------------------------------------

  function popupHtml(key) {
    var d = data.get(key);
    var when = dayLabel(selectedDate(), sel.day, true) + ' · ' + pad(sel.hour) + ':00';
    var button = '<button type="button" class="btn mm-pop-btn" data-key="' + key + '">Previsioni di qui</button>';
    var i = d ? indexAt(d.p, selectedDate().getTime() / 1000) : -1;
    if (i < 0 || d.p.temperature[i] == null) {
      return '<div class="mm-pop"><div class="mm-pop-when">' + A.esc(when) + '</div><p>Nessun dato per quest\'ora.</p>' + button + '</div>';
    }
    var p = d.p;
    var w = A.wmo(p.code[i], p.is_day[i]);
    var prob = p.precip_prob[i], mm = p.precip[i], wind = p.wind[i];
    return '<div class="mm-pop">' +
      '<div class="mm-pop-when">' + A.esc(when) + '</div>' +
      '<div class="mm-pop-main"><span class="mm-pop-icon">' + w.icon + '</span>' +
        '<span><strong>' + p.temperature[i] + '°</strong> ' + A.esc(w.text) + '</span></div>' +
      '<div class="mm-pop-row">Pioggia ' + (prob == null ? '–' : prob + '%') + ' · ' +
        (mm == null ? '–' : mm.toLocaleString('it-IT') + ' mm') + '</div>' +
      '<div class="mm-pop-row">Vento ' + (wind == null ? '–' : wind + ' km/h') + '</div>' +
      button +
    '</div>';
  }

  function openPopup(marker, key) {
    popupKey = key;
    popup = L.popup({ offset: [0, -16], maxWidth: 260, autoPanPadding: [16, 16] })
      .setLatLng(marker.getLatLng())
      .setContent(popupHtml(key))
      .openOn(map);
  }

  // Leaflet ferma i clic dentro le schede: si ascoltano prima, in fase di cattura.
  function onPopupButton(e) {
    var b = e.target.closest && e.target.closest('.mm-pop-btn');
    if (!b) return;
    var k = b.getAttribute('data-key').split(',');
    map.closePopup();
    A.openPoint(Number(k[0]), Number(k[1]));
  }

  // --- giorno e ora -----------------------------------------------------

  function renderControls() {
    var now = new Date();
    var min = sel.day === 0 ? now.getHours() : 0;
    if (sel.hour < min) sel.hour = min;
    var html = '';
    for (var d = 0; d < 7; d++) {
      var date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      html += '<button type="button" class="map-day' + (d === sel.day ? ' active' : '') + '" data-day="' + d +
        '" aria-pressed="' + (d === sel.day) + '">' + dayLabel(date, d, false) + '</button>';
    }
    $('map-days').innerHTML = html;
    var range = $('map-hour');
    range.min = String(min);
    range.max = '23';
    range.value = String(sel.hour);
    range.setAttribute('aria-valuetext', dayLabel(selectedDate(), sel.day, true) + ', ore ' + pad(sel.hour) + ':00');
    $('map-hour-text').textContent = pad(sel.hour) + ':00';
    $('map-prev').disabled = sel.day === 0 && sel.hour <= min;
    $('map-next').disabled = sel.day === 6 && sel.hour >= 23;
    $('map-now').hidden = sel.day === 0 && sel.hour === now.getHours();
  }

  function changed() {
    renderControls();
    if (frame) return;
    frame = requestAnimationFrame(function () { frame = 0; draw(); });
  }

  function step(delta) {
    var h = sel.hour + delta, d = sel.day;
    if (h < 0) { if (d === 0) return; d--; h = 23; }
    if (h > 23) { if (d === 6) return; d++; h = 0; }
    sel.day = d;
    sel.hour = h;
    changed();
  }

  $('map-days').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-day]');
    if (!b) return;
    sel.day = Number(b.getAttribute('data-day'));
    changed();
  });
  $('map-hour').addEventListener('input', function (e) { sel.hour = Number(e.target.value); changed(); });
  $('map-prev').addEventListener('click', function () { step(-1); });
  $('map-next').addEventListener('click', function () { step(1); });
  $('map-now').addEventListener('click', function () {
    sel.day = 0;
    sel.hour = new Date().getHours();
    changed();
  });

  // --- mappa ------------------------------------------------------------

  function setHere(p) {
    var ll = [p.latitude, p.longitude];
    if (here) here.setLatLng(ll);
    else {
      here = L.circleMarker(ll, {
        radius: 7, weight: 3, color: '#ffffff', fillColor: '#2563eb', fillOpacity: 1, interactive: false,
      }).addTo(map);
    }
  }

  function init() {
    var box = $('map');
    // Circa 60 punti sullo schermo, mai più vicini di 96 pixel: sul telefono una ventina.
    spacing = Math.max(96, Math.ceil(Math.sqrt(((box.clientWidth || 360) * (box.clientHeight || 600)) / 60)));
    place = place || A.place();
    map = L.map(box, {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxBounds: [[-85, -180], [85, 180]],
      maxBoundsViscosity: 1,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.tileLayer('/tiles/{z}/{x}/{y}.png', {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      noWrap: true,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' +
        ' · Meteo <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    map.setView(place ? [place.latitude, place.longitude] : DEFAULT_CENTER, place ? START_ZOOM : 6);
    if (place) setHere(place);
    map.on('moveend', function () {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(refresh, 150);
    });
    map.getContainer().addEventListener('click', onPopupButton, true);
  }

  // Ogni minuto: l'ora che passa (se si guardava adesso, si resta su adesso) e i punti da rinnovare.
  setInterval(function () {
    if (!map || $('view-map').hidden) return;
    if ($('map-now').hidden) {
      sel.day = 0;
      sel.hour = new Date().getHours();
    }
    renderControls();
    refresh();
  }, 60 * 1000);

  window.MeteoMap = {
    show: function () {
      if (!map) init();
      map.invalidateSize();
      if (centerOnShow && place) {
        map.setView([place.latitude, place.longitude], map.getZoom());
        centerOnShow = false;
      }
      renderControls();
      refresh();
    },
    // Un luogo nuovo (ricerca, posizione, punto toccato): la mappa ci si sposta.
    setPlace: function (p) {
      if (!p || p === place) return;
      var first = !place;
      place = p;
      if (!map) return;
      setHere(p);
      if ($('view-map').hidden) centerOnShow = true;
      else map.setView([p.latitude, p.longitude], first ? START_ZOOM : map.getZoom());
    },
  };
})();
