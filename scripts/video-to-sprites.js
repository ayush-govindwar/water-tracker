'use strict';
// Turns the character videos in art/ (black background) into transparent sprite atlases for the overlay.
//   npx electron scripts/video-to-sprites.js
// Writes assets/her/<clip>.webp (grid of frames per clip) + assets/her/atlas.json (cell sizes, per-frame centre x, segments).
// Uses Chromium (via Electron) to decode the mp4s, so no ffmpeg/python needed.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ART = path.join(__dirname, '..', 'art');
const OUT = path.join(__dirname, '..', 'assets', 'her');
const FPS = 12;
// Per video: segments (seconds) and where she stands when upright, in source px (floor = heel line, height = head to heel).
// Every clip is scaled so her standing height matches, and her floor lines up, so she's the same size in every clip.
// right: the crop keeps the video's right edge (she enters/leaves through it = the screen edge).
const CLIPS = {
  her: { file: 'her.mp4', floor: 1210, height: 1168, right: true, segments: { walkIn: [0, 1.75], idle: [1.75, 5.0], drink: [5.0, 8.6] } },
  happy: { file: 'happyafterdrinkingwater.mp4', floor: 678, height: 620, segments: { happy: [0.17, 2.95] } },
  heart: { file: 'heart.mp4', floor: 1219, height: 1132, right: true, segments: { heart: [0.17, 4.75] } },
  sulk: { file: 'sulk.mp4', floor: 1210, height: 1168, right: true, halo: { max: 18, px: 8 }, segments: { sulk: [0, 5.9] } }, // same camera as her.mp4; soft dark glow around her
};
const BG_MAX = 6; // background is ~0-3 black; her hair/dress go darker than the outline only inside her (clip.halo peels a glow)
const BODY_BLOB = 20000; // px; smaller blobs are hearts/sparkles (keyed by brightness) or specks
const MIN_BLOB = 60; // px; compression specks
const CELL_H = 480;
const HEAD = 10; // cell px above her head
const GAP = 4; // transparent gutter between cells so scaled draws never bleed in a neighbour's edge

