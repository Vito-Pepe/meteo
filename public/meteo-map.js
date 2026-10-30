(function () {
  'use strict';

  // Mappa del meteo. Una griglia di punti copre la parte visibile e un canvas sopra la mappa
  // disegna l'ora scelta. Scheda "Tempo": nuvole più grandi e fitte dove la nuvolosità è alta,
  // che si muovono col vento, pioggia che cade, temporali con i fulmini, neve, nebbia e un alone
  // di sole dove è sereno. Scheda "Temperatura": zone colorate dal blu del freddo al rosso del
  // caldo, con i gradi. Ogni punto arriva con 8 giorni ora per ora, quindi cambiare giorno e ora
  // non chiede niente al server: solo spostando la mappa arrivano i punti nuovi.

  var A = window.MeteoApp;
  if (!A || !window.L) return;

  var MIN_ZOOM = 4, MAX_ZOOM = 13, START_ZOOM = 8;
  // Oltre lo zoom 11 i modelli meteo non hanno più dettaglio: la griglia resta quella dell'11.
  var GRID_MIN_ZOOM = 4, GRID_MAX_ZOOM = 11;
  var MAX_POINTS = 100; // per richiesta, come il server
  var STALE_MS = 30 * 60 * 1000; // dopo mezz'ora un punto si richiede (il server lo tiene un'ora)
  var CACHE_MAX = 3000;
  var DEFAULT_CENTER = [42.5, 12.5]; // l'Italia, finché non c'è un luogo
  var LAYER_KEY = 'meteo:mapLayer';
  var DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  var MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  // Temperatura: blu sempre più intenso verso il freddo, rossi sempre più intensi verso il caldo.
  var TEMP_COLORS = [
    [-10, [49, 54, 149]], [0, [69, 117, 180]], [6, [116, 173, 209]], [11, [171, 217, 233]], [15, [224, 243, 248]],
    [18, [254, 224, 144]], [22, [253, 174, 97]], [27, [244, 109, 67]], [32, [215, 48, 39]], [38, [165, 0, 38]],
  ];
  var TEMP_ALPHA = 135; // su 255: sotto i colori la mappa si vede ancora
  var TEMP_MIN = -10, TEMP_MAX = 40; // estremi della legenda

  var $ = function (id) { return document.getElementById(id); };
  var map = null, here = null, popup = null, popupKey = null;
  var canvas = null, ctx = null, dpr = 1, size = { x: 0, y: 0 };
  var tiny = document.createElement('canvas'); // un pixel per punto, ingrandito: il campo delle temperature
  var spacing = 96; // distanza tra i punti, in pixel
  var data = new Map(); // "lat,lon" -> { p: dati del punto, at: quando sono arrivati }
  var pending = {}; // "lat,lon" -> true mentre arriva
  var loading = 0, failed = null, moveTimer = null, frame = 0;
  var place = null, centerOnShow = false;
  var sel = { day: 0, hour: new Date().getHours() };
  var layer = loadLayer();
  var scene = { items: [], gz: 0, x0: 0, y0: 0, cols: 0, rows: 0 };
  var sprites = null, running = false, zooming = false, lastDraw = 0;
  var darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  var calmQuery = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;

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

  function tempRgb(t) {
    if (t <= TEMP_COLORS[0][0]) return TEMP_COLORS[0][1];
    for (var i = 1; i < TEMP_COLORS.length; i++) {
      if (t <= TEMP_COLORS[i][0]) {
        var a = TEMP_COLORS[i - 1], b = TEMP_COLORS[i], f = (t - a[0]) / (b[0] - a[0]);
        return [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * f); });
      }
    }
    return TEMP_COLORS[TEMP_COLORS.length - 1][1];
  }

  // Numeri a caso ma sempre uguali per lo stesso punto: le nuvole non cambiano forma a ogni disegno
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function status(text) {
    $('map-status').textContent = text || '';
    $('map-status').hidden = !text;
  }

  function loadLayer() {
    try { return localStorage.getItem(LAYER_KEY) === 'temperature' ? 'temperature' : 'weather'; } catch (e) { return 'weather'; }
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
    var points = [];
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var ll = map.unproject([x * spacing, y * spacing], gz);
        if (ll.lat < -85 || ll.lat > 85 || ll.lng < -180 || ll.lng > 180) continue;
        var lat = round2(ll.lat), lon = round2(ll.lng);
        points.push({ key: lat + ',' + lon, lat: lat, lon: lon, ll: ll, ix: x, iy: y });
      }
    }
    return { gz: gz, x0: x0, x1: x1, y0: y0, y1: y1, points: points };
  }

  // Distanza tra due punti della griglia sullo schermo (cresce oltre lo zoom 11)
  function screenSpacing() {
    return spacing * Math.pow(2, map.getZoom() - scene.gz);
  }

  function remember(key, value) {
    data.delete(key);
    data.set(key, value);
    if (data.size > CACHE_MAX) data.delete(data.keys().next().value);
  }

  function refresh() {
    if (!map || $('view-map').hidden) return;
    var now = Date.now();
    var need = visibleGrid().points.filter(function (g) {
      var d = data.get(g.key);
      return !pending[g.key] && (!d || now - d.at > STALE_MS);
    });
    buildScene();
    for (var i = 0; i < need.length; i += MAX_POINTS) load(need.slice(i, i + MAX_POINTS));
  }

  function load(points) {
    points.forEach(function (g) { pending[g.key] = true; });
    loading++;
    status('Carico il meteo…');
    // ";" e "," vanno codificati: il proxy HTTPS di Tailscale (in Go) toglie dalla query i
    // parametri con un ";" scritto così com'è, e al server arriverebbe una richiesta senza punti.
    var list = points.map(function (g) { return g.lat + ',' + g.lon; }).join(';');
    A.getJson('/api/map?points=' + encodeURIComponent(list))
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
        buildScene();
      });
  }

  // --- cosa disegnare in ogni punto -------------------------------------

  // Nuvolosità dal simbolo, se il punto è arrivato senza (cache del server di prima)
  function cloudFromCode(code) {
    if (code == null || code === 0) return 0;
    return code === 1 ? 0.3 : code === 2 ? 0.6 : 0.95;
  }

  function weatherAt(p, i) {
    var code = p.code[i];
    var cloud = p.cloud && p.cloud[i] != null ? p.cloud[i] / 100 : cloudFromCode(code);
    var mm = p.precip[i] || 0;
    var storm = code >= 95;
    var snow = (code >= 71 && code <= 77) || code === 85 || code === 86;
    var rain = !snow && (storm || (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || mm >= 0.1);
    var fog = code === 45 || code === 48;
    if (rain || snow) cloud = Math.max(cloud, storm ? 0.95 : 0.7); // dove piove o nevica la nuvola c'è sempre
    if (fog) cloud = Math.min(cloud, 0.3); // la nebbia si disegna a parte, bassa e larga
    // Il vento dice da dove soffia: le nuvole vanno dalla parte opposta
    var dir = p.wind_dir && p.wind_dir[i] != null ? p.wind_dir[i] : 250;
    var a = ((dir + 180) * Math.PI) / 180;
    return {
      cloud: cloud,
      rain: rain ? Math.max(mm, 0.2) : 0,
      snow: snow ? Math.max(mm, 0.2) : 0,
      storm: storm,
      fog: fog,
      day: p.is_day[i] !== 0,
      wind: p.wind[i] || 0,
      vx: Math.sin(a),
      vy: -Math.cos(a),
    };
  }

  // Forma delle nuvole e delle gocce di un punto: sempre la stessa per lo stesso punto
  function decorate(it) {
    var r = rng(hash(it.key));
    var w = it.w;
    it.phase = r();
    it.puffs = [];
    if (w.cloud >= 0.12) {
      var n = 1 + Math.round(w.cloud * 3);
      for (var k = 0; k < n; k++) {
        it.puffs.push({ dx: (r() - 0.5) * 1, dy: (r() - 0.5) * 0.8, size: 0.7 + r() * 0.6, phase: r(), shape: Math.floor(r() * 3) });
      }
    }
    it.drops = [];
    var drops = w.rain ? Math.min(40, Math.round(6 + w.rain * 8)) : w.snow ? Math.min(28, Math.round(6 + w.snow * 10)) : 0;
    for (var j = 0; j < drops; j++) it.drops.push({ dx: (r() - 0.5) * 0.9, phase: r(), speed: 0.85 + r() * 0.3 });
    it.fog = w.fog ? [{ dy: -0.1, phase: r() }, { dy: 0.15, phase: r() }] : null;
    it.bolt = w.storm ? { next: -1, until: 0, path: null } : null;
    return it;
  }

  function buildScene() {
    if (!map) return;
    var time = selectedDate().getTime() / 1000;
    var grid = visibleGrid();
    var items = [];
    grid.points.forEach(function (g) {
      var d = data.get(g.key);
      if (!d) return;
      var i = indexAt(d.p, time);
      if (i < 0 || d.p.temperature[i] == null) return;
      items.push(decorate({ key: g.key, ll: g.ll, ix: g.ix, iy: g.iy, temp: d.p.temperature[i], w: weatherAt(d.p, i) }));
    });
    scene = { items: items, gz: grid.gz, x0: grid.x0, y0: grid.y0, cols: grid.x1 - grid.x0 + 1, rows: grid.y1 - grid.y0 + 1 };
    buildTemperature();
    if (popup && map.hasLayer(popup)) popup.setContent(popupHtml(popupKey));
    paint();
  }

  // --- disegni pronti (sprite) ------------------------------------------

  function cloudSprite(rgb, shape, flat) {
    var c = document.createElement('canvas');
    c.width = 256;
    c.height = 200;
    var g = c.getContext('2d');
    var r = rng(shape * 7919 + 17);
    // Un cumulo: bolle morbide, più grandi al centro, cime tonde
    [[0.5, 0.55, 0.26], [0.27, 0.6, 0.19], [0.73, 0.6, 0.2], [0.4, 0.4, 0.2], [0.61, 0.38, 0.19], [0.5, 0.62, 0.24]].forEach(function (b) {
      var x = (b[0] + (r() - 0.5) * 0.06) * 256, y = (b[1] + (r() - 0.5) * 0.08) * 200, rad = b[2] * 256 * (0.88 + r() * 0.24);
      var gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(' + rgb + ',0.9)');
      gr.addColorStop(0.6, 'rgba(' + rgb + ',0.6)');
      gr.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, rad, 0, 2 * Math.PI);
      g.fill();
    });
    if (!flat) {
      // Volume: più luce in alto e un po' d'ombra sotto, solo dove c'è la nuvola
      g.globalCompositeOperation = 'source-atop';
      var sh = g.createLinearGradient(0, 40, 0, 190);
      sh.addColorStop(0, 'rgba(255,255,255,0.35)');
      sh.addColorStop(0.55, 'rgba(255,255,255,0)');
      sh.addColorStop(1, 'rgba(30,41,59,0.3)');
      g.fillStyle = sh;
      g.fillRect(0, 0, 256, 200);
    }
    return c;
  }

  function glowSprite(rgb) {
    var c = document.createElement('canvas');
    c.width = c.height = 128;
    var g = c.getContext('2d');
    var gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(' + rgb + ',1)');
    gr.addColorStop(0.45, 'rgba(' + rgb + ',0.5)');
    gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    return c;
  }

  function makeSprites() {
    var dark = Boolean(darkQuery && darkQuery.matches);
    var shapes = function (rgb, flat) { return [0, 1, 2].map(function (k) { return cloudSprite(rgb, k, flat); }); };
    sprites = {
      cloud: shapes(dark ? '226,232,240' : '250,251,253'),
      rainCloud: shapes(dark ? '148,163,184' : '160,171,188'),
      stormCloud: shapes(dark ? '71,85,105' : '78,88,106'),
      shadow: shapes('15,23,42', true),
      sun: glowSprite('255,196,61'),
      fog: glowSprite(dark ? '203,213,225' : '241,245,249'),
      flash: glowSprite('255,255,240'),
      rain: dark ? 'rgba(147,197,253,0.85)' : 'rgba(37,99,235,0.75)',
    };
  }

  // --- scheda Tempo: disegno animato ------------------------------------

  function clear() {
    // Il canvas sta in un livello della mappa: si rimette nell'angolo in alto a sinistra di ciò che si vede
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, size.x, size.y);
  }

  // Saetta a zig-zag che parte da dentro la nuvola, a volte con un ramo
  function boltPath() {
    var x = (Math.random() - 0.5) * 0.3, y = 0.02, main = [[x, y]], branch = null;
    for (var k = 0; k < 7; k++) {
      x += (Math.random() - 0.5) * 0.18;
      y += 0.09 + Math.random() * 0.04;
      main.push([x, y]);
      if (k === 2 && Math.random() < 0.6) branch = [[x, y], [x + 0.12, y + 0.1], [x + 0.17, y + 0.2]];
    }
    return branch ? [main, branch] : [main];
  }

  function drawWeather(t) {
    clear();
    var items = scene.items;
    if (!items.length) return;
    var S = screenSpacing();
    var pos = items.map(function (it) { return map.latLngToContainerPoint(it.ll); });
    var seen = function (q) { return q.x > -1.5 * S && q.y > -1.5 * S && q.x < size.x + 1.5 * S && q.y < size.y + 1.5 * S; };

    // 1. Sole (un alone caldo dove è sereno di giorno) e nebbia
    items.forEach(function (it, n) {
      var q = pos[n], w = it.w;
      if (!seen(q)) return;
      if (w.day && !w.rain && !w.snow && !w.fog && w.cloud < 0.35) {
        var R = S * 0.62;
        ctx.globalAlpha = 0.2 + 0.06 * Math.sin(t * 0.9 + it.phase * 6);
        ctx.drawImage(sprites.sun, q.x - R, q.y - R, 2 * R, 2 * R);
      }
      if (it.fog) {
        it.fog.forEach(function (fg) {
          var x = q.x + Math.sin(t * 0.25 + fg.phase * 6) * S * 0.12, y = q.y + fg.dy * S;
          ctx.globalAlpha = 0.55;
          ctx.drawImage(sprites.fog, x - S * 0.8, y - S * 0.22, S * 1.6, S * 0.44);
        });
      }
    });

    // 2. Nuvole: ogni sbuffo va col vento e svanisce a fine corsa, e una seconda copia a metà
    //    corsa lo sostituisce, così la copertura resta uguale. Prima tutte le ombre, poi le nuvole.
    var puffs = [];
    items.forEach(function (it, n) {
      var q = pos[n], w = it.w;
      if (!it.puffs.length || !seen(q)) return;
      var set = w.storm ? sprites.stormCloud : w.rain || w.snow ? sprites.rainCloud : sprites.cloud;
      var period = 18 / (0.6 + Math.min(w.wind, 40) / 25); // secondi per una corsa: più vento, più veloci
      var drift = S * 0.35;
      var base = (0.2 + 0.38 * w.cloud) * (w.day ? 1 : 0.85); // anche sotto il coperto la mappa si vede
      it.puffs.forEach(function (pf) {
        var W = S * (0.75 + 0.85 * w.cloud) * pf.size * (w.storm ? 1.15 : 1), H = (W * 200) / 256;
        for (var copy = 0; copy < 2; copy++) {
          var f = (t / period + pf.phase + copy * 0.5) % 1;
          puffs.push({
            img: set[pf.shape], shadow: sprites.shadow[pf.shape], a: base * Math.sin(Math.PI * f), W: W, H: H,
            x: q.x + pf.dx * S + w.vx * drift * (f - 0.5) - W / 2,
            y: q.y + pf.dy * S + w.vy * drift * (f - 0.5) - H / 2,
          });
        }
      });
    });
    puffs.forEach(function (p) {
      ctx.globalAlpha = p.a * 0.22;
      ctx.drawImage(p.shadow, p.x + S * 0.04, p.y + S * 0.07, p.W, p.H);
    });
    puffs.forEach(function (p) {
      ctx.globalAlpha = p.a;
      ctx.drawImage(p.img, p.x, p.y, p.W, p.H);
    });

    // 3. Pioggia e neve sopra le nuvole: dove piove su una zona larga la nuvola la coprirebbe
    var L = S * 0.7;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = sprites.rain;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    items.forEach(function (it, n) {
      var q = pos[n], w = it.w;
      if (!w.rain || !seen(q)) return;
      var len = Math.min(14, 7 + w.rain * 1.5), slant = w.vx * 0.3;
      it.drops.forEach(function (d) {
        var f = (t * 2 * d.speed + d.phase) % 1;
        var x = q.x + d.dx * S + slant * f * L, y = q.y - S * 0.05 + f * L;
        ctx.moveTo(x, y);
        ctx.lineTo(x + slant * len, y + len);
      });
    });
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(15,23,42,0.5)';
    ctx.shadowBlur = 2;
    ctx.beginPath();
    items.forEach(function (it, n) {
      var q = pos[n], w = it.w;
      if (!w.snow || !seen(q)) return;
      it.drops.forEach(function (d) {
        var f = (t * 0.35 * d.speed + d.phase) % 1;
        var x = q.x + d.dx * S + Math.sin(t * 1.6 + d.phase * 12) * 4 + w.vx * f * L * 0.3, y = q.y - S * 0.05 + f * L;
        var rad = 1.9 + d.speed;
        ctx.moveTo(x + rad, y);
        ctx.arc(x, y, rad, 0, 2 * Math.PI);
      });
    });
    ctx.fill();
    ctx.shadowBlur = 0;

    // 4. Fulmini: un lampo nella nuvola e una saetta, ogni qualche secondo, a volte doppi
    items.forEach(function (it, n) {
      var b = it.bolt, q = pos[n];
      if (!b || !seen(q)) return;
      if (b.next < 0) b.next = t + 0.3 + Math.random() * 3;
      if (t >= b.next) {
        b.until = t + 0.16;
        b.path = boltPath();
        b.next = t + (Math.random() < 0.3 ? 0.25 : 1.5 + Math.random() * 4);
      }
      if (t >= b.until) return;
      var k = (b.until - t) / 0.16, R = S * 0.85;
      // Lampo: la nuvola si illumina
      ctx.globalAlpha = 0.8 * k;
      ctx.drawImage(sprites.flash, q.x - R, q.y - R * 0.75, 2 * R, 1.5 * R);
      // Saetta: alone giallo, poi il nucleo bianco
      var stroke = function (width, color, blur) {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.shadowColor = 'rgba(255,214,90,0.95)';
        ctx.shadowBlur = blur;
        ctx.beginPath();
        b.path.forEach(function (line) {
          line.forEach(function (pt, j) {
            var x = q.x + pt[0] * S, y = q.y + pt[1] * S;
            if (j) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
        });
        ctx.stroke();
      };
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      stroke(4, 'rgba(255,224,102,0.9)', 18);
      stroke(1.6, '#ffffff', 0);
      ctx.shadowBlur = 0;
    });
    ctx.globalAlpha = 1;
  }

  // --- scheda Temperatura: campo colorato -------------------------------

  // Un pixel per punto della griglia; ingrandito con lo sfumato del browser diventa un campo continuo.
  function buildTemperature() {
    var cols = Math.max(1, scene.cols), rows = Math.max(1, scene.rows);
    tiny.width = cols;
    tiny.height = rows;
    var g = tiny.getContext('2d');
    var img = g.createImageData(cols, rows);
    scene.items.forEach(function (it) {
      var c = tempRgb(it.temp), o = ((it.iy - scene.y0) * cols + (it.ix - scene.x0)) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = TEMP_ALPHA;
    });
    g.putImageData(img, 0, 0);
  }

  function drawTemperature() {
    clear();
    if (!scene.items.length) return;
    var S = screenSpacing();
    var p0 = map.latLngToContainerPoint(map.unproject([scene.x0 * spacing, scene.y0 * spacing], scene.gz));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tiny, p0.x - S / 2, p0.y - S / 2, scene.cols * S, scene.rows * S);
    ctx.font = '700 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(15,23,42,0.75)';
    ctx.fillStyle = '#ffffff';
    scene.items.forEach(function (it) {
      var q = map.latLngToContainerPoint(it.ll), s = it.temp + '°';
      ctx.strokeText(s, q.x, q.y);
      ctx.fillText(s, q.x, q.y);
    });
  }

  // --- disegno: quando e come -------------------------------------------

  function visible() {
    return map && !$('view-map').hidden && !document.hidden;
  }

  function animate(now) {
    if (!visible() || layer !== 'weather' || (calmQuery && calmQuery.matches)) {
      running = false;
      return;
    }
    // Al massimo 30 disegni al secondo: bastano per la pioggia e consumano meno batteria
    if (!zooming && now - lastDraw >= 32) {
      lastDraw = now;
      drawWeather(now / 1000);
    }
    requestAnimationFrame(animate);
  }

  // Temperatura e "movimento ridotto": un disegno solo, rifatto quando cambia qualcosa.
  // Tempo: un'animazione continua, finché la mappa è visibile.
  function paint() {
    if (!visible() || zooming) return;
    if (layer === 'temperature') return drawTemperature();
    if (calmQuery && calmQuery.matches) return drawWeather(0);
    if (!running) {
      running = true;
      requestAnimationFrame(animate);
    }
  }

  function resizeCanvas() {
    size = map.getSize();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.x * dpr);
    canvas.height = Math.round(size.y * dpr);
    canvas.style.width = size.x + 'px';
    canvas.style.height = size.y + 'px';
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
    var prob = p.precip_prob[i], mm = p.precip[i], wind = p.wind[i], cloud = p.cloud ? p.cloud[i] : null;
    return '<div class="mm-pop">' +
      '<div class="mm-pop-when">' + A.esc(when) + '</div>' +
      '<div class="mm-pop-main"><span class="mm-pop-icon">' + w.icon + '</span>' +
        '<span><strong>' + p.temperature[i] + '°</strong> ' + A.esc(w.text) + '</span></div>' +
      '<div class="mm-pop-row">Pioggia ' + (prob == null ? '–' : prob + '%') + ' · ' +
        (mm == null ? '–' : mm.toLocaleString('it-IT') + ' mm') + '</div>' +
      '<div class="mm-pop-row">Nuvole ' + (cloud == null ? '–' : cloud + '%') + ' · Vento ' + (wind == null ? '–' : wind + ' km/h') + '</div>' +
      button +
    '</div>';
  }

  function openPopup(it) {
    popupKey = it.key;
    popup = L.popup({ offset: [0, -6], maxWidth: 260, autoPanPadding: [16, 16] })
      .setLatLng(it.ll)
      .setContent(popupHtml(it.key))
      .openOn(map);
  }

  // Un tocco sulla mappa apre la scheda del punto della griglia più vicino.
  function onMapClick(e) {
    var best = null, bd = Infinity;
    scene.items.forEach(function (it) {
      var d = map.latLngToContainerPoint(it.ll).distanceTo(e.containerPoint);
      if (d < bd) { bd = d; best = it; }
    });
    if (best && bd < screenSpacing()) openPopup(best);
  }

  // Leaflet ferma i clic dentro le schede: si ascoltano prima, in fase di cattura.
  function onPopupButton(e) {
    var b = e.target.closest && e.target.closest('.mm-pop-btn');
    if (!b) return;
    var k = b.getAttribute('data-key').split(',');
    map.closePopup();
    A.openPoint(Number(k[0]), Number(k[1]));
  }

  // --- schede Tempo e Temperatura, legenda ------------------------------

  function renderLayer() {
    Array.prototype.forEach.call(document.querySelectorAll('.map-layers button'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-layer') === layer));
    });
    var el = $('map-legend');
    el.className = 'map-legend' + (layer === 'temperature' ? ' scale' : '');
    if (layer === 'temperature') {
      var stops = TEMP_COLORS.map(function (c) {
        return 'rgb(' + c[1].join(',') + ') ' + (((c[0] - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * 100).toFixed(1) + '%';
      });
      el.innerHTML = '<div class="map-scale" style="background:linear-gradient(90deg,' + stops.join(',') + ')"></div>' +
        '<div class="map-scale-ticks">' + [-10, 0, 10, 20, 30, 40].map(function (v) { return '<span>' + v + '°</span>'; }).join('') + '</div>';
    } else {
      el.innerHTML = '<span>☀️ Sereno</span><span>☁️ Nuvole</span><span>🌧️ Pioggia</span><span>⛈️ Temporale</span><span>❄️ Neve</span><span>🌫️ Nebbia</span>';
    }
  }

  document.querySelector('.map-layers').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-layer]');
    if (!b) return;
    layer = b.getAttribute('data-layer');
    try { localStorage.setItem(LAYER_KEY, layer); } catch (err) { /* storage non disponibile */ }
    renderLayer();
    paint();
  });

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
    frame = requestAnimationFrame(function () { frame = 0; buildScene(); });
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
    // Il disegno del meteo: sopra le mappe (200), sotto le scritte (380), il punto blu (400) e le schede (700)
    var pane = map.createPane('meteo');
    pane.style.zIndex = 350;
    pane.style.pointerEvents = 'none';
    // Le scritte della mappa (nomi dei luoghi, strade principali, ferrovie) sopra il meteo: il server
    // le ricava dalla stessa tessera, nere con un alone bianco su sfondo trasparente (labels.js)
    var names = map.createPane('labels');
    names.style.zIndex = 380;
    names.style.pointerEvents = 'none';
    L.tileLayer('/labels/{z}/{x}/{y}.png', { pane: 'labels', minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, noWrap: true }).addTo(map);
    canvas = L.DomUtil.create('canvas', 'meteo-canvas', pane);
    ctx = canvas.getContext('2d');
    makeSprites();
    map.setView(place ? [place.latitude, place.longitude] : DEFAULT_CENTER, place ? START_ZOOM : 6);
    resizeCanvas();
    if (place) setHere(place);
    map.on('moveend', function () {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(refresh, 150);
    });
    map.on('move', paint);
    map.on('resize', function () { resizeCanvas(); paint(); });
    // Durante l'animazione dello zoom il disegno resterebbe indietro: si nasconde e si rifà alla fine
    map.on('zoomstart', function () { zooming = true; canvas.style.visibility = 'hidden'; });
    map.on('zoomend', function () { zooming = false; canvas.style.visibility = ''; paint(); });
    map.on('click', onMapClick);
    map.getContainer().addEventListener('click', onPopupButton, true);
    document.addEventListener('visibilitychange', paint);
    if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', function () { makeSprites(); paint(); });
    if (calmQuery && calmQuery.addEventListener) calmQuery.addEventListener('change', paint);
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

  renderLayer();

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
