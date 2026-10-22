'use strict';
// Real-Electron smoke test: node test/e2e.js  (opens/closes the actual app with an isolated profile + fake clock)
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIN = 60000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-e2e-'));
const userData = path.join(tmp, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log('•', m);

async function launch(extraEnv = {}) {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [ROOT],
    env: { ...process.env, WT_TEST: '1', WT_USER_DATA: userData, WT_DESTROY_MS: '5000', ...extraEnv },
  });
  const t0 = Date.now();
  while (!(await app.evaluate(() => !!globalThis.__wt))) {
    assert.ok(Date.now() - t0 < 20000, 'app did not boot');
    await sleep(100);
  }
  // the dev machine may genuinely be idle / outside 09-22: neutralise both (covered by unit tests)
  await app.evaluate(() => { __wt.sched.idleSeconds = () => 0; if (!__wt.store.get('settings')) __wt.store.set('settings', { activeStart: '00:00', activeEnd: '00:00', love: false }); });
  return app;
}
const until = async (fn, what, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); }
  assert.fail(`timeout waiting for: ${what}`);
};
const rstate = (app) => app.evaluate(() => __wt.overlay.webContents.executeJavaScript('document.getElementById("app").dataset.state'));
const visible = (app) => app.evaluate(() => !!__wt.overlay?.isVisible());
const click = (app, id) => app.evaluate((_, id) => __wt.overlay.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`), id);
const get = (app, k) => app.evaluate((_, k) => __wt.store.get(k), k);

(async () => {
  let app = await launch();
  const near = (a, b, tol = 10000) => Math.abs(a - b) < tol;
  const now = () => app.evaluate(() => Date.now() + __wt.clock.offset);

  step('phase 1: overlay window flags + placement');
  assert.equal(await visible(app), false, 'hidden until due');
  assert.equal(await app.evaluate(() => __wt.overlay == null), true, 'no overlay renderer while idle');
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
  await until(async () => (await rstate(app)) === 'loop', 'peek -> loop');

  step('phase 2: drink -> count 1, due +30m, window hides');
  await click(app, 'drink');
  await until(async () => !(await visible(app)), 'overlay hides after exit');
  assert.equal(await get(app, 'count'), 1);
  assert.ok(near(await get(app, 'dueAt'), (await now()) + 30 * MIN), 'dueAt = now+30m');

  step('perf: overlay renderer is destroyed after hiding; idle = no Tab process');
  await until(() => app.evaluate(() => __wt.overlay == null), 'overlay destroyed', 10000);
  const procs = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => p.type));
  assert.ok(!procs.includes('Tab'), `no renderer left: ${procs}`);

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
  await sleep(3800); // finger hearts // resume handler's delayed tick
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

  step('character: walk-in -> drink loop -> goal exit (confetti) / sulk exit; cups; tray perks');
  app = await launch({ WT_USER_DATA: path.join(tmp, 'profile-char'), WT_DESTROY_MS: '60000' });
  await app.evaluate(() => { __wt.store.set('count', 7); __wt.sched.remind(); });
  await until(async () => (await visible(app)) && (await rstate(app)) === 'peek', 'peek (walk-in)');
  const js = (code) => app.evaluate((_, c) => __wt.overlay.webContents.executeJavaScript(c), code);
  assert.deepEqual(await js('[document.querySelectorAll(".cup").length, document.querySelectorAll(".cup.full").length]'), [8, 7], 'cups render');
  assert.equal(await js('document.getElementById("count").textContent'), '7 of 8 today');
  await until(async () => (await rstate(app)) === 'loop', 'walk-in ends -> loop', 4000);
  await until(async () => (await js('document.getElementById("sayText").textContent')).length > 0, 'she says something', 2000);
  const f1 = await js('window.__her.frame');
  await sleep(600);
  assert.notEqual(await js('window.__her.frame'), f1, 'frames advance (canvas player running)');
  await js('window.api.setInteractive(true); window.api.setInteractive(false); 1');
  await sleep(4000); // into the drinking part of the loop
  fs.writeFileSync(path.join(ROOT, 'test', 'last-overlay.png'), await app.evaluate(() => __wt.overlay.webContents.capturePage().then((i) => i.toPNG().toString('base64'))), 'base64');
  await click(app, 'drink');
  await until(async () => (await rstate(app)) === 'exit-goal', 'goal exit');
  assert.equal(await js('document.querySelectorAll(".cup.full").length'), 8, 'cup filled');
  assert.equal(await js('getComputedStyle(document.querySelector("#confetti i")).animationName'), 'confetti');
  await until(async () => (await js('window.__her.clip')) === 'happy', 'plays her happy video');
  await until(async () => !(await visible(app)), 'cheers, walks off and hides', 8000);
  assert.equal(await get(app, 'count'), 8);
  await app.evaluate(() => __wt.sched.remind());
  await until(async () => (await rstate(app)) === 'loop', 'loop again');
  await click(app, 'snooze');
  await until(async () => (await rstate(app)) === 'exit-sulk', 'sulk exit');
  await until(async () => (await js('window.__her.clip')) === 'sulk', 'plays her sulk video');
  await until(async () => !(await visible(app)), 'sulks off', 9000);
  await app.evaluate(() => __wt.sched.undo());
  assert.equal(await get(app, 'count'), 7, 'undo');
  await app.evaluate(() => { __wt.sched.pause(60); __wt.store.set('dueAt', 0); __wt.sched.tick(); });
  assert.equal(await visible(app), false, 'paused: no reminder');
  const menu = await app.evaluate(() => __wt.tray && true);
  assert.ok(menu);
  await app.evaluate(() => { __wt.sched.resume(); __wt.store.set('dueAt', 0); __wt.sched.tick(); });
  await until(() => visible(app), 'resumed: reminder');
  await app.close();

  step('love: 11:11 heart fires once, click-through, no focus, hides itself');
  app = await launch({ WT_USER_DATA: path.join(tmp, 'profile-love'), WT_DESTROY_MS: '60000' });
  await app.evaluate(() => {
    __wt.store.set('settings', { activeStart: '00:00', activeEnd: '00:00', love: true });
    __wt.store.set('dueAt', Date.now() + 1e10); // keep water out of the way
    __wt.store.set('loveDay', ''); // boot (at the real time) may already have planned today and marked 11:11 missed
    const d = new Date(); d.setHours(11, 11, 20, 0);
    __wt.clock.offset = d.getTime() - Date.now();
    __wt.sched.loves = 0;
    const o = __wt.sched.onLove;
    __wt.sched.onLove = () => { __wt.sched.loves++; o(); };
    __wt.sched.tick();
  });
  await until(async () => (await visible(app)) && (await rstate(app)) === 'love', 'heart showing');
  assert.equal(await app.evaluate(() => __wt.overlay.isFocused()), false);
  assert.equal(await app.evaluate(() => __wt.sched.state), 'loving');
  await sleep(3800); // finger hearts
  fs.writeFileSync(path.join(ROOT, 'test', 'last-love.png'), await app.evaluate(() => __wt.overlay.webContents.capturePage().then((i) => i.toPNG().toString('base64'))), 'base64');
  await until(async () => !(await visible(app)), 'heart hides itself', 9000);
  assert.equal(await app.evaluate(() => __wt.sched.state), 'waiting');
  await app.evaluate(() => { for (let i = 0; i < 5; i++) __wt.sched.tick(); });
  assert.equal(await app.evaluate(() => __wt.sched.loves), 1, 'once');
  await app.close();

  console.log(`\nALL E2E CHECKS PASSED  (artifacts: ${tmp})`);
})().catch((e) => { console.error('\nE2E FAILED:', e); process.exit(1); });
