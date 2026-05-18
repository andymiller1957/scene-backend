const express = require('express');
const https = require('https');

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));

const KEY = process.env.REPLICATE_API_KEY;

function httpsRequest(method, hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const opts = { hostname, path, method, headers: { ...headers } };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function poll(id) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await httpsRequest('GET', 'api.replicate.com', `/v1/predictions/${id}`, null,
      { Authorization: `Bearer ${KEY}` });
    console.log('Poll:', r.data.status);
    if (r.data.status === 'succeeded') {
      console.log('RAW OUTPUT:', JSON.stringify(r.data.output));
      return r.data;
    }
    if (r.data.status === 'failed') throw new Error(r.data.error || 'Prediction failed');
  }
  throw new Error('Timed out');
}

async function uploadImage(base64DataUrl) {
  const matches = base64DataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid image format');
  const mimeType = matches[1];
  const imageBuffer = Buffer.from(matches[2], 'base64');
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="image.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, imageBuffer, footer]);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.replicate.com', path: '/v1/files', method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          console.log('Upload:', res.statusCode, d.urls?.get || d.detail || '');
          if (d.urls?.get) resolve(d.urls.get);
          else reject(new Error('Upload failed: ' + raw.slice(0, 200)));
        } catch(e) { reject(new Error('Upload error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runPrediction(path, input) {
  const body = input.version
    ? { version: input.version, input: Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'version')) }
    : { input };
  const r = await httpsRequest('POST', 'api.replicate.com', path, body,
    { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
  console.log('Prediction:', r.status, r.data.id, r.data.error || '');
  let result = r.data;
  if (result.id && result.status !== 'succeeded') result = await poll(result.id);
  const output = result.output || result.urls?.get || null;
  if (!output) throw new Error('No output: ' + JSON.stringify(result).slice(0, 200));
  const url = Array.isArray(output) ? output[0] : output;
  return typeof url === 'object' ? (url.url ? url.url() : JSON.stringify(url)) : url;
}

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/debug', (req, res) => res.json({ hasKey: !!KEY, keyStart: KEY ? KEY.slice(0, 8) : 'MISSING' }));

// FLUX — fast scene, no face
app.post('/generate', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    console.log('FLUX:', prompt.slice(0, 60));
    const url = await runPrediction('/v1/models/black-forest-labs/flux-schnell/predictions',
      { prompt, num_outputs: 1, aspect_ratio: '3:4', output_format: 'webp', output_quality: 90 });
    res.json({ imageUrl: url });
  } catch(e) {
    console.error('FLUX error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Face mode: FLUX scene + better face swap + upscale
app.post('/generate-face', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set' });
  const { imageBase64, prompt } = req.body;
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'imageBase64 and prompt required' });

  try {
    // Step 1: Upload face photo
    console.log('Uploading face photo...');
    const faceUrl = await uploadImage(imageBase64);
    console.log('Face uploaded:', faceUrl);

    // Step 2: Generate scene with FLUX
    console.log('Generating scene with FLUX...');
    const sceneUrl = await runPrediction('/v1/models/black-forest-labs/flux-schnell/predictions',
      { prompt, num_outputs: 1, aspect_ratio: '3:4', output_format: 'webp', output_quality: 90 });
    console.log('Scene generated:', sceneUrl);

    // Step 3: High quality face swap with easel/advanced-face-swap
    console.log('Swapping face (high quality)...');
    const faceSwapUrl = await runPrediction('/v1/models/easel/advanced-face-swap/predictions', {
      swap_image: faceUrl,
      target_image: sceneUrl,
      hair_source: 'target'
    });
    console.log('Face swap done:', faceSwapUrl);

    // Step 4: Upscale final result
    console.log('Upscaling result...');
    const upscaledUrl = await runPrediction('/v1/predictions', {
      version: 'f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd374d',
      image: faceSwapUrl,
      scale: 2,
      face_enhance: true
    });
    console.log('Upscale done:', upscaledUrl);

    res.json({ imageUrl: upscaledUrl, sceneUrl, faceSwapUrl });
  } catch(e) {
    console.error('Face mode error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Running on ${PORT}`));
