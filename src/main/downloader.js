'use strict';

// Resumable, verified downloads with progress reporting.
//
// Handles the two big first-run downloads (engine ~2 GB, model ~7 GB). Both
// support HTTP range-resume so a dropped connection doesn't restart from zero,
// and optional SHA-256 verification. Progress is reported via a callback the
// caller forwards to the renderer's progress bar.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Follow redirects manually (GitHub/HF both 302 to a CDN), preserving the
// Range header across hops so resume survives redirects.
function requestWithRedirects(url, headers, onResponse, maxHops = 6) {
  const req = https.get(url, { headers }, (res) => {
    const { statusCode, headers: h } = res;
    if (statusCode >= 300 && statusCode < 400 && h.location) {
      res.resume(); // drain
      if (maxHops <= 0) return onResponse(new Error('Too many redirects'));
      const next = new URL(h.location, url).toString();
      return requestWithRedirects(next, headers, onResponse, maxHops - 1);
    }
    onResponse(null, res);
  });
  req.on('error', (err) => onResponse(err));
  req.setTimeout(60000, () => req.destroy(new Error('Download stalled (60s no data)')));
}

// Download `url` to `destPath`, resuming if a partial file exists.
// onProgress({ receivedBytes, totalBytes, percent, phase })
async function downloadFile(url, destPath, { onProgress, expectedBytes } = {}) {
  ensureDir(path.dirname(destPath));
  const partPath = destPath + '.part';

  let startAt = 0;
  if (fs.existsSync(partPath)) {
    startAt = fs.statSync(partPath).size;
  }
  // If a fully-downloaded file already exists, skip.
  if (fs.existsSync(destPath)) {
    return destPath;
  }

  await new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'EasyDiffusion/0.1' };
    if (startAt > 0) headers.Range = `bytes=${startAt}-`;

    requestWithRedirects(url, headers, (err, res) => {
      if (err) return reject(err);

      const { statusCode } = res;
      // 200 = full body (server ignored Range → restart), 206 = partial resume.
      if (statusCode === 200 && startAt > 0) {
        startAt = 0; // server won't resume; truncate and start over
        try {
          fs.unlinkSync(partPath);
        } catch (_) {}
      } else if (statusCode !== 200 && statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} downloading ${url}`));
      }

      const contentLen = parseInt(res.headers['content-length'] || '0', 10);
      const totalBytes = (expectedBytes || 0) || (startAt + contentLen) || 0;
      let received = startAt;

      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) {
          onProgress({
            receivedBytes: received,
            totalBytes,
            percent: totalBytes ? Math.min(100, (received / totalBytes) * 100) : 0,
            phase: 'downloading',
          });
        }
      });

      const out = fs.createWriteStream(partPath, { flags: startAt > 0 ? 'a' : 'w' });
      pipeline(res, out).then(resolve).catch(reject);
    });
  });

  // Atomic rename once complete.
  fs.renameSync(partPath, destPath);
  return destPath;
}

// Verify SHA-256, reporting hashing progress (large files take a moment).
async function verifySha256(filePath, expected, onProgress) {
  if (!expected) return true; // verification optional
  const total = fs.statSync(filePath).size;
  let hashed = 0;
  const hash = crypto.createHash('sha256');
  await pipeline(
    fs.createReadStream(filePath),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        hashed += chunk.length;
        if (onProgress) {
          onProgress({ percent: (hashed / total) * 100, phase: 'verifying' });
        }
        yield chunk;
      }
    },
    // sink that discards
    fs.createWriteStream(process.platform === 'win32' ? 'NUL' : '/dev/null')
  );
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);
  }
  return true;
}

module.exports = { downloadFile, verifySha256, ensureDir };
