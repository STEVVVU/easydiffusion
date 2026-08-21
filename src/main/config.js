'use strict';

// Single source of truth for everything the app downloads and where it lives.
// URLs verified live against the GitHub API on 2026-07-07.

const path = require('path');
const os = require('os');
const { app } = require('electron');

// ── The ComfyUI engine (YanWenKun ComfyUI-Windows-Portable, CUDA 13.0) ──────
// We use this community pack instead of the official minimal portable because
// it ships 40+ custom nodes PRE-INSTALLED and pre-compiled — most importantly
// Impact Pack (FaceDetailer) + ControlNet Aux + IPAdapter + LoRA Manager. That
// removes our single biggest reliability risk: pip-installing those nodes'
// deps into the embedded Python on first run (fragile, untestable). The pack's
// CUDA 13.0 build also cleanly supports RTX 50-series (Blackwell).
//
// Tradeoffs accepted: (1) larger download — ~4.3 GB across THREE 7z parts vs
// 2 GB; (2) GPL-3.0 license — fine for personal use, revisit before any
// distribution. It uses `python_standalone/` (NOT the official `python_embeded/`).
//
// Multi-part 7z: download all parts into one dir, then extract the .001 — 7za
// auto-joins .002/.003. Sizes/URLs verified via GitHub API on 2026-07-07.
const COMFY_VERSION = 'v10.15';
const ENGINE = {
  version: COMFY_VERSION,
  // Ordered parts; the downloader fetches each, extractor points at part 1.
  parts: [
    {
      name: 'ComfyUI_Windows_portable_cu130.7z.001',
      url: `https://github.com/YanWenKun/ComfyUI-Windows-Portable/releases/download/${COMFY_VERSION}/ComfyUI_Windows_portable_cu130.7z.001`,
      sizeBytes: 2140008295,
    },
    {
      name: 'ComfyUI_Windows_portable_cu130.7z.002',
      url: `https://github.com/YanWenKun/ComfyUI-Windows-Portable/releases/download/${COMFY_VERSION}/ComfyUI_Windows_portable_cu130.7z.002`,
      sizeBytes: 2140008295,
    },
    {
      name: 'ComfyUI_Windows_portable_cu130.7z.003',
      url: `https://github.com/YanWenKun/ComfyUI-Windows-Portable/releases/download/${COMFY_VERSION}/ComfyUI_Windows_portable_cu130.7z.003`,
      sizeBytes: 388071653,
    },
  ],
  // The extractor runs against part .001 (7za joins the rest automatically).
  firstPartName: 'ComfyUI_Windows_portable_cu130.7z.001',
  sizeBytes: 2140008295 + 2140008295 + 388071653, // ~4.67 GB total
  // The folder name inside the archive (what it extracts to).
  extractedDirName: 'ComfyUI_Windows_portable',
};

// ── The default model (one SDXL checkpoint) ─────────────────────────────────
// Downloaded on first run rather than bundled, which sidesteps redistribution
// licensing entirely (point in favor of the thin installer).
//
// The bundled models. Both are NSFW-capable SDXL-family checkpoints that need
// NO prompt prefixes (unlike Pony models) and load with the app's standard
// workflow unchanged. Crucially, both are downloaded from HuggingFace over
// TOKEN-FREE `resolve/main/` URLs — verified to return raw file bytes with no
// login — so first-run setup needs zero user steps (no Civitai API key).
//
// The first entry is the default selected in the UI. To add a model, append an
// entry with a token-free direct .safetensors URL and the exact filename.
const MODELS = [
  {
    id: 'lustify',
    name: 'lustifySDXLNSFWSFW_v20.safetensors',
    displayName: 'LUSTIFY v2 — Realistic',
    flavor: 'realistic',
    url: 'https://huggingface.co/TheImposterImposters/LUSTIFY-v2.0/resolve/main/lustifySDXLNSFWSFW_v20.safetensors',
    sizeBytes: 6938043264,
    sha256: null,
  },
  {
    id: 'wai',
    name: 'waiIllustriousSDXL_v170.safetensors',
    displayName: 'WAI-illustrious v17 — Anime',
    flavor: 'anime',
    url: 'https://huggingface.co/LyliaEngine/waiIllustriousSDXL_v170/resolve/main/waiIllustriousSDXL_v170.safetensors',
    sizeBytes: 6938040682,
    sha256: null,
  },
];

// ── Face enhancement (the guide's "After Detailer", ComfyUI equivalent) ─────
// With the YanWenKun engine pack, Impact Pack + Subpack + their compiled deps
// are ALREADY bundled — so we no longer clone repos or pip-install anything
// (that fragile, untestable step is gone). All that remains is downloading the
// YOLO face-detection model, which the pack does NOT ship (verified). Still
// best-effort: if the detector download fails, the app falls back to the base
// workflow so face enhancement can never break core generation.
const FACE_ENHANCE = {
  // YOLOv8 face-detection model → models/ultralytics/bbox (token-free, 52 MB).
  detectorModel: {
    name: 'face_yolov8m.pt',
    url: 'https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt',
    sizeBytes: 52026019,
  },
};

// ── Local paths (all under userData, never touching system dirs) ────────────
function paths() {
  const root = app.getPath('userData'); // %APPDATA%/EasyDiffusion
  const engineRoot = path.join(root, 'engine');
  const comfyDir = path.join(engineRoot, ENGINE.extractedDirName, 'ComfyUI');
  return {
    root,
    engineRoot, // where the portable folder is extracted
    engineDir: path.join(engineRoot, ENGINE.extractedDirName),
    // This pack uses python_standalone/ (NOT the official pack's python_embeded/)
    pythonExe: path.join(engineRoot, ENGINE.extractedDirName, 'python_standalone', 'python.exe'),
    comfyMain: path.join(comfyDir, 'main.py'),
    modelsDir: path.join(comfyDir, 'models', 'checkpoints'),
    customNodesDir: path.join(comfyDir, 'custom_nodes'),
    // Ultralytics detector models live here (Impact Subpack reads this folder).
    detectorDir: path.join(comfyDir, 'models', 'ultralytics', 'bbox'),
    downloadCache: path.join(root, 'downloads'),
    outputDir: path.join(root, 'outputs'),
    marker: path.join(root, 'install-complete.json'), // written when setup finishes
    faceMarker: path.join(root, 'face-enhance-ready.json'), // written iff FaceDetailer usable
  };
}

// ── VRAM → launch flags. This is the "you don't have to think about it" bit ──
function launchFlagsForVram(vramGB) {
  if (vramGB == null) return []; // unknown: let ComfyUI auto-manage
  if (vramGB >= 12) return []; // plenty; default (fast)
  if (vramGB >= 8) return ['--normalvram'];
  if (vramGB >= 6) return ['--lowvram'];
  if (vramGB >= 4) return ['--lowvram']; // tight but workable
  return ['--cpu']; // below practical GPU minimum; we warn separately
}

module.exports = {
  ENGINE,
  MODELS,
  FACE_ENHANCE,
  paths,
  launchFlagsForVram,
  PORT: 8188, // ComfyUI default; supervisor picks a free one if taken
  platform: os.platform(),
};
