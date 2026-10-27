// Generates Wisp's own PNG icons into assets/ (run once; outputs are
// committed). Shapes are signed-distance functions, supersampled 4x4 for
// anti-aliasing, and encoded with a minimal PNG writer.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
mkdirSync(out, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// Signed distances in unit space (0..1).
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

/** layers: [{sdf, color:[r,g,b,a]}], painted in order. */
function render(size, layers) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const layer of layers) {
            if (layer.sdf(x, y) > 0) continue;
            const [lr, lg, lb, la] = layer.color;
            const alpha = la / 255;
            cr = lr * alpha + cr * (1 - alpha);
            cg = lg * alpha + cg * (1 - alpha);
            cb = lb * alpha + cb * (1 - alpha);
            ca = alpha + ca * (1 - alpha);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = samples * samples;
      const alpha = a / n;
      const i = (py * size + px) * 4;
      rgba[i] = alpha > 0 ? Math.round(r / n / alpha) : 0;
      rgba[i + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      rgba[i + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, rgba);
}

const INK = [24, 24, 27, 255];
const WHITE = [250, 250, 250, 255];
const BADGE = { working: [59, 130, 246, 255], attention: [245, 158, 11, 255] };

// Tray: a white blob bot with an outline and two eyes; optional status dot.
function trayIcon(size, badge) {
  const layers = [
    { sdf: circle(0.5, 0.52, 0.44), color: INK },
    { sdf: circle(0.5, 0.52, 0.36), color: WHITE },
    { sdf: roundRect(0.37, 0.5, 0.05, 0.09, 0.05), color: INK },
    { sdf: roundRect(0.63, 0.5, 0.05, 0.09, 0.05), color: INK },
  ];
  if (badge != null) {
    layers.push({ sdf: circle(0.8, 0.8, 0.22), color: INK }, { sdf: circle(0.8, 0.8, 0.16), color: BADGE[badge] });
  }
  return render(size, layers);
}

for (const [name, badge] of [["tray", null], ["tray-working", "working"], ["tray-attention", "attention"]]) {
  writeFileSync(join(out, `${name}.png`), trayIcon(16, badge));
  writeFileSync(join(out, `${name}@2x.png`), trayIcon(32, badge));
}

// App icon: dark rounded square, white bot face.
const appLayers = [
  { sdf: roundRect(0.5, 0.5, 0.46, 0.46, 0.2), color: [17, 17, 19, 255] },
  { sdf: circle(0.5, 0.53, 0.3), color: WHITE },
  { sdf: roundRect(0.41, 0.5, 0.035, 0.065, 0.035), color: INK },
  { sdf: roundRect(0.59, 0.5, 0.035, 0.065, 0.035), color: INK },
];
writeFileSync(join(out, "app-icon.png"), render(256, appLayers));
writeFileSync(join(out, "app-icon-512.png"), render(512, appLayers));
console.log(`icons written to ${out}`);
