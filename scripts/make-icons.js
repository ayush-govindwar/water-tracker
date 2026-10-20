'use strict';
// Generates the placeholder water-drop icons (no image deps): node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function png(size, rgb) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4;
  const inside = (x, y) => {
    const inCircle = (x - 0.5) ** 2 + (y - 0.62) ** 2 <= 0.3 ** 2;
    // triangle apex (0.5,0.06), tangent points (0.5±0.253, 0.46)
    const inTri = y >= 0.06 && y <= 0.46 && Math.abs(x - 0.5) <= ((y - 0.06) / 0.4) * 0.253;
    return inCircle || inTri;
  };
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) hit += inside((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
      raw[o + 3] = Math.round((hit / (SS * SS)) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, '..', 'assets');
fs.writeFileSync(path.join(out, 'icon.png'), png(512, [58, 160, 255]));
fs.writeFileSync(path.join(out, 'tray.png'), png(32, [58, 160, 255]));
fs.writeFileSync(path.join(out, 'trayTemplate.png'), png(32, [0, 0, 0])); // macOS menu bar template
