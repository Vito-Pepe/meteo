'use strict';

// Scritte della mappa da mettere sopra il disegno del meteo. Nelle tessere di OpenStreetMap i
// nomi sono già dipinti, quindi le nuvole li coprirebbero: da ogni tessera si tengono solo le
// scritte, nere su sfondo trasparente e con un alone bianco intorno, così si leggono sopra
// qualunque nuvola. Le tessere di OSM sono a bassa risoluzione e sui telefoni (schermi 2x e 3x)
// verrebbero ingrandite e sgranate: le scritte si ricostruiscono a 2x o 3x, con i bordi netti.
// Senza dipendenze: zlib di Node basta per leggere e scrivere i PNG.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Quanto è inchiostro un pixel, dalla sua luminosità (0-255): le scritte di OSM sono #222 su un
// alone chiaro, quindi la copertura è 1 a INK e 0 a PAPER.
const INK = 40;
const PAPER = 230;
// Le scritte tra i pixel scuri e grigi: strade, confini e acque sono colorati (NEUTRAL è la
// differenza massima tra i canali). I pixel coperti almeno SEED si raggruppano in pezzi, e un
// pezzo è testo se ha un pixel scuro come l'inchiostro (CORE: le ferrovie grigie no) e non è una
// linea: più alto e più largo di ROW, o più lungo di GLYPH con meno di THIN pixel per lunghezza.
// I pezzetti senza pixel così scuri (lettere sottili come la "l", o il pezzo di una lettera
// tagliata dal bordo della tessera) restano se sono vicini a un testo (NEAR) e coperti almeno a
// metà: i bordi grigi delle strade piccole lo sono meno.
const SEED = 0.3;
const CORE = 0.72;
const NEUTRAL = 18;
const ROW = 24;
const GLYPH = 20;
const THIN = 2.5;
const NEAR = 3;
// Ricostruzione: le lettere passano dove la copertura ingrandita vale EDGE, con un bordo sfumato
// di circa un pixel. L'alone è largo HALO pixel della tessera.
const EDGE = 0.38;
const HALO = 1.75;
const HALO_ALPHA = 0.85;
const SCALES = [1, 2, 3];
const BLOCK = 4; // si lavora solo sui blocchi di 4x4 pixel con le scritte e quelli intorno

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf);
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// PNG -> { width, height, rgba }. Va bene per quelli delle tessere: 8 bit (o tavolozza da
// 1-8 bit), non interlacciati, tutti e cinque i filtri delle righe.
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('non è un PNG');
  let pos = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG senza IHDR');
  const { width, height, depth, color } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels || ihdr.interlace || (color === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8)) {
    throw new Error(`PNG non gestito (colore ${color}, ${depth} bit, interlacciato ${ihdr.interlace})`);
  }
  if (color === 3 && !plte) throw new Error('PNG a tavolozza senza PLTE');
  const bpp = Math.max(1, (channels * depth) >> 3); // byte per pixel, per i filtri
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('PNG troncato');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[dst + i - bpp] : 0;
      const b = y > 0 ? px[prev + i] : 0;
      const c = y > 0 && i >= bpp ? px[prev + i - bpp] : 0;
      let v = raw[src + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`filtro PNG ${filter}`);
      px[dst + i] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (color === 3) {
        const bit = x * depth;
        const idx = depth === 8 ? px[row + x] : (px[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        rgba[o] = plte[idx * 3];
        rgba[o + 1] = plte[idx * 3 + 1];
        rgba[o + 2] = plte[idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (color === 0 || color === 4) {
        const g = px[row + x * channels];
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = color === 4 ? px[row + x * 2 + 1] : 255;
      } else {
        const s = row + x * channels;
        rgba[o] = px[s];
        rgba[o + 1] = px[s + 1];
        rgba[o + 2] = px[s + 2];
        rgba[o + 3] = color === 6 ? px[s + 3] : 255;
      }
    }
  }
  return { width, height, rgba };
}

// RGBA (channels 4) o grigio con alfa (2) -> PNG. Righe senza filtro: le scritte sono quasi
// tutte trasparenti e si comprimono bene lo stesso.
function encodePng(width, height, pixels, channels = 4) {
  const line = width * channels;
  const raw = Buffer.alloc((line + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * line, line).copy(raw, y * (line + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit per canale
  ihdr[9] = channels === 2 ? 4 : 6; // grigio + alfa, oppure RGBA
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Maschera allargata di r pixel (quadrato), prima per righe e poi per colonne
function dilate(src, w, h, r) {
  const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !m; k++) m = src[y * w + k];
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !m; k++) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

// Copertura dell'inchiostro (0-1) di ogni pixel della tessera
function inkCoverage(rgba, n) {
  const cov = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
    cov[i] = Math.min(1, Math.max(0, (PAPER - l) / (PAPER - INK))) * (rgba[i * 4 + 3] / 255);
  }
  return cov;
}

// Spegne tutto quello che non è testo (vedi le soglie in alto)
function keepText(cov, rgba, w, h) {
  const seed = new Uint8Array(w * h);
  for (let i = 0; i < seed.length; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    seed[i] = cov[i] >= SEED && Math.max(r, g, b) - Math.min(r, g, b) < NEUTRAL ? 1 : 0;
  }
  const part = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h);
  const kinds = []; // per pezzo: 2 testo, 1 pezzetto da tenere se vicino a un testo, 0 via
  for (let start = 0; start < seed.length; start++) {
    if (!seed[start] || part[start] >= 0) continue;
    const id = kinds.length;
    let n = 0, top = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, core = false, half = false;
    stack[top++] = start;
    part[start] = id;
    while (top) {
      const i = stack[--top], x = i % w, y = (i / w) | 0;
      n++;
      if (cov[i] >= CORE) core = true;
      if (cov[i] >= 0.5) half = true;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const j = Y * w + X;
          if (seed[j] && part[j] < 0) {
            part[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, len = Math.max(bw, bh);
    const line = Math.min(bw, bh) > ROW || (len > GLYPH && n / len < THIN);
    kinds.push(line ? 0 : core ? 2 : len <= GLYPH && half ? 1 : 0);
  }
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < keep.length; i++) if (part[i] >= 0 && kinds[part[i]] === 2) keep[i] = 1;
  const near = dilate(keep, w, h, NEAR);
  const extra = new Set();
  for (let i = 0; i < keep.length; i++) if (part[i] >= 0 && kinds[part[i]] === 1 && near[i]) extra.add(part[i]);
  for (let i = 0; i < keep.length; i++) if (extra.has(part[i])) keep[i] = 1;
  // Un pixel intorno ai pezzi tenuti resta, per lo sfumato del bordo delle lettere
  const area = dilate(keep, w, h, 1);
  for (let i = 0; i < cov.length; i++) if (!area[i]) cov[i] = 0;
}

// Pesi di Catmull-Rom dei 4 pixel intorno, a distanza t (0-1) dal secondo
function cubic(t) {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

// Scritte nere con alone bianco, w*s x h*s, in grigio + alfa
function render(cov, w, h, s) {
  const W = w * s, H = h * s;
  const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
  const active = new Uint8Array(bw * bh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!cov[y * w + x]) continue;
      const bx = (x / BLOCK) | 0, by = (y / BLOCK) | 0;
      for (let j = Math.max(0, by - 1); j <= Math.min(bh - 1, by + 1); j++) {
        for (let i = Math.max(0, bx - 1); i <= Math.min(bw - 1, bx + 1); i++) active[j * bw + i] = 1;
      }
    }
  }
  // Copertura con 2 pixel di bordo ripetuti, così l'ingrandimento non deve controllare i margini
  const pw = w + 4, pad = new Float32Array(pw * (h + 4));
  for (let y = -2; y < h + 2; y++) {
    for (let x = -2; x < w + 2; x++) pad[(y + 2) * pw + x + 2] = cov[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  }
  // Per ogni posizione dentro un pixel della tessera: primo pixel letto (con il bordo) e pesi
  const first = new Int32Array(s), wts = new Float32Array(4 * s);
  for (let k = 0; k < s; k++) {
    const f = (k + 0.5) / s - 0.5, base = Math.floor(f);
    first[k] = base + 1; // base - 1, più i 2 pixel di bordo
    wts.set(cubic(f - base), 4 * k);
  }
  const ink = new Float32Array(W * H);
  const sharp = 1.2 * s;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!active[by * bw + bx]) continue;
      const X0 = bx * BLOCK * s, X1 = Math.min(W, (bx + 1) * BLOCK * s);
      for (let Y = by * BLOCK * s; Y < Math.min(H, (by + 1) * BLOCK * s); Y++) {
        const ky = Y % s, row = (((Y / s) | 0) + first[ky]) * pw;
        const y0 = wts[4 * ky], y1 = wts[4 * ky + 1], y2 = wts[4 * ky + 2], y3 = wts[4 * ky + 3];
        for (let X = X0; X < X1; X++) {
          const kx = X % s, o = row + ((X / s) | 0) + first[kx];
          const x0 = wts[4 * kx], x1 = wts[4 * kx + 1], x2 = wts[4 * kx + 2], x3 = wts[4 * kx + 3];
          const r0 = x0 * pad[o] + x1 * pad[o + 1] + x2 * pad[o + 2] + x3 * pad[o + 3];
          const r1 = x0 * pad[o + pw] + x1 * pad[o + pw + 1] + x2 * pad[o + pw + 2] + x3 * pad[o + pw + 3];
          const r2 = x0 * pad[o + 2 * pw] + x1 * pad[o + 2 * pw + 1] + x2 * pad[o + 2 * pw + 2] + x3 * pad[o + 2 * pw + 3];
          const r3 = x0 * pad[o + 3 * pw] + x1 * pad[o + 3 * pw + 1] + x2 * pad[o + 3 * pw + 2] + x3 * pad[o + 3 * pw + 3];
          const v = y0 * r0 + y1 * r1 + y2 * r2 + y3 * r3;
          // A 1x si tiene lo sfumato com'è; ingrandendo, bordo netto dove la copertura vale EDGE
          ink[Y * W + X] = Math.min(1, Math.max(0, s === 1 ? v : (v - EDGE) * sharp + 0.5));
        }
      }
    }
  }
  // Alone rotondo: un disco sfumato intorno a ogni pixel di bordo delle lettere
  const R = HALO * s, r = Math.ceil(R + 0.5);
  const dOff = [], dVal = [], dX = [], dY = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const v = Math.min(1, R + 0.5 - Math.hypot(dx, dy));
      if (v > 0) { dOff.push(dy * W + dx); dVal.push(v); dX.push(dx); dY.push(dy); }
    }
  }
  const halo = new Float32Array(W * H);
  const IN = 0.35;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (!active[by * bw + bx]) continue;
      const X0 = bx * BLOCK * s, X1 = Math.min(W, (bx + 1) * BLOCK * s);
      for (let Y = by * BLOCK * s; Y < Math.min(H, (by + 1) * BLOCK * s); Y++) {
        for (let X = X0; X < X1; X++) {
          const i = Y * W + X;
          if (ink[i] < IN) continue;
          const safe = X >= r && Y >= r && X < W - r && Y < H - r;
          if (safe && ink[i - 1] >= IN && ink[i + 1] >= IN && ink[i - W] >= IN && ink[i + W] >= IN) continue;
          for (let k = 0; k < dOff.length; k++) {
            if (!safe) {
              const x = X + dX[k], y = Y + dY[k];
              if (x < 0 || y < 0 || x >= W || y >= H) continue;
            }
            const j = i + dOff[k];
            if (halo[j] < dVal[k]) halo[j] = dVal[k];
          }
        }
      }
    }
  }
  // Nero dell'inchiostro sopra il bianco dell'alone
  const ga = new Uint8Array(W * H * 2);
  for (let i = 0; i < ink.length; i++) {
    const t = ink[i], sh = halo[i] * HALO_ALPHA * (1 - t), a = t + sh;
    if (a <= 0) continue;
    ga[i * 2] = Math.round((255 * sh) / a);
    ga[i * 2 + 1] = Math.round(a * 255);
  }
  return ga;
}

// Tessera di OSM -> PNG con le sole scritte, a scala 1, 2 o 3 (512 o 768 pixel di lato a 2x e 3x)
function labelsFromTile(png, scale = 1) {
  if (!SCALES.includes(scale)) throw new Error(`scala ${scale} non gestita`);
  const { width: w, height: h, rgba } = decodePng(png);
  const cov = inkCoverage(rgba, w * h);
  keepText(cov, rgba, w, h);
  return encodePng(w * scale, h * scale, render(cov, w, h, scale), 2);
}

// Tessera tutta trasparente, se quella di partenza non si legge (il browser la mostra grande
// quanto le altre, qualunque sia la sua misura)
const EMPTY_TILE = encodePng(256, 256, new Uint8Array(256 * 256 * 2), 2);

module.exports = { decodePng, encodePng, labelsFromTile, EMPTY_TILE, SCALES };
