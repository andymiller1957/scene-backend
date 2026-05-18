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
    const opts = {
      hostname, path, method,
      headers: { ...headers }
    };
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
    if (r.data.status === 'succeeded') return r.data;
    if (r.data.status === 'failed') throw new Error(r.data.error || 'Prediction failed');
  }
  throw new Error('Timed out');
}

// Upload base64 image to Replicate and get back a URL
async function uploadImage(base64DataUrl) {
  // Extract mime type and base64 data
  const matches = base64DataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid image format');
  const mimeType = matches[1];
  const base64Data = matches[2];
  const imageBuffer = Buffer.from(base64Data, 'base64');

  // Get upload URL from Replicate
  const uploadReq = await httpsRequest('POST', 'api.replicate.com', '/v1/files', 
    null,
    { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
  );

  // Use multipart upload via direct buffer post
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="image.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, imageBuffer, footer]);

    const req = https.request({
      hostname: 'api.replicate.com',
      path: '/v1/files',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          console.log('Upload response:', res.statusCode, d.urls?.get || d.detail || '');
          if (d.urls?.get) resolve(d.urls.get);
          else reject(new Error('Upload failed: ' + raw.slice(0, 200)));
        } catch(e) { reject(new Error('Upload parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/debug', (req, res) => res.json({ hasKey: !!KEY, keyStart: KEY ? KEY.slice(0, 8) : 'MISSING' }));

// FLUX Schnell — fast, no face
app.post('/generate', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    console.log('FLUX generating:', prompt.slice(0, 60));
    const r = await httpsRequest('POST', 'api.replicate.com',
      '/v1/models/black-forest-labs/flux-schnell/predictions',
      { input: { prompt, num_outputs: 1, aspect_ratio: '3:4', output_format: 'webp', output_quality: 90 } },
      { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
    );
    console.log('FLUX response:', r.status, r.data.id, r.data.error || '');
    let result = r.data;
    if (result.id && result.status !== 'succeeded') result = await poll(result.id);
    if (!result.output) return res.status(500).json({ error: 'No output', raw: result });
    const url = Array.isArray(result.output) ? result.output[0] : result.output;
    res.json({ imageUrl: url });
  } catch (e) {
    console.error('FLUX error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// FLUX Kontext Pro — face preservation
app.post('/generate-face', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set' });
  const { imageBase64, prompt } = req.body;
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'imageBase64 and prompt required' });
  try {
    console.log('Uploading image to Replicate...');
    const imageUrl = await uploadImage(imageBase64);
    console.log('Image uploaded:', imageUrl);

    console.log('Kontext generating:', prompt.slice(0, 60));
    const r = await httpsRequest('POST', 'api.replicate.com',
      '/v1/models/black-forest-labs/flux-kontext-pro/predictions',
      { input: { input_image: imageUrl, prompt, aspect_ratio: "3:4", output_format: "jpg", output_quality: 99, safety_tolerance: 2 } },
      { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
    );
    console.log('Kontext response:', r.status, r.data.id, r.data.error || JSON.stringify(r.data).slice(0,100));
    let result = r.data;
    if (result.id && result.status !== 'succeeded') result = await poll(result.id);
    if (!result.output) return res.status(500).json({ error: 'No output', raw: result });
    const url = Array.isArray(result.output) ? result.output[0] : result.output;
    res.json({ imageUrl: url });
  } catch (e) {
    console.error('Kontext error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Running on ${PORT}`));
