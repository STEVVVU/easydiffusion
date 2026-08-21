'use strict';

// First-run install orchestration: download engine + model, unpack the 7z,
// drop the model into ComfyUI's checkpoints folder, and write a completion
// marker so subsequent launches skip straight to the app.
//
// All progress is reported through `onStatus({ step, label, percent })` which
// the caller forwards to the renderer's install screen.

const fs = require('fs');
const path = require('path');
const Seven = require('node-7z');
const sevenBin = require('7zip-bin');
const { ENGINE, MODELS, paths } = require('./config');
const { downloadFile, verifySha256, ensureDir } = require('./downloader');
const { installFaceEnhance } = require('./face-enhance');

// 7zip-bin ships the binary; in a packaged app it's unpacked from the asar.
function sevenZipPath() {
  return sevenBin.path7za.replace('app.asar', 'app.asar.unpacked');
}

function isInstalled() {
  const p = paths();
  try {
    // Installed = engine present AND at least one bundled model on disk. We
    // don't require every model (a user may delete one); the app lists what's
    // actually present.
    const anyModel = MODELS.some((m) => fs.existsSync(path.join(p.modelsDir, m.name)));
    return (
      fs.existsSync(p.marker) &&
      fs.existsSync(p.pythonExe) &&
      fs.existsSync(p.comfyMain) &&
      anyModel
    );
  } catch (_) {
    return false;
  }
}

function extract7z(archivePath, destDir, onProgress) {
  ensureDir(destDir);
  return new Promise((resolve, reject) => {
    const stream = Seven.extractFull(archivePath, destDir, {
      $bin: sevenZipPath(),
      $progress: true,
    });
    stream.on('progress', (p) => {
      if (onProgress && typeof p.percent === 'number') onProgress(p.percent);
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

async function install(onStatus) {
  const p = paths();
  ensureDir(p.downloadCache);
  ensureDir(p.engineRoot);
  ensureDir(p.outputDir);

  const status = (step, label, percent) => onStatus && onStatus({ step, label, percent });

  // ── 1. Engine ─────────────────────────────────────────────────────────────
  // Multi-part 7z (~4.7 GB across 3 parts). Download every part into the cache,
  // then extract the FIRST part — 7za automatically joins .002/.003.
  const enginePresent = fs.existsSync(p.pythonExe) && fs.existsSync(p.comfyMain);
  if (!enginePresent) {
    const totalGB = (ENGINE.sizeBytes / 1e9).toFixed(1);
    for (let i = 0; i < ENGINE.parts.length; i++) {
      const part = ENGINE.parts[i];
      const partPath = path.join(p.downloadCache, part.name);
      const label = `Downloading the engine — part ${i + 1} of ${ENGINE.parts.length} (~${totalGB} GB total)…`;
      status('engine-download', label, 0);
      await downloadFile(part.url, partPath, {
        expectedBytes: part.sizeBytes,
        onProgress: ({ percent }) => status('engine-download', label, percent),
      });
    }

    status('engine-extract', 'Unpacking the engine…', 0);
    const firstPart = path.join(p.downloadCache, ENGINE.firstPartName);
    await extract7z(firstPart, p.engineRoot, (pct) =>
      status('engine-extract', 'Unpacking the engine…', pct)
    );

    if (!fs.existsSync(p.pythonExe) || !fs.existsSync(p.comfyMain)) {
      throw new Error(
        'Engine unpacked but expected files are missing. The archive layout may have changed.'
      );
    }
    // Reclaim ~4.7 GB of archive parts.
    for (const part of ENGINE.parts) {
      try {
        fs.unlinkSync(path.join(p.downloadCache, part.name));
      } catch (_) {}
    }
  } else {
    status('engine-extract', 'Engine already installed.', 100);
  }

  // ── 2. Models (download each bundled checkpoint that isn't present) ─────────
  ensureDir(p.modelsDir);
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    const label = `Downloading model ${i + 1} of ${MODELS.length}: ${model.displayName} (about 7 GB)…`;
    const modelDest = path.join(p.modelsDir, model.name);
    if (fs.existsSync(modelDest)) {
      status('model-download', `${model.displayName} already installed.`, 100);
      continue;
    }
    status('model-download', label, 0);
    const staged = path.join(p.downloadCache, model.name);
    await downloadFile(model.url, staged, {
      expectedBytes: model.sizeBytes,
      onProgress: ({ percent }) => status('model-download', label, percent),
    });

    if (model.sha256) {
      status('model-verify', `Verifying ${model.displayName}…`, 0);
      await verifySha256(staged, model.sha256, ({ percent }) =>
        status('model-verify', `Verifying ${model.displayName}…`, percent)
      );
    }

    fs.renameSync(staged, modelDest);
  }

  // ── 3. Marker ────────────────────────────────────────────────────────────────
  fs.writeFileSync(
    p.marker,
    JSON.stringify(
      {
        engineVersion: ENGINE.version,
        models: MODELS.map((m) => m.name),
        installedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  // ── 4. Face enhancement (best-effort; failure does NOT fail the install) ────
  // Core generation is now fully installed and the marker is written. The
  // "After Detailer" equivalent is a bonus pass — we attempt it, but if it
  // fails the app still works, just without auto face-fixing.
  status('face-enhance', 'Setting up face enhancement (optional)…', 0);
  const faceOk = await installFaceEnhance(({ label, percent }) =>
    status('face-enhance', label, percent)
  );
  onStatus && onStatus({ step: 'face-result', faceEnhance: faceOk });

  status('done', 'Ready.', 100);
}

module.exports = { install, isInstalled };
