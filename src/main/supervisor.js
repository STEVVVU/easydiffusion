'use strict';

// Backend supervisor: spawns ComfyUI headless using its embedded Python,
// waits for the HTTP API to answer, and handles crash/restart. The user never
// sees ComfyUI — it's the engine in the basement; our app is the only UI.

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const { paths, launchFlagsForVram } = require('./config');

function findFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0)); // 0 → let OS pick later
    srv.listen(preferred, '127.0.0.1', () => {
      srv.close(() => resolve(preferred));
    });
  });
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/system_stats', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

class Supervisor {
  constructor({ vramGB, onLog, onState } = {}) {
    this.vramGB = vramGB;
    this.onLog = onLog || (() => {});
    this.onState = onState || (() => {});
    this.proc = null;
    this.port = null;
    this.ready = false;
    this.stopping = false;
  }

  async start() {
    const p = paths();
    this.port = (await findFreePort(8188)) || (await findFreePort(0)) || 8188;

    const flags = launchFlagsForVram(this.vramGB);
    const args = [
      p.comfyMain,
      '--port',
      String(this.port),
      '--listen',
      '127.0.0.1',
      '--output-directory',
      p.outputDir,
      ...flags,
    ];

    this.onState({ state: 'starting', port: this.port });
    this.onLog(`Launching engine: python ${args.join(' ')}`);

    this.proc = spawn(p.pythonExe, args, {
      cwd: path.dirname(p.comfyMain),
      windowsHide: true,
    });

    this.proc.stdout.on('data', (d) => this.onLog(d.toString()));
    this.proc.stderr.on('data', (d) => this.onLog(d.toString()));
    this.proc.on('exit', (code) => {
      this.ready = false;
      if (!this.stopping) {
        this.onState({ state: 'crashed', code });
      } else {
        this.onState({ state: 'stopped', code });
      }
    });

    await this.waitReady();
    return this.port;
  }

  async waitReady(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await ping(this.port)) {
        this.ready = true;
        this.onState({ state: 'ready', port: this.port });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Engine did not become ready within 2 minutes.');
  }

  stop() {
    this.stopping = true;
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
  }
}

module.exports = { Supervisor };
