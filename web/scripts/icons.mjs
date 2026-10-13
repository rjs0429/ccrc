// Writes the app icons (a ">_" prompt on a clay square) into web/public. Run: node web/scripts/icons.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const BG = [0xc9, 0x64, 0x42];
const FG = [0xff, 0xff, 0xff];
const STROKE = 0.085;
const SEGMENTS = [
  [0.29, 0.31, 0.49, 0.5],
  [0.49, 0.5, 0.29, 0.69],
  [0.55, 0.69, 0.73, 0.69],
];
const SAMPLES = 4;

function segmentDistance(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = (x + (sx + 0.5) / SAMPLES) / size;
          const py = (y + (sy + 0.5) / SAMPLES) / size;
          if (SEGMENTS.some((s) => segmentDistance(px, py, s) <= STROKE / 2)) hit++;
        }
      }
      const a = hit / (SAMPLES * SAMPLES);
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/", import.meta.url);
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  fs.writeFileSync(new URL(name, out), png(size));
}
