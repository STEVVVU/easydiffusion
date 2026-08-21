'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { detect } = require('./hardware');
const { install, isInstalled } = require('./installer');
const { Supervisor } = require('./supervisor');
const { generate } = require('./comfy-client');
const { paths, MODELS } = require('./config');
const { isFaceEnhanceReady } = require('./face-enhance');

// Which bundled models are actually present on disk (the renderer's dropdown).
function installedModels() {
  const dir = paths().modelsDir;
  return MODELS.filter((m) => {
    try {
      return fs.existsSync(path.join(dir, m.name));
    } catch (_) {
      return false;
    }
  }).map((m) => ({ id: m.id, name: m.name, displayName: m.displayName, flavor: m.flavor }));
}

let win = null;
let supervisor = null;
let hw = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0f0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── Startup flow orchestration ────────────────────────────────────────────
// The renderer asks "what should I show?" via 'app:bootstrap'. We answer with
// one of: 'gate' (unsupported hardware), 'install' (supported, not installed),
// 'ready' (installed → boot engine then app).
ipcMain.handle('app:bootstrap', async () => {
  hw = await detect();
  if (!hw.supported) {
    const [code, message] = hw.reason.split(/:(.+)/s);
    return { view: 'gate', code, message, gpus: hw.allGpus };
  }
  if (!isInstalled()) {
    return { view: 'install', vramGB: hw.vramGB, gpu: hw.nvidia };
  }
  return { view: 'ready', vramGB: hw.vramGB, gpu: hw.nvidia };
});

ipcMain.handle('app:install', async () => {
  try {
    await install((status) => send('install:progress', status));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Boot the engine (called after install completes or on a ready launch).
ipcMain.handle('engine:start', async () => {
  if (supervisor && supervisor.ready) return { ok: true, port: supervisor.port };
  supervisor = new Supervisor({
    vramGB: hw ? hw.vramGB : null,
    onLog: (line) => send('engine:log', line),
    onState: (s) => send('engine:state', s),
  });
  try {
    const port = await supervisor.start();
    return { ok: true, port };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('models:list', () => ({
  models: installedModels(),
  faceEnhanceReady: isFaceEnhanceReady(),
}));

ipcMain.handle('gen:run', async (_evt, req) => {
  if (!supervisor || !supervisor.ready) return { ok: false, error: 'Engine not ready' };
  try {
    // Resolve the checkpoint filename from the model the user selected. Fall
    // back to the first installed model so a missing id can't blank the graph.
    const available = installedModels();
    const chosen = available.find((m) => m.id === req.modelId) || available[0];
    if (!chosen) return { ok: false, error: 'No model installed.' };

    let inputImage = null;
    if (req.inputImageBase64) {
      const b64 = req.inputImageBase64.replace(/^data:image\/\w+;base64,/, '');
      inputImage = { buffer: Buffer.from(b64, 'base64'), filename: 'input.png' };
    }
    // Only enable the face pass if the renderer asked AND it's truly installed.
    const enhanceFaces = Boolean(req.enhanceFaces) && isFaceEnhanceReady();
    const images = await generate(supervisor.port, {
      mode: req.mode,
      params: { ...req.params, ckptName: chosen.name, enhanceFaces },
      inputImage,
      onProgress: (p) => send('gen:progress', p),
    });
    // Return images as data URLs so the renderer can show them without file access.
    const results = images.map((fp) => {
      const data = fs.readFileSync(fp);
      return { path: fp, dataUrl: 'data:image/png;base64,' + data.toString('base64') };
    });
    return { ok: true, images: results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:openOutputs', () => {
  shell.openPath(paths().outputDir);
  return { ok: true };
});

ipcMain.handle('app:openExternal', (_e, url) => {
  shell.openExternal(url);
  return { ok: true };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (supervisor) supervisor.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (supervisor) supervisor.stop();
});
