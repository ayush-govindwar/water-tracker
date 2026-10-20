'use strict';
const { app, BrowserWindow, Tray, Menu, screen, powerMonitor, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const { Scheduler, sanitize } = require('./scheduler');

// Test/dev hooks: isolated profile + fake clock. Harmless in production.
if (process.env.WT_USER_DATA) app.setPath('userData', process.env.WT_USER_DATA);
const clock = { offset: 0 };

const OVERLAY = { w: 320, h: 150 };
const TICK_MS = 10000;
const EXIT_FALLBACK_MS = 3000; // hide anyway if the renderer never reports exit-done
const SPRITE_DIR = process.env.WT_SPRITE_DIR || path.join(__dirname, '..', 'assets', 'sprites');
const SPRITE_FILES = ['peek-in', 'drink-loop', 'exit-drank', 'exit-snooze'].map((n) => `${n}.png`);
const asset = (f) => path.join(__dirname, '..', 'assets', f);
const preload = path.join(__dirname, 'preload.js');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let store, sched, overlay, tray, settingsWin, hideTimer, tickTimer;

function placeOverlay() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea; // workArea excludes taskbar/dock
  overlay.setBounds({ x: x + width - OVERLAY.w, y: y + height - OVERLAY.h, width: OVERLAY.w, height: OVERLAY.h });
}

function createOverlay() {
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
  return overlay.loadFile(path.join(__dirname, 'overlay', 'index.html'));
}

function showOverlay() {
  clearTimeout(hideTimer);
  placeOverlay();
  overlay.setAlwaysOnTop(true, 'screen-saver'); // re-assert: other topmost windows can displace us on Windows
  const hasSprites = SPRITE_FILES.every((f) => fs.existsSync(path.join(SPRITE_DIR, f)));
  overlay.webContents.send('overlay:show', {
    ...sched.status(),
    snoozeMin: sched.settings.snoozeMin,
    spriteBase: hasSprites ? pathToFileURL(SPRITE_DIR).href + '/' : null,
  });
  overlay.showInactive();
}

function hideOverlayAfterExit(kind) {
  overlay.webContents.send('overlay:exit', kind);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => sched.state !== 'showing' && overlay.hide(), EXIT_FALLBACK_MS);
}

function applyAutostart(s) {
  if (!app.isPackaged) return; // dev run would register the bare electron binary
  const portable = process.env.PORTABLE_EXECUTABLE_FILE; // portable exe re-extracts to temp each run
  app.setLoginItemSettings({ openAtLogin: s.autostart, ...(portable && { path: portable }) });
}

function refreshTray() {
  if (!tray) return;
  const { count, goal, streak } = sched.status();
  const label = `Today: ${count}/${goal}  ·  streak ${streak}d`;
  tray.setToolTip(`Water Tracker — ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Remind me now', click: () => sched.remind() },
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
  const fromOverlay = (e) => e.sender === overlay.webContents;
  const fromSettings = (e) => settingsWin && e.sender === settingsWin.webContents;

  ipcMain.on('overlay:respond', (e, kind) => {
    if (!fromOverlay(e)) return;
    if (kind === 'drink') sched.drink();
    else if (kind === 'snooze') sched.snooze();
  });
  ipcMain.on('overlay:exit-done', (e) => {
    if (fromOverlay(e) && sched.state !== 'showing') overlay.hide();
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
  screen.on('display-metrics-changed', () => overlay.isVisible() && placeOverlay());
}

app.on('window-all-closed', () => {}); // tray app: stay alive
app.on('second-instance', openSettings);

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();
  store = new Store({ name: 'water-tracker' });
  sched = new Scheduler({
    store,
    now: () => Date.now() + clock.offset,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onShow: showOverlay,
    onExit: hideOverlayAfterExit,
    onChange: refreshTray,
  });
  await createOverlay();
  createTray();
  wireIpc();
  wirePower();
  applyAutostart(sched.settings);
  sched.start();
  tickTimer = setInterval(() => sched.tick(), TICK_MS);
  if (process.env.WT_TEST) globalThis.__wt = { sched, overlay, store, clock, tray, openSettings, getSettingsWin: () => settingsWin };
});

app.on('before-quit', () => clearInterval(tickTimer));
