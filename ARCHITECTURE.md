# Image Processing API — Extension Architecture

## What Changed

Your existing repo processes remote images via `GET /?url=...&action=...`.
The extension adds a **POST /process** endpoint that accepts direct image uploads
from the browser, processes them through the same Photon container, and streams
back the result as a downloadable file. No R2, no temp storage — zero storage cost.

## Files Modified

```
src/index.js                        ← Worker: POST handler, CORS, rate limit, validation
photon-container/src/main.rs        ← Rust: POST /process route
photon-container/src/processor.rs   ← Rust: process_uploaded_image() + refactored shared helpers
wrangler.jsonc                      ← max_instances bumped to 3, rate limit config
```

Everything else (actions.rs, encoder.rs, error.rs, utils.rs, Dockerfile, Cargo.toml) is **unchanged**.

---

## API Contract

### POST /process

Upload an image, get a processed image back.

**Request:**
```
POST /process?format=webp&quality=80&action=resize!800,600,2
Content-Type: multipart/form-data

form field: "image" or "file" = <binary>
```

Alternative (raw binary):
```
POST /process?format=webp&quality=80
Content-Type: image/jpeg

<raw image bytes>
```

**Query Parameters:**

| Param     | Required | Default | Description |
|-----------|----------|---------|-------------|
| `format`  | No       | `webp`  | Output: `webp`, `jpg`, `png`, `avif`, `gif`, `bmp`, `tiff` |
| `quality` | No       | `95`    | 1-100, only for `webp`, `jpg`, `avif` |
| `action`  | No       | —       | Photon pipeline, e.g. `resize!800,600,2\|grayscale` |

**Response (200):**
```
Content-Type: image/webp
Content-Disposition: attachment; filename="photo.webp"
X-Original-Size: 2456789
X-Processed-Size: 198432
X-Savings-Percent: 91.9
X-Output-Format: webp
```
Body = processed image bytes

**Error Responses:**
```json
// 400 - Missing/invalid file
{ "error": "Missing \"image\" or \"file\" field in form data" }

// 413 - Too large
{ "error": "File too large (12.3 MB). Max: 10 MB" }

// 415 - Unsupported type
{ "error": "Unsupported image type: application/pdf. Supported: image/jpeg, image/png, ..." }

// 429 - Rate limited
{ "error": "Rate limit exceeded. Max 30 requests per minute." }

// 502 - Container failed
{ "error": "Image processing failed. Try a different format or smaller image." }
```

### GET / (unchanged)

Remote URL processing. Same as before.

```
GET /?url=https%3A%2F%2Fexample.com%2Fphoto.jpg&action=resize!800,600&format=webp&quality=80
```

---

## Frontend Integration

### Minimal JS (vanilla)

```js
async function processImage(file, { format = 'webp', quality = 80, action = '' } = {}) {
  const form = new FormData();
  form.append('image', file);

  const params = new URLSearchParams({ format, quality });
  if (action) params.set('action', action);

  const res = await fetch(`https://YOUR-WORKER.workers.dev/process?${params}`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error);
  }

  return {
    blob: await res.blob(),
    originalSize: +res.headers.get('X-Original-Size'),
    processedSize: +res.headers.get('X-Processed-Size'),
    savings: +res.headers.get('X-Savings-Percent'),
    format: res.headers.get('X-Output-Format'),
  };
}

// Usage
const input = document.querySelector('input[type="file"]');
input.addEventListener('change', async (e) => {
  const result = await processImage(e.target.files[0], {
    format: 'webp',
    quality: 75,
    action: 'resize!1200,0,2', // width=1200, auto height, Lanczos3
  });

  // Download link
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `compressed.${result.format}`;
  a.click();

  console.log(`Saved ${result.savings}% — ${result.originalSize} → ${result.processedSize} bytes`);
});
```

### React/TanStack example

```tsx
const processImage = async (file: File, opts: ProcessOpts) => {
  const form = new FormData();
  form.append('image', file);

  const params = new URLSearchParams({
    format: opts.format ?? 'webp',
    quality: String(opts.quality ?? 80),
  });
  if (opts.action) params.set('action', opts.action);

  const res = await fetch(`${API_URL}/process?${params}`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) throw new Error((await res.json()).error);

  return {
    blob: await res.blob(),
    originalSize: +(res.headers.get('X-Original-Size') ?? 0),
    processedSize: +(res.headers.get('X-Processed-Size') ?? 0),
    savings: +(res.headers.get('X-Savings-Percent') ?? 0),
  };
};
```

---

## Common Action Recipes

For your website's UI, these are the most useful presets:

```
# Compress only (no resize) — just set format + quality
format=webp&quality=75

# Resize to max width 1200, keep aspect ratio
action=resize!1200,0,2&format=webp&quality=80

# Resize to exact 800x600
action=resize!800,600,2&format=jpg&quality=85

# Thumbnail 200x200
action=resize!200,200,1&format=webp&quality=70

# Grayscale + compress
action=grayscale&format=webp&quality=75

# Sharpen + compress
action=sharpen&format=webp&quality=80
```

---

## Cost Analysis (5,000 active users)

### Cloudflare Workers (Paid plan — $5/mo)
- 10M requests/mo included
- 5K users × ~20 images/day = 100K req/day = 3M req/mo → well within limits

### Cloudflare Containers
- max_instances: 3 (basic tier)
- Containers sleep after 2min idle, so you're only paying for active compute
- With 5K users, expect 1-2 containers active during peak, 0 off-peak
- Estimated: ~$15-30/mo depending on usage patterns

### Total estimated: ~$20-35/mo

### When to worry
- **>50K daily users**: bump max_instances to 5-6
- **>10MB average images**: consider client-side pre-resize before upload
- **Need batch downloads**: add R2 ($0.015/GB/mo) + presigned URLs

---

## Rate Limiting

Uses Cloudflare Cache API as a lightweight counter (no KV needed):
- 30 requests/min per IP for POST uploads
- No limit on GET (cached responses)
- Set `DISABLE_RATE_LIMIT=true` in wrangler.jsonc vars for development

For stricter control at scale, swap to Cloudflare Rate Limiting rules in the dashboard
(more granular, supports geographic rules, costs $0.05/10K good requests).

---

## Deployment

Same as before:

```bash
pnpm install
npm run deploy
```

The Dockerfile is unchanged — the Rust container auto-rebuilds on deploy.

---

## Request Flow

```
Browser                    CF Worker                 Photon Container
  │                            │                            │
  │  POST /process?format=webp │                            │
  │  + multipart image         │                            │
  │ ──────────────────────────>│                            │
  │                            │  rate limit check          │
  │                            │  validate size/mime        │
  │                            │                            │
  │                            │  POST /process?format=webp │
  │                            │  + raw image bytes         │
  │                            │ ──────────────────────────>│
  │                            │                            │  decode image
  │                            │                            │  apply actions
  │                            │                            │  encode to format
  │                            │      processed image bytes │
  │                            │ <──────────────────────────│
  │                            │                            │
  │  200 OK                    │                            │
  │  Content-Disposition:      │                            │
  │    attachment               │                            │
  │  X-Savings-Percent: 87.3   │                            │
  │  + processed image bytes   │                            │
  │ <──────────────────────────│                            │
```
