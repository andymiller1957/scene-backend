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

function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Invalid JSON: ' + raw.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Invalid JSON: ' + raw.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function poll(id) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const d = await httpsGet('api.replicate.com', `/v1/predictions/${id}`, { Authorization: `Bearer ${KEY}` });
    console.log('Poll:', d.status);
    if (d.status === 'succeeded') return d;
    if (d.status === 'failed') throw new Error(d.error || 'Prediction failed');
  }
  throw new Error('Timed out');
}

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/debug', (req, res) => res.json({ hasKey: !!KEY, keyStart: KEY ? KEY.slice(0, 8) : 'MISSING' }));

// FLUX Schnell — fast scene generation, no face
app.post('/generate', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    console.log('FLUX generating:', prompt.slice(0, 60));
    const d = await httpsPost('api.replicate.com',
      '/v1/models/black-forest-labs/flux-schnell/predictions',
      { input: { prompt, num_outputs: 1, aspect_ratio: '3:4', output_format: 'webp', output_quality: 90 } },
      { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
    );
    console.log('Response:', d.status, d.id, d.error || '');
    let result = d;
    if (d.id && d.status !== 'succeeded') result = await poll(d.id);
    if (!result.output) return res.status(500).json({ error: 'No output', raw: result });
    const url = Array.isArray(result.output) ? result.output[0] : result.output;
    res.json({ imageUrl: url });
  } catch (e) {
    console.error('FLUX error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// FLUX Kontext Pro — best face preservation, places person in scene
app.post('/generate-face', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set' });
  const { imageBase64, prompt } = req.body;
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'imageBase64 and prompt required' });
  try {
    console.log('Kontext generating:', prompt.slice(0, 60));
    const d = await httpsPost('api.replicate.com',
      '/v1/models/black-forest-labs/flux-kontext-pro/predictions',
      { input: { input_image: imageBase64, prompt, aspect_ratio: '3:4', output_format: 'webp', output_quality: 90, safety_tolerance: 2 } },
      { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
    );
    console.log('Kontext response:', d.status, d.id, d.error || '');
    let result = d;
    if (d.id && d.status !== 'succeeded') result = await poll(d.id);
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
