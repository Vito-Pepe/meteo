'use strict';

// Scritte della mappa da mettere sopra il disegno del meteo. Nelle tessere di OpenStreetMap i
// nomi sono già dipinti, quindi le nuvole li coprirebbero: da ogni tessera si tengono solo i
// pixel scuri (scritte, simboli, ferrovie, bordi delle strade principali), neri su sfondo
// trasparente e con un alone bianco intorno, così si leggono sopra qualunque nuvola.
// Senza dipendenze: zlib di Node basta per leggere e scrivere i PNG.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const INK_DARK = 80; // luminosità (0-255) da qui in giù: tutto inchiostro
const INK_LIGHT = 150; // da qui in su: niente
const HALO = 2; // pixel di alone intorno alle scritte
const HALO_ALPHA = 0.85;

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

// RGBA -> PNG (righe senza filtro: le scritte sono quasi tutte trasparenti e si comprimono bene)
function encodePng(width, height, rgba) {
  const line = width * 4;
  const raw = Buffer.alloc((line + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * line, line).copy(raw, y * (line + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit per canale
  ihdr[9] = 6; // RGBA
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Massimo su una finestra di 2r+1 pixel, prima per righe e poi per colonne: l'alone
function dilate(src, w, h, r) {
  const tmp = new Uint8Array(src.length), out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

function labelsFromTile(png) {
  const { width: w, height: h, rgba } = decodePng(png);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) {
    const l = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
    const v = l <= INK_DARK ? 255 : l >= INK_LIGHT ? 0 : ((INK_LIGHT - l) / (INK_LIGHT - INK_DARK)) * 255;
    ink[i] = Math.round((v * rgba[i * 4 + 3]) / 255);
  }
  const halo = dilate(ink, w, h, HALO);
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < ink.length; i++) {
    // Nero dell'inchiostro sopra il bianco dell'alone
    const t = ink[i] / 255;
    const s = (halo[i] / 255) * HALO_ALPHA * (1 - t);
    const a = t + s;
    const c = a > 0 ? Math.round((255 * s) / a) : 0;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = c;
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return encodePng(w, h, out);
}

// Tessera tutta trasparente, se quella di partenza non si legge
const EMPTY_TILE = encodePng(256, 256, new Uint8Array(256 * 256 * 4));

module.exports = { decodePng, encodePng, labelsFromTile, EMPTY_TILE };
