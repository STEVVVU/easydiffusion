'use strict';

// Renderer: pure view logic. Everything privileged goes through window.api.

const views = ['boot', 'gate', 'install', 'engine', 'app'];
function show(name) {
  views.forEach((v) => {
    document.getElementById('view-' + v).classList.toggle('active', v === name);
  });
}

let mode = 'txt2img';
let inputImageBase64 = null;
let denoiseEl = null; // grabbed in initApp, read in runGenerate
let selectedModelId = null;

// ── Boot → decide first view ────────────────────────────────────
async function boot() {
  const state = await window.api.bootstrap();
  if (state.view === 'gate') return showGate(state);
  if (state.view === 'install') return runInstall(state);
  if (state.view === 'ready') return bootEngine();
}

function showGate(state) {
  document.getElementById('gate-message').textContent = state.message;
  if (state.code === 'NO_NVIDIA') {
    document.getElementById('gate-title').textContent = "This computer can't run EasyDiffusion";
  } else if (state.code === 'NVIDIA_DRIVER_ISSUE') {
    document.getElementById('gate-title').textContent = 'Your NVIDIA drivers need attention';
  }
  const list = document.getElementById('gate-gpus');
  list.textContent = 'Detected: ' + (state.gpus || []).map((g) => g.name).join(', ');
  document.getElementById('gate-help').onclick = (e) => {
    e.preventDefault();
    window.api.openExternal('https://www.nvidia.com/download/index.aspx');
  };
  show('gate');
}

// ── Install flow ────────────────────────────────────────────────
function runInstall(state) {
  show('install');
  document.getElementById('install-detail').textContent =
    `Detected ${state.gpu ? state.gpu.name : 'your GPU'} — ${state.vramGB || '?'} GB VRAM`;

  window.api.onInstallProgress(({ label, percent }) => {
    document.getElementById('install-label').textContent = label;
    const pct = Math.round(percent || 0);
    document.getElementById('install-fill').style.width = pct + '%';
    document.getElementById('install-pct').textContent = pct + '%';
  });

  window.api.install().then((res) => {
    if (!res.ok) {
      document.getElementById('install-label').textContent = 'Setup failed: ' + res.error;
      return;
    }
    bootEngine();
  });
}

// ── Engine boot ─────────────────────────────────────────────────
function bootEngine() {
  show('engine');
  window.api.onEngineState((s) => {
    const el = document.getElementById('engine-status');
    if (s.state === 'starting') el.textContent = 'Warming up the engine…';
    if (s.state === 'crashed') el.textContent = 'The engine stopped unexpectedly. Restart the app.';
  });
  window.api.startEngine().then((res) => {
    if (res.ok) {
      populateModels().then(() => show('app'));
    } else {
      document.getElementById('engine-status').textContent = 'Engine failed: ' + res.error;
    }
  });
}

// Fill the model dropdown with installed checkpoints, and reveal the face
// toggle only if face enhancement is actually installed in the engine.
async function populateModels() {
  const { models, faceEnhanceReady } = await window.api.listModels();
  const picker = document.getElementById('model-picker');
  picker.innerHTML = '';
  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.displayName;
    picker.appendChild(opt);
  });
  selectedModelId = models[0] ? models[0].id : null;
  picker.onchange = () => {
    selectedModelId = picker.value;
  };
  document.getElementById('face-field').classList.toggle('hidden', !faceEnhanceReady);
}

// ── App interactions ────────────────────────────────────────────
function initApp() {
  // Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.mode;
      document.getElementById('img2img-only').classList.toggle('hidden', mode !== 'img2img');
    };
  });

  // Denoise slider label
  denoiseEl = document.getElementById('denoise');
  denoiseEl.oninput = () => {
    document.getElementById('denoise-val').textContent = denoiseEl.value + '%';
  };

  // Image drop / pick
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = () => fileInput.files[0] && loadImage(fileInput.files[0]);
  dropzone.ondragover = (e) => e.preventDefault();
  dropzone.ondrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) loadImage(e.dataTransfer.files[0]);
  };

  document.getElementById('open-outputs').onclick = () => window.api.openOutputs();
  document.getElementById('generate').onclick = runGenerate;

  window.api.onGenProgress(({ value, max }) => {
    if (max) document.getElementById('gen-fill').style.width = (value / max) * 100 + '%';
  });
}

function loadImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    inputImageBase64 = reader.result;
    const preview = document.getElementById('input-preview');
    preview.src = inputImageBase64;
    preview.classList.remove('hidden');
    document.getElementById('dropzone-hint').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

async function runGenerate() {
  const btn = document.getElementById('generate');
  const err = document.getElementById('gen-error');
  err.classList.add('hidden');

  if (mode === 'img2img' && !inputImageBase64) {
    err.textContent = 'Add an image first.';
    err.classList.remove('hidden');
    return;
  }

  const seedRaw = document.getElementById('seed').value;
  const params = {
    positive: document.getElementById('prompt').value,
    negative: document.getElementById('negative').value,
    steps: parseInt(document.getElementById('steps').value, 10) || 30,
    seed: seedRaw ? parseInt(seedRaw, 10) : undefined,
    denoise: mode === 'img2img' ? parseInt(denoiseEl.value, 10) / 100 : undefined,
  };

  btn.disabled = true;
  btn.textContent = 'Generating…';
  document.getElementById('gen-progress-wrap').classList.remove('hidden');
  document.getElementById('gen-fill').style.width = '0%';

  const faceField = document.getElementById('face-field');
  const enhanceFaces =
    !faceField.classList.contains('hidden') &&
    document.getElementById('enhance-faces').checked;

  const res = await window.api.generate({
    mode,
    modelId: selectedModelId,
    enhanceFaces,
    params,
    inputImageBase64: mode === 'img2img' ? inputImageBase64 : null,
  });

  btn.disabled = false;
  btn.textContent = 'Generate';
  document.getElementById('gen-progress-wrap').classList.add('hidden');

  if (!res.ok) {
    err.textContent = res.error;
    err.classList.remove('hidden');
    return;
  }
  if (res.images[0]) {
    const img = document.getElementById('result-img');
    img.src = res.images[0].dataUrl;
    img.classList.remove('hidden');
    document.getElementById('result-empty').classList.add('hidden');
  }
}

initApp();
boot();
