'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // overlay
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, data) => cb(data)),
  onExit: (cb) => ipcRenderer.on('overlay:exit', (_e, kind) => cb(kind)),
  onLove: (cb) => ipcRenderer.on('overlay:love', (_e, data) => cb(data)),
  respond: (kind) => ipcRenderer.send('overlay:respond', kind),
  setInteractive: (on) => ipcRenderer.send('overlay:interactive', !!on),
  exitDone: (kind) => ipcRenderer.send('overlay:exit-done', kind),
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
});
