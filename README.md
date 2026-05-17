# Scene Backend

Node.js/Express backend that proxies Replicate API calls for image generation.
Solves the CORS issue that prevents direct browser-to-Replicate API calls.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /generate | InstantID — generate scene with your face |
| POST | /generate-scene | FLUX — generate scene without reference photo |

## Local Setup

### 1. Install dependencies
```bash
cd scene-backend
npm install
```

### 2. Create your .env file
```bash
cp .env.example .env
```
Open `.env` and set your Replicate API key:
```
REPLICATE_API_KEY=r8_your_key_here
ALLOWED_ORIGIN=http://localhost:3000
PORT=3001
```

### 3. Run the server
```bash
npm run dev      # development (auto-restarts on change)
npm start        # production
```

The server runs at http://localhost:3001

---

## Deploying to Railway (recommended — free tier)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub repo**
4. Select your repo
5. Go to **Variables** tab and add:
   - `REPLICATE_API_KEY` = your key
   - `ALLOWED_ORIGIN` = your frontend URL (or `*` for now)
6. Railway auto-detects Node.js and deploys
7. Copy the generated URL (e.g. `https://scene-backend-production.up.railway.app`)

---

## Deploying to Render (free tier)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your repo
4. Set:
   - Build command: `npm install`
   - Start command: `npm start`
5. Add environment variables in the dashboard
6. Deploy

---

## API Usage

### POST /generate (InstantID with face)
```json
{
  "imageBase64": "data:image/jpeg;base64,/9j/4AAQ...",
  "prompt": "A woman riding a majestic horse, golden hour lighting, editorial style",
  "negativePrompt": "blurry, low quality"
}
```
Response:
```json
{
  "imageUrl": "https://replicate.delivery/...",
  "predictionId": "abc123"
}
```

### POST /generate-scene (FLUX, no face)
```json
{
  "prompt": "A woman on a tropical beach, golden hour, cinematic"
}
```
Response:
```json
{
  "images": ["https://replicate.delivery/...", "https://replicate.delivery/..."]
}
```

---

## Connecting the Frontend Widget

Once deployed, update the widget's API calls to point to your backend URL:

```javascript
// Instead of calling Replicate directly:
const res = await fetch('https://YOUR-BACKEND-URL.railway.app/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    imageBase64: 'data:image/jpeg;base64,...',
    prompt: 'your prompt here'
  })
});
const data = await res.json();
console.log(data.imageUrl);
```

No API key needed in the frontend — it stays safely on the server.
