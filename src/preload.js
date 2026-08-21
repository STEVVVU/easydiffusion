'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Thin bridge. All privileged work happens in main; the renderer only calls
// these and subscribes to progress events.
contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  install: () => ipcRenderer.invoke('app:install'),
  startEngine: () => ipcRenderer.invoke('engine:start'),
  listModels: () => ipcRenderer.invoke('models:list'),
  generate: (req) => ipcRenderer.invoke('gen:run', req),
  openOutputs: () => ipcRenderer.invoke('app:openOutputs'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  onInstallProgress: (cb) => ipcRenderer.on('install:progress', (_e, d) => cb(d)),
  onEngineState: (cb) => ipcRenderer.on('engine:state', (_e, d) => cb(d)),
  onEngineLog: (cb) => ipcRenderer.on('engine:log', (_e, d) => cb(d)),
  onGenProgress: (cb) => ipcRenderer.on('gen:progress', (_e, d) => cb(d)),
});
