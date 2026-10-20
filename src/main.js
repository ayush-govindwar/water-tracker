'use strict';
const { app, BrowserWindow, Tray, Menu, screen, powerMonitor, ipcMain, nativeImage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { Scheduler, sanitize } = require('./scheduler');

// Test/dev hooks: isolated profile + fake clock. Harmless in production.
if (process.env.WT_USER_DATA) app.setPath('userData', process.env.WT_USER_DATA);
const clock = { offset: 0 };

const OVERLAY = { w: 300, h: 340 }; // widget size from the design
const TICK_MS = 10000;
const EXIT_FALLBACK_MS = 4000; // hide anyway if the renderer never reports exit-done
const LOVE_FALLBACK_MS = 12000;
const LOVE_VARIANTS = 3; // heart animations in overlay.css
const DESTROY_MS = Number(process.env.WT_DESTROY_MS) || 30000; // overlay renderer is freed this long after hiding; idle app = main + tray only
const asset = (f) => path.join(__dirname, '..', 'assets', f);
const preload = path.join(__dirname, 'preload.js');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let trayPaused = false;
let store, sched, overlay, overlayReady, tray, settingsWin, hideTimer, destroyTimer, tickTimer;

function placeOverlay() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea; // workArea excludes taskbar/dock
  overlay.setBounds({ x: x + width - OVERLAY.w, y: y + height - OVERLAY.h, width: OVERLAY.w, height: OVERLAY.h });
}

