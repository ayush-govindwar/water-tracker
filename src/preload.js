'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // overlay
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, data) => cb(data)),
  onExit: (cb) => ipcRenderer.on('overlay:exit', (_e, kind) => cb(kind)),
  respond: (kind) => ipcRenderer.send('overlay:respond', kind),
  exitDone: () => ipcRenderer.send('overlay:exit-done'),
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
});