// Runs in the page: decode -> de-watermark -> key -> crop -> atlas.
async function build({ src, fps, clip, BG_MAX, BODY_BLOB, MIN_BLOB, CELL_H, HEAD, GAP }) {
  const v = document.createElement('video');
  v.muted = true;
  v.src = src;
  await new Promise((res, rej) => ((v.onloadeddata = res), (v.onerror = () => rej(new Error(`decode failed: ${src}`)))));
  const W = v.videoWidth, H = v.videoHeight;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const grab = (t) => new Promise((res) => { v.onseeked = () => { ctx.drawImage(v, 0, 0); res(ctx.getImageData(0, 0, W, H)); }; v.currentTime = t; });

  const frames = [];
  const names = [];
  for (const [name, [a, b]] of Object.entries(clip.segments)) {
    for (let t = a; t < b - 1e-6; t += 1 / fps) {
      frames.push(await grab(Math.min(t, v.duration - 0.01)));
      names.push(name);
    }
  }

  // Watermark (the little sparkle bottom-right): the only thing that stays lit in every frame down there.
  const wm = [];
  for (let y = Math.floor(H * 0.8); y < H; y++) for (let x = Math.floor(W * 0.58); x < W; x++) {
    const i = (y * W + x) * 4;
    if (frames.every((f) => Math.max(f.data[i], f.data[i + 1], f.data[i + 2]) > 40)) wm.push(y * W + x);
  }
  const mark = new Uint8Array(W * H); // the sparkle's own pixels + 2px of glow
  for (const p of wm) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark[p + dy * W + dx] = 1;

  const N = W * H;
  const bg = new Uint8Array(N);
  const seen = new Uint8Array(N);
  const q = new Int32Array(N);
  let minX = W;
  for (const img of frames) {
    const d = img.data;
    if (wm.length) for (let p = 0; p < W * H; p++) { // paint over the sparkle with the nearest pixel left of it (black bg, or her)
      if (!mark[p]) continue;
      let s = p;
      while (mark[s]) s--;
      d[p * 4] = d[s * 4]; d[p * 4 + 1] = d[s * 4 + 1]; d[p * 4 + 2] = d[s * 4 + 2];
    }
    const m = (p) => Math.max(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
    // 1. flood-fill background from the borders
    bg.fill(0);
    let n = 0;
    let max = BG_MAX;
    const push = (p) => { if (!bg[p] && m(p) <= max) { bg[p] = 1; q[n++] = p; } };
    const grow = (from, to) => {
      for (let k = from; k < to; k++) {
        const p = q[k], x = p % W;
        if (x > 0) push(p - 1);
        if (x < W - 1) push(p + 1);
        if (p >= W) push(p - W);
        if (p < N - W) push(p + W);
      }
    };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    for (let k = 0; k < n; k++) grow(k, k + 1);
    // 1b. peel a soft dark glow around her, at most halo px deep (a deeper flood would eat into her dark hair)
    if (clip.halo) {
      max = clip.halo.max;
      for (let i = 0, a = 0; i < clip.halo.px; i++) { const b = n; grow(a, b); a = b; }
    }
    // 2. per blob: her body keeps a hard edge; hearts/sparkles glow (alpha from brightness, no black halo); specks go
    seen.fill(0);
    for (let p0 = 0; p0 < N; p0++) {
      if (bg[p0] || seen[p0]) continue;
      let len = 0;
      q[len++] = p0; seen[p0] = 1;
      for (let k = 0; k < len; k++) {
        const p = q[k], x = p % W;
        for (const nb of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) {
          if (nb >= 0 && nb < N && !bg[nb] && !seen[nb]) { seen[nb] = 1; q[len++] = nb; }
        }
      }
      if (len >= BODY_BLOB) {
        for (let k = 0; k < len; k++) {
          const p = q[k], x = p % W;
          const edge = (x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) || (p >= W && bg[p - W]) || (p < N - W && bg[p + W]);
          d[p * 4 + 3] = edge ? Math.min(255, Math.max(90, m(p) * 14)) : 255;
          if (x < minX) minX = x;
        }
      } else if (len >= MIN_BLOB) {
        for (let k = 0; k < len; k++) {
          const o = q[k] * 4, a = Math.min(255, m(q[k]) * 2);
          d[o + 3] = a;
          if (a) for (let j = 0; j < 3; j++) d[o + j] = Math.min(255, (d[o + j] * 255) / a);
          if (q[k] % W < minX) minX = q[k] % W;
        }
      }
      if (len < MIN_BLOB) for (let k = 0; k < len; k++) d[q[k] * 4 + 3] = 0;
    }
    for (let p = 0; p < N; p++) if (bg[p]) d[p * 4 + 3] = 0;
  }

  // Crop + scale: her standing height -> CELL_H - 2*HEAD px, heel line -> CELL_H - HEAD (same for every clip).
  const k = (CELL_H - 2 * HEAD) / clip.height;
  const floorY = CELL_H - HEAD; // cell y of the heel line
  const cy0 = clip.floor - floorY / k;
  const cx0 = Math.max(0, minX - 4);
  let cx1 = W;
  if (!clip.right) { // tight on the right too
    cx1 = 0;
    for (const img of frames) for (let p = 0; p < N; p++) if (img.data[p * 4 + 3] && p % W >= cx1) cx1 = (p % W) + 1;
    cx1 = Math.min(W, cx1 + 4);
  }
  const cw = cx1 - cx0, ch = CELL_H / k;
  const cellW = Math.round(cw * k), cellH = CELL_H;
  const cols = Math.min(frames.length, Math.floor(8000 / (cellW + GAP)));
  const rows = Math.ceil(frames.length / cols);
  const atlas = Object.assign(document.createElement('canvas'), { width: cols * (cellW + GAP), height: rows * (cellH + GAP) });
  const actx = atlas.getContext('2d');
  actx.imageSmoothingQuality = 'high';
  const tmp = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const tctx = tmp.getContext('2d');
  const centers = [];
  frames.forEach((img, i) => {
    tctx.putImageData(img, 0, 0);
    actx.drawImage(tmp, cx0, cy0, cw, ch, (i % cols) * (cellW + GAP), Math.floor(i / cols) * (cellH + GAP), cellW, cellH);
    // horizontal centre of her opaque pixels (lets the player keep her in place across clips)
    let sum = 0, cnt = 0;
    const d = img.data;
    for (let y = Math.max(0, Math.round(cy0)); y < H; y += 4) for (let x = cx0; x < cx1; x += 2) if (d[(y * W + x) * 4 + 3] > 128) { sum += x; cnt++; }
    centers.push(cnt ? Math.round(((sum / cnt) - cx0) * k) : Math.round(cellW / 2));
  });
  const seg = {};
  names.forEach((nm, i) => { seg[nm] = seg[nm] || [i, i]; seg[nm][1] = i; });
  return { webp: atlas.toDataURL('image/webp', 0.88), meta: { cellW, cols, count: frames.length, centers, segments: seg } };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } });
  await win.loadURL('data:text/html,<body></body>');
  fs.mkdirSync(OUT, { recursive: true });
  const meta = { fps: FPS, cellH: CELL_H, gap: GAP, clips: {} };
  for (const [name, clip] of Object.entries(CLIPS)) {
    const args = { src: pathToFileURL(path.join(ART, clip.file)).href, fps: FPS, clip, BG_MAX, BODY_BLOB, MIN_BLOB, CELL_H, HEAD, GAP };
    const r = await win.webContents.executeJavaScript(`(${build})(${JSON.stringify(args)})`);
    fs.writeFileSync(path.join(OUT, `${name}.webp`), Buffer.from(r.webp.split(',')[1], 'base64'));
    meta.clips[name] = r.meta;
    console.log(`${name}: ${r.meta.count} frames, cell ${r.meta.cellW}x${CELL_H}, ${r.meta.cols} cols`, r.meta.segments);
  }
  fs.writeFileSync(path.join(OUT, 'atlas.json'), JSON.stringify(meta));
  app.quit();
});
