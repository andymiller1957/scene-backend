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
    if (r.data.status === 'succeeded') { console.log('Output:', JSON.stringify(r.data.output)); return r.data; }
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
  // If input has a version field, move it to top level
  const body = input.version ? { version: input.version, input: Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'version')) } : { input };
  const r = await httpsRequest('POST', 'api.replicate.com', path, body,
    { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Prefer': 'wait=60'};
  console.log('Prediction response:', r.status, r.data.id, r.data.error || '');
  let result = r.data;
  if (result.id && result.status !== 'succeeded') result = await poll(result.id);
  const output = result.output || result.urls?.get || null;
if (!output) throw new Error('No output: ' + JSON.stringify(result).slice(0, 200));
return Array.isArray(output) ? output[0] : output;
console.log('Output type:', typeof out, 'Value:', JSON.stringify(out).slice(0, 200));
if (out && typeof out === 'object' && out.url) return out.url();
return out;
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

// Face mode: generate scene with FLUX then swap face
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

    // Step 3: Swap face onto scene
console.log('Swapping face...');
const faceSwapUrl = await runPrediction('/v1/predictions', {
  version: '278a81e7ebb22db98bcba54de985d22cc1abeead2754eb1f2af717247be69b34',
  input_image: sceneUrl,
  swap_image: faceUrl
});
    console.log('Face swap done:', faceSwapUrl);

    res.json({ imageUrl: faceSwapUrl, sceneUrl });
  } catch(e) {
    console.error('Face mode error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Running on ${PORT}`));
