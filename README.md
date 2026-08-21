# EasyDiffusion

Dead-simple local image generation for Windows + NVIDIA. Download, run, generate — you never see Python, ComfyUI, or a model browser.

## How it works

This app is a **friendly wrapper around ComfyUI**. The hard part of local image
generation (Python + a CUDA-matched PyTorch build) is solved by shipping a
prebuilt portable ComfyUI. We use the **YanWenKun ComfyUI-Windows-Portable**
pack (CUDA 13.0, `python_standalone`), which additionally bundles 40+ custom
nodes — Impact Pack (FaceDetailer), ControlNet Aux, IPAdapter, LoRA Manager —
already compiled. We run it **headless** and drive it over its HTTP/websocket
API with fixed workflow graphs. Our Electron window is the only UI the user sees.

Why this pack over the official minimal portable: it removes the need to
pip-install custom-node deps on first run (fragile, hard to test) and its CUDA
13.0 build supports RTX 50-series (Blackwell). Note: the pack is **GPL-3.0** —
fine for personal use; revisit before distributing (see caveats).

```
Electron app (this repo)
  ├─ hardware.js    detect NVIDIA + VRAM; gate non-NVIDIA machines
  ├─ installer.js   first-run: download engine (~4.7 GB, 3 parts) + models (~14 GB), unpack
  ├─ face-enhance.js  download YOLO face detector (Impact Pack nodes ship w/ engine)
  ├─ supervisor.js  spawn ComfyUI headless, wait for port, restart on crash
  ├─ comfy-client.js  fill workflow JSON (+ optional FaceDetailer pass) → POST /prompt → /ws
  └─ renderer/      3-view flow: gate → install → app (Create + Edit-an-image)
```

### Startup flow

1. **Gate** — no NVIDIA GPU → friendly "this computer can't run it" screen.
   (This is the path that shows on an integrated-graphics dev machine.)
2. **Install** — supported but not yet installed → progress-bar download + unpack.
3. **App** — engine boots in the background, then Create / Edit tabs appear.

## Requirements

- Windows 10/11, x64
- **NVIDIA GPU** (4 GB+ VRAM; 6–8 GB+ recommended). AMD is deferred to v2.
- ~20 GB free disk for the first-run engine and model downloads
- NVIDIA driver 551+

## Develop

The current source checkout is tested with Node.js `24.16.0` and npm `11.18.0`.

```powershell
git clone https://github.com/STEVVVU/easydiffusion.git
Set-Location easydiffusion
npm ci
npm start
npm run build:dir
npm run build:win
```

The first start requires network access and downloads approximately 14 GB.
Engine files, models, download caches, and generated images are stored under
`%APPDATA%\EasyDiffusion`, not in the repository. Build output is written to
`dist/`.

There is no automated test suite. Validate changes with `npm run build:dir`,
then start the app and check the hardware gate or generation flow on Windows.

## Models

Two NSFW-capable SDXL checkpoints are wired in (`src/main/config.js` → `MODELS`),
both auto-downloaded on first run from **token-free HuggingFace mirrors** (no
Civitai API key, no manual steps):

- **LUSTIFY v2** — realistic (default)
- **WAI-illustrious v17** — anime

Both are plain SDXL/Illustrious (no Pony-style prompt prefixes), so they load
with the app's workflow unchanged. The in-app **Model** dropdown switches between
whichever are present on disk. To add more, append an entry with a **token-free
direct `.safetensors` URL** (HuggingFace `resolve/main/...` works; Civitai needs
a token so avoid it). Optionally set `sha256` per model for integrity checks.

Downloaded on first run (not bundled) to keep the installer small and sidestep
redistribution licensing.

## Notes / caveats

- Engine version is pinned in `config.js` (`v10.15`, NVIDIA portable).
  Bump `COMFY_VERSION` + `sizeBytes` when updating; verify the asset name via
  `gh api repos/comfyanonymous/ComfyUI/releases/latest`.
- `7zip-bin` is `asarUnpack`'d because it's a native exe that can't run from
  inside the asar.
- Legal: running local models is fine. If you distribute this, note that payment
  processors (Stripe/PayPal) drop NSFW-marketed apps, and generating sexual
  imagery of real, identifiable people without consent is illegal in a growing
  number of jurisdictions. Your own art / fictional characters are fine.
