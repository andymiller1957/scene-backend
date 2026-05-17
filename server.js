const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Explicit CORS — must be before all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
const REPLICATE_BASE = 'https://api.replicate.com/v1';

function requireApiKey(req, res, next) {
  if (!REPLICATE_API_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not set on server' });
  next();
}

async function replicatePost(path, body) {
  const res = await fetch(`${REPLICATE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_API_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'wait',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function replicateGet(url) {
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${REPLICATE_API_KEY}` },
  });
  return res.json();
}

async function pollUntilDone(getUrl, maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const data = await replicateGet(getUrl);
    if (data.status === 'succeeded') return data;
    if (data.status === 'failed' || data.status === 'canceled') {
      throw new Error(`Prediction ${data.status}: ${data.error || 'unknown error'}`);
    }
  }
  throw new Error('Prediction timed out after 100 seconds');
}

// GET /health
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// POST /generate — InstantID with face
app.post('/generate', requireApiKey, async (req, res) => {
  const { imageBase64, prompt, negativePrompt } = req.body;

  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    let data = await replicatePost('/models/zsxkib/instant-id/predictions', {
      input: {
        image: imageBase64,
        prompt,
        negative_prompt: negativePrompt || 'blurry, low quality, deformed, cartoon, painting, watermark',
        num_inference_steps: 30,
        guidance_scale: 5,
        ip_adapter_scale: 0.8,
        controlnet_conditioning_scale: 0.8,
        num_outputs: 1,
      },
    });

    if (data.status && data.status !== 'succeeded' && data.urls?.get) {
      data = await pollUntilDone(data.urls.get);
    }

    if (!data.output) {
      return res.status(500).json({ error: data.error || 'No output from model', detail: data });
    }

    const output = Array.isArray(data.output) ? data.output[0] : data.output;
    res.json({ imageUrl: output, predictionId: data.id });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /generate-scene — FLUX without face
app.post('/generate-scene', requireApiKey, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    let data = await replicatePost('/models/black-forest-labs/flux-schnell/predictions', {
      input: {
        prompt,
        num_outputs: 2,
        aspect_ratio: '3:4',
        output_format: 'webp',
        output_quality: 90,
      },
    });

    if (data.status && data.status !== 'succeeded' && data.urls?.get) {
      data = await pollUntilDone(data.urls.get);
    }

    if (!data.output) return res.status(500).json({ error: data.error || 'No output' });
    res.json({ images: Array.isArray(data.output) ? data.output : [data.output] });

  } catch (err) {
    console.error('Scene error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Scene backend running on http://localhost:${PORT}`));
