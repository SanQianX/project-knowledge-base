'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge: only retry, nothing else leaks into the sandboxed page.
contextBridge.exposeInMainWorld('desktopBridge', {
  retry: () => ipcRenderer.invoke('desktop:retry'),
});
