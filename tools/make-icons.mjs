// Draws the app icon (an open book with a bookmark) as SVG and PNG, with no dependencies.
//   node tools/make-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(out, { recursive: true });

const BG = '#2f4858';
// Shapes in a 512×512 box, drawn in order. Kept inside the central circle so the
// icon also works as a "maskable" Android icon.
const shapes = [
  { fill: '#f7f1e3', pts: [[100, 166], [250, 186], [250, 380], [100, 360]] }, // left page
  { fill: '#f7f1e3', pts: [[262, 186], [412, 166], [412, 360], [262, 380]] }, // right page
  ...[0, 1, 2, 3, 4].map((i) => ({ fill: '#c8bea8', pts: line(124, 228, 218 + i * 30, 6) })),
  ...[0, 1, 2, 3, 4].map((i) => ({ fill: '#c8bea8', pts: line(284, 305, 218 + i * 30, 6) })),
  ...[0, 1, 2, 3, 4].map((i) => ({ fill: '#c8bea8', pts: line(350, 390, 218 + i * 30, 6) })),
  { fill: '#d1495b', pts: [[316, 172], [340, 172], [340, 424], [328, 408], [316, 424]] }, // bookmark
];

function line(x1, x2, y, h) {
  return [[x1, y], [x2, y], [x2, y + h], [x1, y + h]];
}

// ---- SVG ----
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="${BG}"/>
${shapes.map((s) => `<polygon fill="${s.fill}" points="${s.pts.map((p) => p.join(',')).join(' ')}"/>`).join('\n')}
</svg>
`;
writeFileSync(join(out, 'icon.svg'), svg);

// ---- PNG ----
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

function inside(pts, x, y) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  const SS = 4; // 4×4 supersampling for smooth edges
  const bg = hex(BG);
  const fills = shapes.map((s) => hex(s.fill));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const X = (x + (sx + 0.5) / SS) * scale;
          const Y = (y + (sy + 0.5) / SS) * scale;
          let c = bg;
          shapes.forEach((s, i) => {
            if (inside(s.pts, X, Y)) c = fills[i];
          });
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      px[o] = Math.round(r / n);
      px[o + 1] = Math.round(g / n);
      px[o + 2] = Math.round(b / n);
      px[o + 3] = 255;
    }
  }
  return encodePng(size, size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(join(out, `icon-${size}.png`), render(size));
console.log('Wrote icons/icon.svg, icons/icon-192.png, icons/icon-512.png');
