'use strict';

// Drives the headless ComfyUI over its HTTP + websocket API. The renderer never
// talks to ComfyUI directly; it calls IPC, which calls this.
//
// Flow: fill a workflow template → (optionally upload an input image) →
// POST /prompt → watch /ws for execution progress → GET /history → read the
// saved image bytes off disk.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws'); // ComfyUI portable bundles nothing for us; we ship ws
const { paths } = require('./config');

const WORKFLOW_DIR = path.join(__dirname, '..', 'workflows');

function loadTemplate(name) {
  return fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8');
}

function httpJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (e) {
            reject(new Error(`Bad JSON from ComfyUI: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Upload a PNG/JPEG buffer to ComfyUI's input folder; returns the name to
// reference in a LoadImage node.
function uploadImage(port, buffer, filename) {
  return new Promise((resolve, reject) => {
    const boundary = '----EasyDiffusion' + crypto.randomBytes(8).toString('hex');
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([head, buffer, tail]);

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/upload/image',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) return reject(new Error(`upload failed: ${text}`));
          try {
            resolve(JSON.parse(text).name || filename);
          } catch (_) {
            resolve(filename);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Substitute placeholders and apply per-request params into a template.
function buildWorkflow(templateName, params) {
  const wf = JSON.parse(loadTemplate(templateName));
  const walk = (obj) => {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        obj[k] = v
          .replace('__POSITIVE__', params.positive || '')
          .replace('__NEGATIVE__', params.negative || 'lowres, bad anatomy, worst quality')
          .replace('__CKPT_NAME__', params.ckptName)
          .replace('__INPUT_IMAGE__', params.inputImageName || '');
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  };
  walk(wf);

  // Numeric params live on the KSampler node ("3").
  const k = wf['3'] && wf['3'].inputs;
  if (k) {
    k.seed = params.seed != null ? params.seed : Math.floor(Math.random() * 1e15);
    if (params.steps) k.steps = params.steps;
    if (params.cfg) k.cfg = params.cfg;
    if (params.denoise != null) k.denoise = params.denoise;
  }
  if (wf['5'] && wf['5'].inputs) {
    if (params.width) wf['5'].inputs.width = params.width;
    if (params.height) wf['5'].inputs.height = params.height;
  }

  // Optional face-enhancement pass (Impact Pack FaceDetailer). Only applied
  // when the caller has confirmed the nodes+model are installed. Inserts
  // between VAEDecode ("8") and SaveImage ("9"): detect faces on the decoded
  // image, re-render them, then save the refined result.
  if (params.enhanceFaces && wf['8'] && wf['9']) {
    // Node 20: the YOLO bbox detector provider.
    wf['20'] = {
      class_type: 'UltralyticsDetectorProvider',
      inputs: { model_name: 'bbox/face_yolov8m.pt' },
    };
    // Node 21: FaceDetailer. Inputs mirror the base sampler so the re-render
    // matches the model/prompt. Scalars are the node's documented defaults,
    // with a modest denoise so faces are cleaned, not replaced.
    wf['21'] = {
      class_type: 'FaceDetailer',
      inputs: {
        image: ['8', 0],
        model: ['4', 0],
        clip: ['4', 1],
        vae: ['4', 2],
        positive: ['6', 0],
        negative: ['7', 0],
        bbox_detector: ['20', 0],
        guide_size: 512,
        guide_size_for: true,
        max_size: 1024,
        seed: params.seed != null ? params.seed : Math.floor(Math.random() * 1e15),
        steps: 20,
        cfg: 7.0,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 0.4,
        feather: 5,
        noise_mask: true,
        force_inpaint: true,
        bbox_threshold: 0.5,
        bbox_dilation: 10,
        bbox_crop_factor: 3.0,
        sam_detection_hint: 'center-1',
        sam_dilation: 0,
        sam_threshold: 0.93,
        sam_bbox_expansion: 0,
        sam_mask_hint_threshold: 0.7,
        sam_mask_hint_use_negative: 'False',
        drop_size: 10,
        wildcard: '',
        cycle: 1,
      },
    };
    // Re-route SaveImage to the FaceDetailer's refined image output (index 0).
    wf['9'].inputs.images = ['21', 0];
  }
  return wf;
}

// Run one generation end to end. onProgress({ value, max, node }).
async function generate(port, { mode, params, inputImage, onProgress }) {
  const clientId = crypto.randomUUID();

  // Upload the source image for img2img/inpaint.
  if (inputImage && inputImage.buffer) {
    params.inputImageName = await uploadImage(
      port,
      inputImage.buffer,
      inputImage.filename || 'input.png'
    );
  }

  const templateName = mode === 'img2img' ? 'img2img.json' : 'txt2img.json';
  const workflow = buildWorkflow(templateName, params);

  // Open the websocket BEFORE queuing so we don't miss early events.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${clientId}`);
  const done = new Promise((resolve, reject) => {
    let promptId = null;
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return; // binary preview frames; ignore
      }
      if (msg.type === 'progress' && onProgress) {
        onProgress({ value: msg.data.value, max: msg.data.max, node: msg.data.node });
      }
      if (msg.type === 'executing' && msg.data.node === null && msg.data.prompt_id === promptId) {
        resolve(promptId); // this prompt finished
      }
      if (msg.type === 'execution_error' && msg.data.prompt_id === promptId) {
        reject(new Error(msg.data.exception_message || 'Execution error in engine'));
      }
    });
    ws.on('error', reject);
    ws.once('open', async () => {
      try {
        const res = await httpJson(port, 'POST', '/prompt', { prompt: workflow, client_id: clientId });
        promptId = res.prompt_id;
      } catch (e) {
        reject(e);
      }
    });
  });

  const promptId = await done;
  ws.close();

  // Pull the output image path from history.
  const history = await httpJson(port, 'GET', `/history/${promptId}`);
  const entry = history[promptId];
  const images = [];
  for (const nodeId of Object.keys(entry.outputs || {})) {
    for (const img of entry.outputs[nodeId].images || []) {
      const filePath = path.join(paths().outputDir, img.subfolder || '', img.filename);
      images.push(filePath);
    }
  }
  return images;
}

module.exports = { generate, buildWorkflow };
