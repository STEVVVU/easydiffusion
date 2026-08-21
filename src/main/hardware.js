'use strict';

// Hardware detection + the NVIDIA gate.
//
// The app only supports NVIDIA/CUDA at v1 (AMD deferred to v2). We must fail
// LOUDLY and EARLY on non-NVIDIA hardware rather than downloading ~9 GB and
// crashing at engine launch. Two detection paths:
//   1. nvidia-smi  — authoritative for NVIDIA + gives exact VRAM/driver.
//   2. PowerShell Win32_VideoController — lists every adapter, so we can tell
//      "no NVIDIA at all" (integrated Intel/AMD) apart from "nvidia-smi missing
//      but an NVIDIA card is present" (driver issue).

const { execFile } = require('child_process');

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// nvidia-smi may not be on PATH; try PATH then the standard install location.
async function queryNvidiaSmi() {
  const args = [
    '--query-gpu=name,memory.total,driver_version',
    '--format=csv,noheader,nounits',
  ];
  const candidates = [
    'nvidia-smi',
    'C:\\Windows\\System32\\nvidia-smi.exe',
    'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
  ];
  for (const bin of candidates) {
    const { err, stdout } = await run(bin, args);
    if (!err && stdout) {
      // "NVIDIA GeForce RTX 4070, 12282, 552.44"
      const [name, memMiB, driver] = stdout.split('\n')[0].split(',').map((s) => s.trim());
      return {
        name,
        vramGB: Math.round((parseInt(memMiB, 10) / 1024) * 10) / 10,
        driver,
      };
    }
  }
  return null;
}

// Enumerate ALL video controllers so we can classify the machine.
async function listAllGpus() {
  const ps =
    "Get-CimInstance Win32_VideoController | ForEach-Object { " +
    "$vram = if ($_.AdapterRAM) { [math]::Round($_.AdapterRAM/1GB,1) } else { 0 }; " +
    "\"$($_.Name)|$vram|$($_.DriverVersion)\" }";
  const { err, stdout } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    ps,
  ]);
  if (err || !stdout) return [];
  return stdout
    .split('\n')
    .map((line) => {
      const [name, vram, driver] = line.split('|');
      return { name: (name || '').trim(), vramGB: parseFloat(vram) || 0, driver: (driver || '').trim() };
    })
    .filter((g) => g.name);
}

// Returns a verdict the UI can act on directly.
//   supported === true  → proceed to install/run, use `nvidia` + `vramGB`
//   supported === false → show the gate; `reason` explains why in plain words
async function detect() {
  const allGpus = await listAllGpus();
  const smi = await queryNvidiaSmi();

  if (smi) {
    return {
      supported: true,
      nvidia: smi,
      vramGB: smi.vramGB,
      allGpus,
      lowVramWarning: smi.vramGB < 4,
      reason: null,
    };
  }

  // No nvidia-smi. Is there an NVIDIA adapter that just lacks the tool/driver?
  const nvidiaAdapter = allGpus.find((g) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(g.name));
  if (nvidiaAdapter) {
    return {
      supported: false,
      nvidia: null,
      vramGB: nvidiaAdapter.vramGB || null,
      allGpus,
      reason:
        'NVIDIA_DRIVER_ISSUE:An NVIDIA GPU was found (' +
        nvidiaAdapter.name +
        ') but its drivers/nvidia-smi are not responding. Update your NVIDIA drivers (version 551 or newer) and reopen the app.',
    };
  }

  // Genuinely no NVIDIA hardware.
  const names = allGpus.map((g) => g.name).join(', ') || 'unknown graphics';
  return {
    supported: false,
    nvidia: null,
    vramGB: null,
    allGpus,
    reason:
      'NO_NVIDIA:This app needs an NVIDIA graphics card. This computer only has: ' +
      names +
      '. Integrated graphics are not powerful enough to run image generation locally.',
  };
}

module.exports = { detect, listAllGpus, queryNvidiaSmi };
