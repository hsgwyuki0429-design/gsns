/*
 * Generates the PWA icons as PNGs with zero dependencies
 * (minimal PNG encoder on top of node:zlib).
 * Usage: node scripts/gen-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- minimal PNG encoder ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- drawing ---------- */
function lerp(a, b, t) { return a + (b - a) * t; }

// signed distance to a rounded rectangle centered at (cx,cy)
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
// signed distance to a triangle (play button)
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  function seg(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
    return Math.hypot(apx - abx * t, apy - aby * t);
  }
  const d = Math.min(seg(px, py, ax, ay, bx, by), seg(px, py, bx, by, cx, cy), seg(px, py, cx, cy, ax, ay));
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  return inside ? -d : d;
}
function coverage(d) { // ~1px antialiasing from a signed distance
  return Math.max(0, Math.min(1, 0.5 - d));
}

function drawIcon(size, opts) {
  const { rounded = true, pad = 0 } = opts || {};
  const buf = Buffer.alloc(size * size * 4);
  const S = size;
  const inset = pad * S;
  const half = S / 2;
  const rrHW = half - inset;
  const rr = rounded ? S * 0.21 : 0;
  // play triangle, slightly right-shifted for optical centering
  const t = {
    ax: S * 0.385, ay: S * 0.30,
    bx: S * 0.385, by: S * 0.70,
    cx: S * 0.72, cy: S * 0.50,
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const dBg = sdRoundRect(x + 0.5, y + 0.5, half, half, rrHW, rrHW, rr);
      const aBg = rounded ? coverage(dBg) : (dBg < 0 ? 1 : 0);
      if (aBg <= 0) { buf[i + 3] = 0; continue; }
      // background: deep navy with a soft diagonal glow
      const g = (x + y) / (2 * S);
      let r = lerp(18, 34, g), gg = lerp(19, 22, g), b = lerp(30, 58, g);
      // accent triangle: purple → pink gradient
      const dT = sdTriangle(x + 0.5, y + 0.5, t.ax, t.ay, t.bx, t.by, t.cx, t.cy);
      const aT = coverage(dT / (S / 256)); // scale AA with icon size
      if (aT > 0) {
        const tg = (y - S * 0.30) / (S * 0.40);
        const tr = lerp(139, 236, tg), tgg = lerp(92, 72, tg), tb = lerp(246, 153, tg);
        r = lerp(r, tr, aT); gg = lerp(gg, tgg, aT); b = lerp(b, tb, aT);
      }
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(gg);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(aBg * 255);
    }
  }
  return encodePNG(S, S, buf);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), drawIcon(192, { rounded: true }));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), drawIcon(512, { rounded: true }));
// maskable: full-bleed square, content already well inside the safe zone
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), drawIcon(512, { rounded: false }));
// apple-touch-icon: iOS applies its own mask, wants opaque square
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), drawIcon(180, { rounded: false }));
console.log('icons written to', outDir);
