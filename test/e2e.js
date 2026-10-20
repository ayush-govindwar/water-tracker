'use strict';
// Real-Electron smoke test: node test/e2e.js  (opens/closes the actual app with an isolated profile + fake clock)
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const MIN = 60000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-e2e-'));
const userData = path.join(tmp, 'profile');
const spriteDir = path.join(tmp, 'sprites');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log('•', m);

// Dummy sprite sheet: n cells of 96x120, cell i solid red = 20*i+10 (so a pixel tells us which frame is on screen).
function sheet(n) {
  const W = 96 * n, H = 120;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * (W * 4 + 1) + 1 + x * 4;
    raw[o] = 20 * Math.floor(x / 96) + 10; raw[o + 3] = 255;
  }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(b)); return Buffer.concat([l, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function launch(extraEnv = {}) {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [ROOT],
    env: { ...process.env, WT_TEST: '1', WT_USER_DATA: userData, ...extraEnv },
  });
  const t0 = Date.now();
  while (!(await app.evaluate(() => !!globalThis.__wt))) {
    assert.ok(Date.now() - t0 < 20000, 'app did not boot');
    await sleep(100);
  }
  // the dev machine may genuinely be idle / outside 09-22: neutralise both (covered by unit tests)
  await app.evaluate(() => { __wt.sched.idleSeconds = () => 0; if (!__wt.store.get('settings')) __wt.store.set('settings', { activeStart: '00:00', activeEnd: '00:00' }); });
  return app;
}
const until = async (fn, what, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); }
  assert.fail(`timeout waiting for: ${what}`);
};
const rstate = (app) => app.evaluate(() => __wt.overlay.webContents.executeJavaScript('document.getElementById("app").dataset.state'));
const visible = (app) => app.evaluate(() => __wt.overlay.isVisible());
const click = (app, id) => app.evaluate((_, id) => __wt.overlay.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`), id);
const get = (app, k) => app.evaluate((_, k) => __wt.store.get(k), k);

(async () => {
  let app = await launch();
  const near = (a, b, tol = 3000) => Math.abs(a - b) < tol;
  const now = () => app.evaluate(() => Date.now() + __wt.clock.offset);

  step('phase 1: overlay window flags + placement');
  assert.equal(await visible(app), false, 'hidden until due');
  assert.equal(await app.evaluate(() => !!__wt.tray), true, 'tray exists');
  await app.evaluate(() => __wt.sched.remind());
  await until(() => visible(app), 'overlay visible');
  const info = await app.evaluate(({ screen }) => {
    const w = __wt.overlay, b = w.getBounds(), wa = screen.getPrimaryDisplay().workArea;
    return { b, wa, focused: w.isFocused(), focusable: w.isFocusable(), top: w.isAlwaysOnTop() };
  });
  assert.equal(info.focused, false, 'must not steal focus');
  assert.equal(info.focusable, false);
  assert.equal(info.top, true);
  assert.equal(info.b.x + info.b.width, info.wa.x + info.wa.width, 'flush right of workArea');
  assert.equal(info.b.y + info.b.height, info.wa.y + info.wa.height, 'flush to workArea bottom (above taskbar)');
  await until(async () => (await rstate(app)) === 'loop', 'peek -> loop (placeholder)');
  const shot = path.join(tmp, 'overlay-placeholder.png');
  fs.writeFileSync(shot, (await app.evaluate(() => __wt.overlay.webContents.capturePage().then((i) => i.toPNG().toString('base64')))), 'base64');
  step(`  placeholder screenshot: ${shot}`);
  fs.copyFileSync(shot, path.join(ROOT, 'test', 'last-overlay.png'));

  step('phase 2: drink -> count 1, due +30m, window hides');
  await click(app, 'drink');
  await until(async () => !(await visible(app)), 'overlay hides after exit');
  assert.equal(await get(app, 'count'), 1);
  assert.ok(near(await get(app, 'dueAt'), (await now()) + 30 * MIN), 'dueAt = now+30m');

  step('phase 2: snooze -> +5m, re-fires at 5m, not before');
  await app.evaluate(() => __wt.sched.remind());
  await until(async () => (await rstate(app)) === 'loop', 'loop');
  await click(app, 'snooze');
  await until(async () => !(await visible(app)), 'hides after snooze');
  assert.equal(await get(app, 'count'), 1, 'snooze does not count');
  assert.ok(near(await get(app, 'dueAt'), (await now()) + 5 * MIN), 'dueAt = now+5m');
  await app.evaluate(() => { __wt.clock.offset += 5 * 60000 - 20000; __wt.sched.tick(); });
  assert.equal(await visible(app), false, 'not yet at 4m40s');
  await app.evaluate(() => { __wt.clock.offset += 21000; __wt.sched.tick(); });
  await until(() => visible(app), 're-fired at 5m');
  await click(app, 'drink'); // count 2
  await until(async () => !(await visible(app)), 'hides');

  step('phase 3: 2h sleep + resume + repeated ticks -> exactly one show');
  await app.evaluate(({ powerMonitor }) => {
    __wt.sched.showCount = 0;
    const o = __wt.sched.onShow;
    __wt.sched.onShow = () => { __wt.sched.showCount++; o(); };
    __wt.clock.offset += 120 * 60000;
    powerMonitor.emit('resume');
    for (let i = 0; i < 6; i++) __wt.sched.tick();
  });
  await sleep(2600); // resume handler's delayed tick
  assert.equal(await app.evaluate(() => __wt.sched.showCount), 1, 'one reminder on wake');
  assert.equal(await visible(app), true);
  await click(app, 'snooze');
  await until(async () => !(await visible(app)), 'hides');

  step('phase 3: idle + lock suppress');
  await app.evaluate(() => { __wt.clock.offset += 6 * 60000; __wt.sched.idleSeconds = () => 99999; __wt.sched.tick(); });
  assert.equal(await visible(app), false, 'idle suppressed');
  assert.equal(await app.evaluate(({ powerMonitor }) => typeof powerMonitor.getSystemIdleTime(), {}), 'number');
  await app.evaluate(({ powerMonitor }) => { __wt.sched.idleSeconds = () => 0; powerMonitor.emit('lock-screen'); __wt.sched.tick(); });
  assert.equal(await visible(app), false, 'locked suppressed');
  await app.evaluate(() => { __wt.sched.locked = false; __wt.sched.tick(); });
  await until(() => visible(app), 'shows once active again');
  await click(app, 'drink'); // count 3
  await until(async () => !(await visible(app)), 'hides');

  step('phase 3: day rollover (+1 day) resets count; streak stays 0 (goal 8 not met)');
  await app.evaluate(() => { __wt.clock.offset += 24 * 3600000; __wt.sched.tick(); });
  assert.equal(await get(app, 'count'), 0);
  assert.equal(await get(app, 'streak'), 0);

  step('phase 2: counts survive restart');
  await app.evaluate(() => __wt.sched.remind());
  await until(async () => (await rstate(app)) === 'loop', 'loop');
  await click(app, 'drink'); // count 1 (new day)
  await until(async () => !(await visible(app)), 'hides');
  const day = await get(app, 'day'), dueAt = await get(app, 'dueAt');
  await app.close();
  app = await launch();
  assert.equal(await get(app, 'count'), 1, 'count persisted');
  assert.equal(await get(app, 'day'), day);
  assert.equal(await get(app, 'dueAt'), dueAt, 'dueAt persisted');

  step('phase 5: settings window round trip + sanitize');
  await app.evaluate(() => __wt.openSettings());
  await until(() => app.evaluate(() => !!__wt.getSettingsWin()), 'settings window');
  await sleep(500);
  const res = await app.evaluate(() => __wt.getSettingsWin().webContents.executeJavaScript(
    'window.api.saveSettings({intervalMin: 45, snoozeMin: 0, goal: 10, activeStart: "08:00", activeEnd: "bad"}).then(r => r.settings)'));
  assert.equal(res.intervalMin, 45);
  assert.equal(res.snoozeMin, 1, 'clamped');
  assert.equal(res.activeEnd, '00:00', 'invalid time rejected, previous value kept');
  assert.equal((await get(app, 'settings')).goal, 10);
  await app.evaluate(() => __wt.getSettingsWin().webContents.reload());
  await sleep(700);
  assert.equal(await app.evaluate(() => __wt.getSettingsWin().webContents.executeJavaScript('document.querySelector("[name=intervalMin]").value')), '45', 'form rendered from store');
  const spath = path.join(tmp, 'settings.png');
  fs.writeFileSync(spath, await app.evaluate(() => __wt.getSettingsWin().webContents.capturePage().then((i) => i.toPNG().toString('base64'))), 'base64');
  fs.copyFileSync(spath, path.join(ROOT, 'test', 'last-settings.png'));
  await app.close();

  step('phase 4: sprite sheets (dummy art, 8/12/10/10 frames) via steps()');
  fs.mkdirSync(spriteDir);
  const frames = { 'peek-in': 8, 'drink-loop': 12, 'exit-drank': 10, 'exit-snooze': 10 };
  for (const [f, n] of Object.entries(frames)) fs.writeFileSync(path.join(spriteDir, `${f}.png`), sheet(n));
  app = await launch({ WT_SPRITE_DIR: spriteDir });
  await app.evaluate(() => __wt.sched.remind());
  await until(() => visible(app), 'visible');
  // sample the peek animation: position must always sit on a whole cell, and pixel colour must match that cell
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 700 && (await rstate(app)) === 'peek') {
    const s = await app.evaluate(async () => {
      const x = await __wt.overlay.webContents.executeJavaScript('getComputedStyle(document.getElementById("char")).backgroundPositionX');
      const img = await __wt.overlay.webContents.capturePage();
      const { width, height } = img.getSize();
      const sf = width / 320;
      const bmp = img.toBitmap(); // BGRA on macOS/Windows
      const px = Math.round((320 - 8 - 48) * sf), py = Math.round((150 - 60) * sf);
      const o = (py * width + px) * 4;
      return { x, r: bmp[o + 2] };
    });
    const cell = Math.round(-parseFloat(s.x) / 96);
    assert.ok(Math.abs(-parseFloat(s.x) - cell * 96) < 0.5, `on cell boundary, got ${s.x}`);
    if (Math.abs(s.r - (20 * cell + 10)) <= 2) seen.add(cell); // rendering lags position by a frame sometimes; collect matches
  }
  assert.ok(seen.size >= 2, `pixels followed frames, saw cells ${[...seen]}`);
  await until(async () => (await rstate(app)) === 'loop', 'peek -> loop');
  const n = await app.evaluate(() => __wt.overlay.webContents.executeJavaScript('getComputedStyle(document.getElementById("char")).getPropertyValue("--n")'));
  assert.equal(n.trim(), '12', 'loop sheet = 12 frames');
  await click(app, 'drink');
  await until(async () => !(await visible(app)), 'exit-drank finishes and window hides');
  const last = await app.evaluate(() => __wt.overlay.webContents.executeJavaScript('(()=>{const c=getComputedStyle(document.getElementById("char"));return [c.getPropertyValue("--n").trim(), c.backgroundPositionX]})()'));
  assert.deepEqual(last, ['10', `${-9 * 96}px`], 'exit holds on last (10th) frame');
  await app.close();

  console.log(`\nALL E2E CHECKS PASSED  (artifacts: ${tmp})`);
})().catch((e) => { console.error('\nE2E FAILED:', e); process.exit(1); });
