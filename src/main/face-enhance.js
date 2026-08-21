'use strict';

// Face enhancement setup (the guide's "After Detailer").
//
// With the YanWenKun engine pack, Impact Pack + Subpack and all their compiled
// Python deps are ALREADY bundled. So this module no longer clones repos or
// pip-installs anything — the fragile, untestable install step is gone. The
// only remaining task is downloading the YOLO face-detection model, which the
// pack does not ship. Still best-effort: a failure just leaves face
// enhancement off; core generation is unaffected.

const fs = require('fs');
const path = require('path');
const { FACE_ENHANCE, paths } = require('./config');
const { downloadFile, ensureDir } = require('./downloader');

// Ready when the detector model is on disk. The Impact Pack nodes ship with
// the engine, so we don't re-check those (they're guaranteed present).
function isFaceEnhanceReady() {
  const p = paths();
  try {
    return (
      fs.existsSync(p.faceMarker) &&
      fs.existsSync(path.join(p.detectorDir, FACE_ENHANCE.detectorModel.name))
    );
  } catch (_) {
    return false;
  }
}

// Attempt install. `onStatus({label, percent})` for progress. NEVER throws.
async function installFaceEnhance(onStatus) {
  const p = paths();
  const status = (label, percent) => onStatus && onStatus({ label, percent });

  if (isFaceEnhanceReady()) {
    status('Face enhancement already installed.', 100);
    return true;
  }

  try {
    ensureDir(p.detectorDir);
    const detDest = path.join(p.detectorDir, FACE_ENHANCE.detectorModel.name);
    if (!fs.existsSync(detDest)) {
      status('Downloading face-detection model…', 0);
      const staged = detDest + '.part-dl';
      await downloadFile(FACE_ENHANCE.detectorModel.url, staged, {
        expectedBytes: FACE_ENHANCE.detectorModel.sizeBytes,
        onProgress: ({ percent }) => status('Downloading face-detection model…', percent),
      });
      fs.renameSync(staged, detDest);
    }
    fs.writeFileSync(p.faceMarker, JSON.stringify({ installedAt: new Date().toISOString() }));
    status('Face enhancement ready.', 100);
    return true;
  } catch (e) {
    // Non-fatal: base generation still works, enhancement just stays off.
    return false;
  }
}

module.exports = { installFaceEnhance, isFaceEnhanceReady };
