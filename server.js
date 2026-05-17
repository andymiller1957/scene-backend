const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

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

async function poll(url) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    const d = await r.json();
    console.log('Poll status:', d.status);
    if (d.status === 'succeeded') return d;
    if (d.status === 'failed' || d.status === 'canceled') throw new Error(d.error || 'Failed');
  }
  throw new Error('Timed out');
}

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/debug', (req, res) => {
  res.json({
    hasKey: !!KEY,
    keyStart: KEY ? KEY.slice(0, 6) : 'MISSING'
  });
});

// FLUX — using versioned API call for reliability
app.post('/generate', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    console.log('Generating with prompt:', prompt.slice(0, 80));
    
    // Use the versioned prediction endpoint
    const r = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${KEY}`, 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db',
        input: { 
          prompt,
          num_outputs: 1,
          aspect_ratio: '3:4',
          output_format: 'webp',
          output_quality: 90
        }
      })
    });

    let d = await r.json();
    console.log('Initial response:', JSON.stringify(d).slice(0, 300));

    if (d.urls?.get && d.status !== 'succeeded') {
      d = await poll(d.urls.get);
    }

    console.log('Final output:', d.output);

    if (!d.output) return res.status(500).json({ error: 'No output', raw: d });
    const url = Array.isArray(d.output) ? d.output[0] : d.output;
    res.json({ imageUrl: url });

  } catch (e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// InstantID
app.post('/generate-face', async (req, res) => {
  if (!KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set' });
  const { imageBase64, prompt } = req.body;
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'imageBase64 and prompt required' });

  try {
    const r = await fetch('https://api.replicate.com/v1/models/zsxkib/instant-id/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'wait' },
      body: JSON.stringify({ input: { image: imageBase64, prompt, negative_prompt: 'blurry, low quality, deformed, watermark', num_inference_steps: 30, guidance_scale: 5, ip_adapter_scale: 0.8, controlnet_conditioning_scale: 0.8 } })
    });
    let d = await r.json();
    if (d.urls?.get && d.status !== 'succeeded') d = await poll(d.urls.get);
    if (!d.output) return res.status(500).json({ error: d.error || 'No output', raw: d });
    const url = Array.isArray(d.output) ? d.output[0] : d.output;
    res.json({ imageUrl: url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Running on ${PORT}`));