// Created on demand and destroyed when idle, so no renderer process sits around between reminders.
function ensureOverlay() {
  clearTimeout(destroyTimer);
  if (overlayReady) return overlayReady;
  overlay = new BrowserWindow({
    width: OVERLAY.w,
    height: OVERLAY.h,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // never steal keyboard focus
    alwaysOnTop: true,
    webPreferences: { preload, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setMenu(null);
  overlay.on('closed', () => (overlay = overlayReady = null));
  return (overlayReady = overlay.loadFile(path.join(__dirname, 'overlay', 'index.html')));
}

function hideOverlay() {
  if (!overlay) return;
  overlay.hide();
  clearTimeout(destroyTimer);
  destroyTimer = setTimeout(() => overlay && !overlay.isVisible() && overlay.destroy(), DESTROY_MS);
}

async function showOverlay() {
  clearTimeout(hideTimer);
  await ensureOverlay();
  overlay.setIgnoreMouseEvents(true, { forward: true }); // transparent parts click through; renderer flips it over the card/her
  placeOverlay();
  overlay.setAlwaysOnTop(true, 'screen-saver'); // re-assert: other topmost windows can displace us on Windows
  overlay.webContents.send('overlay:show', { ...sched.status(), snoozeMin: sched.settings.snoozeMin });
  overlay.showInactive();
}

function hideOverlayAfterExit(kind) {
  overlay.webContents.send('overlay:exit', kind);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => sched.state === 'waiting' && hideOverlay(), EXIT_FALLBACK_MS);
}

// Surprise heart: no buttons, so let clicks fall through to whatever is underneath.
async function showLove() {
  clearTimeout(hideTimer);
  await ensureOverlay();
  overlay.setIgnoreMouseEvents(true);
  placeOverlay();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.webContents.send('overlay:love', { variant: Math.floor(Math.random() * LOVE_VARIANTS) });
  overlay.showInactive();
  hideTimer = setTimeout(() => {
    sched.endLove();
    if (sched.state === 'waiting') hideOverlay();
  }, LOVE_FALLBACK_MS);
}

function applyAutostart(s) {
  if (!app.isPackaged) return; // dev run would register the bare electron binary
  const portable = process.env.PORTABLE_EXECUTABLE_FILE; // portable exe re-extracts to temp each run
  app.setLoginItemSettings({ openAtLogin: s.autostart, ...(portable && { path: portable }) });
}

function refreshTray() {
  if (!tray) return;
  const { count, goal, streak, pausedUntil } = sched.status();
  trayPaused = !!pausedUntil;
  const label = `Today: ${count}/${goal}  ·  streak ${streak}d`;
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  tray.setToolTip(`Water Tracker — ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Remind me now', click: () => sched.remind() },
      { label: 'Undo last drink', enabled: count > 0, click: () => sched.undo() },
      pausedUntil
        ? { label: `Resume (paused until ${hhmm(pausedUntil)})`, click: () => sched.resume() }
        : { label: 'Pause for 1 hour', click: () => sched.pause(60) },
      { label: 'Settings…', click: openSettings },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function createTray() {
  const mac = process.platform === 'darwin';
  let img = nativeImage.createFromPath(asset(mac ? 'trayTemplate.png' : 'tray.png'));
  if (mac) {
    img = img.resize({ width: 18, height: 18 });
    img.setTemplateImage(true);
  }
  tray = new Tray(img);
  if (!mac) tray.on('click', () => tray.popUpContextMenu());
  refreshTray();
}

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 380,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Water Tracker — Settings',
    icon: asset('icon.png'),
    webPreferences: { preload, sandbox: true, contextIsolation: true },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'));
  settingsWin.on('closed', () => (settingsWin = null));
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function wireIpc() {
  const fromOverlay = (e) => overlay && e.sender === overlay.webContents;
  const fromSettings = (e) => settingsWin && e.sender === settingsWin.webContents;

  ipcMain.on('overlay:respond', (e, kind) => {
    if (!fromOverlay(e)) return;
    if (kind === 'drink') sched.drink();
    else if (kind === 'snooze') sched.snooze();
  });
  ipcMain.on('overlay:interactive', (e, on) => {
    if (fromOverlay(e) && sched.state === 'showing') overlay.setIgnoreMouseEvents(!on, { forward: true });
  });
  ipcMain.on('overlay:exit-done', (e, kind) => {
    if (!fromOverlay(e)) return;
    if (kind === 'love') sched.endLove();
    if (sched.state === 'waiting') hideOverlay(); // not while a reminder or heart is up
  });
  ipcMain.handle('settings:get', (e) => (fromSettings(e) ? { settings: sched.settings, status: sched.status() } : null));
  ipcMain.handle('settings:save', (e, input) => {
    if (!fromSettings(e)) return null;
    const s = sanitize(input, sched.settings);
    store.set('settings', s);
    applyAutostart(s);
    refreshTray();
    return { settings: s, status: sched.status() };
  });
}

function wirePower() {
  const tick = () => sched.tick();
  // Delay a touch: right after wake the idle counter and display layout may not have settled.
  powerMonitor.on('resume', () => setTimeout(tick, 2000));
  powerMonitor.on('lock-screen', () => (sched.locked = true));
  powerMonitor.on('unlock-screen', () => {
    sched.locked = false;
    setTimeout(tick, 2000);
  });
  screen.on('display-metrics-changed', () => overlay?.isVisible() && placeOverlay());
}

app.on('window-all-closed', () => {}); // tray app: stay alive
app.on('second-instance', openSettings);

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();
  // electron-store re-reads the JSON file on every get(); we're its only writer, so serve reads from memory.
  const disk = new Store({ name: 'water-tracker' });
  const mem = { ...disk.store };
  store = {
    get: (k, d) => (k in mem ? mem[k] : d),
    set: (k, v) => {
      mem[k] = v;
      disk.set(k, v);
    },
  };
  sched = new Scheduler({
    store,
    now: () => Date.now() + clock.offset,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onShow: showOverlay,
    onExit: hideOverlayAfterExit,
    onLove: showLove,
    onChange: refreshTray,
  });
  createTray();
  wireIpc();
  wirePower();
  applyAutostart(sched.settings);
  sched.start();
  tickTimer = setInterval(() => {
    sched.tick();
    if (!!sched.status().pausedUntil !== trayPaused) refreshTray(); // pause expired: flip the menu back
  }, TICK_MS);
  if (process.env.WT_TEST) {
    globalThis.__wt = { sched, store, clock, tray, openSettings, getSettingsWin: () => settingsWin };
    Object.defineProperty(globalThis.__wt, 'overlay', { get: () => overlay });
  }
});

app.on('before-quit', () => clearInterval(tickTimer));
