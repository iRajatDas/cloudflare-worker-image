import { Container, getRandom } from "@cloudflare/containers";

export class PhotonContainer extends Container {
  defaultPort = 8000;
  sleepAfter = "2m";

  onError(error, request) {
    console.log("Container error:", error, "url:", request?.url);
  }
}

// ─── Config ────────────────────────────────────────────────────
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_BULK_FILES = 20;
const MAX_BULK_TOTAL = 100 * 1024 * 1024; // 100 MB total per bulk job
const JOB_TTL_SECONDS = 3600; // 1 hour
const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
  "image/avif",
]);
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 100;

// ─── Helpers ───────────────────────────────────────────────────
const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

const jsonOk = (data, origin) =>
  Response.json(data, { status: 200, headers: corsHeaders(origin) });

const jsonError = (message, status, origin) =>
  Response.json({ error: message }, { status, headers: corsHeaders(origin) });

const inWhiteList = (env, url) => {
  const imageUrl = new URL(url);
  const whiteList = env.WHITE_LIST ? env.WHITE_LIST.split(",") : [];
  return !(
    whiteList.length &&
    !whiteList.find((hostname) => imageUrl.hostname.endsWith(hostname))
  );
};

function generateJobId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function checkRateLimit(request, env) {
  if (env.DISABLE_RATE_LIMIT === "true") return true;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const cache = caches.default;
  const cacheKey = new Request(`https://rate-limit.internal/rate-limit:${ip}`);
  const cached = await cache.match(cacheKey);
  let count = cached ? parseInt(await cached.text(), 10) || 0 : 0;
  if (count >= RATE_LIMIT_MAX) return false;
  await cache.put(
    cacheKey,
    new Response(String(count + 1), {
      headers: { "Cache-Control": `s-maxage=${RATE_LIMIT_WINDOW}` },
    })
  );
  return true;
}

// ─── GET / — existing URL-based processing ─────────────────────
async function handleGetProcess(request, env, context) {
  const cacheUrl = new URL(request.url);
  const cacheKey = new Request(cacheUrl.toString());
  const cache = caches.default;
  const cacheResponse = await cache.match(cacheKey);
  if (cacheResponse) return cacheResponse;

  const { pathname, searchParams } = new URL(request.url);
  const url = searchParams.get("url");

  if (!url && pathname === "/") {
    return Response.redirect(
      "https://github.com/iRajatDas/cloudflare-worker-image",
      302
    );
  }
  if (url && !inWhiteList(env, url)) {
    return new Response(null, { status: 403 });
  }

  const container = await getRandom(env.PHOTON_CONTAINER, 2);
  const imageResponse = await container.fetch(request);
  pathname === "/" &&
    context.waitUntil(cache.put(cacheKey, imageResponse.clone()));
  return imageResponse;
}

// ─── POST /process — single file upload (stream-through) ───────
async function handlePostProcess(request, env) {
  const origin = request.headers.get("Origin");
  const contentType = request.headers.get("Content-Type") || "";

  let imageBytes, originalFilename = "image", mimeType;

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("image") || formData.get("file");
    if (!file || !(file instanceof File)) {
      return jsonError('Missing "image" or "file" field', 400, origin);
    }
    mimeType = file.type;
    originalFilename = file.name?.replace(/\.[^.]+$/, "") || "image";
    imageBytes = await file.arrayBuffer();
  } else if (contentType.startsWith("image/")) {
    mimeType = contentType.split(";")[0].trim();
    imageBytes = await request.arrayBuffer();
  } else {
    return jsonError("Send multipart/form-data or raw image bytes", 400, origin);
  }

  if (!ALLOWED_MIMES.has(mimeType))
    return jsonError(`Unsupported type: ${mimeType}`, 415, origin);
  if (imageBytes.byteLength > MAX_FILE_SIZE)
    return jsonError(`File too large. Max: ${MAX_FILE_SIZE / 1024 / 1024} MB`, 413, origin);
  if (imageBytes.byteLength === 0)
    return jsonError("Empty file", 400, origin);

  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "";
  const format = searchParams.get("format") || "webp";
  const quality = searchParams.get("quality") || "";

  const container = await getRandom(env.PHOTON_CONTAINER, 2);
  const containerUrl = new URL("http://container/process");
  if (action) containerUrl.searchParams.set("action", action);
  containerUrl.searchParams.set("format", format);
  if (quality) containerUrl.searchParams.set("quality", quality);

  const containerResponse = await container.fetch(
    new Request(containerUrl.toString(), {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(imageBytes.byteLength),
      },
      body: imageBytes,
    })
  );

  if (!containerResponse.ok) {
    console.error("Container failed:", await containerResponse.text());
    return jsonError("Image processing failed", 502, origin);
  }

  const outputExt = format === "jpg" ? "jpeg" : format;
  const outputContentType =
    containerResponse.headers.get("Content-Type") || `image/${outputExt}`;
  const downloadFilename = `${originalFilename}.${outputExt}`;
  const processedBody = await containerResponse.arrayBuffer();
  const originalSize = imageBytes.byteLength;
  const processedSize = processedBody.byteLength;
  const savings = Math.max(0, ((originalSize - processedSize) / originalSize) * 100);

  return new Response(processedBody, {
    status: 200,
    headers: {
      "Content-Type": outputContentType,
      "Content-Disposition": `attachment; filename="${downloadFilename}"`,
      "Content-Length": String(processedSize),
      "X-Original-Size": String(originalSize),
      "X-Processed-Size": String(processedSize),
      "X-Savings-Percent": savings.toFixed(1),
      "X-Output-Format": format,
      "Access-Control-Expose-Headers":
        "X-Original-Size, X-Processed-Size, X-Savings-Percent, X-Output-Format, Content-Disposition",
      ...corsHeaders(origin),
    },
  });
}

// ─── POST /bulk — upload N files, start background processing ──
async function handleBulkUpload(request, env, context) {
  const origin = request.headers.get("Origin");
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.includes("multipart/form-data")) {
    return jsonError("POST /bulk requires multipart/form-data", 400, origin);
  }

  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") || "webp";
  const quality = searchParams.get("quality") || "";
  const action = searchParams.get("action") || "";

  const formData = await request.formData();

  // Collect all image files from the form (supports "images[]" or "images" or "file" field names)
  const files = [];
  for (const [key, value] of formData.entries()) {
    if (value instanceof File && ALLOWED_MIMES.has(value.type)) {
      files.push(value);
    }
  }

  if (files.length === 0) {
    return jsonError("No valid image files found in form data", 400, origin);
  }
  if (files.length > MAX_BULK_FILES) {
    return jsonError(`Too many files. Max: ${MAX_BULK_FILES}`, 400, origin);
  }

  // Validate individual sizes and total
  let totalSize = 0;
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return jsonError(
        `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max per file: ${MAX_FILE_SIZE / 1024 / 1024} MB`,
        413,
        origin
      );
    }
    totalSize += file.size;
  }
  if (totalSize > MAX_BULK_TOTAL) {
    return jsonError(
      `Total upload too large (${(totalSize / 1024 / 1024).toFixed(0)} MB). Max: ${MAX_BULK_TOTAL / 1024 / 1024} MB`,
      413,
      origin
    );
  }

  const jobId = generateJobId();

  // Build job manifest
  const fileManifest = files.map((f, i) => ({
    index: i,
    name: f.name,
    originalSize: f.size,
    mimeType: f.type,
    status: "pending", // pending → processing → done → error
    processedSize: null,
    savingsPercent: null,
    error: null,
  }));

  const jobState = {
    jobId,
    status: "processing",
    format,
    quality,
    action,
    totalFiles: files.length,
    completedFiles: 0,
    failedFiles: 0,
    files: fileManifest,
    createdAt: Date.now(),
  };

  // Store originals in R2 and job state in KV
  const uploadPromises = files.map(async (file, i) => {
    const bytes = await file.arrayBuffer();
    await env.IMAGE_BUCKET.put(`jobs/${jobId}/input/${i}-${file.name}`, bytes, {
      httpMetadata: { contentType: file.type },
    });
  });
  await Promise.all(uploadPromises);
  await env.JOB_STATE.put(`job:${jobId}`, JSON.stringify(jobState), {
    expirationTtl: JOB_TTL_SECONDS,
  });

  // Kick off background processing
  context.waitUntil(processJobInBackground(jobId, files, jobState, env));

  return jsonOk(
    {
      jobId,
      totalFiles: files.length,
      statusUrl: `/status/${jobId}`,
      downloadUrl: `/download/${jobId}`,
    },
    origin
  );
}

// ─── Background job processor ──────────────────────────────────
async function processJobInBackground(jobId, files, jobState, env) {
  const container = await getRandom(env.PHOTON_CONTAINER, 2);
  const { format, quality, action } = jobState;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const r2Key = `jobs/${jobId}/input/${i}-${file.name}`;

    try {
      // Update status to "processing"
      jobState.files[i].status = "processing";
      await env.JOB_STATE.put(`job:${jobId}`, JSON.stringify(jobState), {
        expirationTtl: JOB_TTL_SECONDS,
      });

      // Fetch from R2
      const r2Object = await env.IMAGE_BUCKET.get(r2Key);
      if (!r2Object) throw new Error("File not found in R2");
      const imageBytes = await r2Object.arrayBuffer();

      // Send to container
      const containerUrl = new URL("http://container/process");
      if (action) containerUrl.searchParams.set("action", action);
      containerUrl.searchParams.set("format", format);
      if (quality) containerUrl.searchParams.set("quality", quality);

      const containerResponse = await container.fetch(
        new Request(containerUrl.toString(), {
          method: "POST",
          headers: {
            "Content-Type": file.type,
            "Content-Length": String(imageBytes.byteLength),
          },
          body: imageBytes,
        })
      );

      if (!containerResponse.ok) {
        throw new Error(`Container returned ${containerResponse.status}`);
      }

      // Store result in R2
      const processedBytes = await containerResponse.arrayBuffer();
      const ext = format === "jpg" ? "jpeg" : format;
      const outName = file.name.replace(/\.[^.]+$/, "") + `.${ext}`;
      const outputContentType =
        containerResponse.headers.get("Content-Type") || `image/${ext}`;

      await env.IMAGE_BUCKET.put(
        `jobs/${jobId}/output/${outName}`,
        processedBytes,
        { httpMetadata: { contentType: outputContentType } }
      );

      // Update state
      const originalSize = imageBytes.byteLength;
      const processedSize = processedBytes.byteLength;
      jobState.files[i].status = "done";
      jobState.files[i].processedSize = processedSize;
      jobState.files[i].outputName = outName;
      jobState.files[i].savingsPercent = Math.max(
        0,
        ((originalSize - processedSize) / originalSize) * 100
      ).toFixed(1);
      jobState.completedFiles++;
    } catch (err) {
      console.error(`Job ${jobId} file ${i} failed:`, err);
      jobState.files[i].status = "error";
      jobState.files[i].error = err.message;
      jobState.failedFiles++;
    }

    // Save progress after each file
    await env.JOB_STATE.put(`job:${jobId}`, JSON.stringify(jobState), {
      expirationTtl: JOB_TTL_SECONDS,
    });
  }

  // Mark job complete
  jobState.status = "complete";
  await env.JOB_STATE.put(`job:${jobId}`, JSON.stringify(jobState), {
    expirationTtl: JOB_TTL_SECONDS,
  });

  // Clean up input files from R2 (keep outputs for download)
  for (let i = 0; i < files.length; i++) {
    await env.IMAGE_BUCKET.delete(
      `jobs/${jobId}/input/${i}-${files[i].name}`
    );
  }
}

// ─── GET /status/:jobId — poll for job progress ────────────────
async function handleJobStatus(jobId, env, origin) {
  const raw = await env.JOB_STATE.get(`job:${jobId}`);
  if (!raw) {
    return jsonError("Job not found or expired", 404, origin);
  }

  const job = JSON.parse(raw);

  return jsonOk(
    {
      jobId: job.jobId,
      status: job.status,
      totalFiles: job.totalFiles,
      completedFiles: job.completedFiles,
      failedFiles: job.failedFiles,
      files: job.files.map((f) => ({
        name: f.name,
        status: f.status,
        originalSize: f.originalSize,
        processedSize: f.processedSize,
        savingsPercent: f.savingsPercent,
        error: f.error,
      })),
    },
    origin
  );
}

// ─── GET /download/:jobId — stream ZIP of all processed files ──
async function handleJobDownload(jobId, env, origin) {
  const raw = await env.JOB_STATE.get(`job:${jobId}`);
  if (!raw) {
    return jsonError("Job not found or expired", 404, origin);
  }

  const job = JSON.parse(raw);

  if (job.status !== "complete") {
    return jsonError(
      `Job is still ${job.status}. Poll /status/${jobId} until complete.`,
      409,
      origin
    );
  }

  const doneFiles = job.files.filter((f) => f.status === "done");
  if (doneFiles.length === 0) {
    return jsonError("No successfully processed files", 404, origin);
  }

  // For single file, return it directly
  if (doneFiles.length === 1) {
    const f = doneFiles[0];
    const r2Object = await env.IMAGE_BUCKET.get(
      `jobs/${jobId}/output/${f.outputName}`
    );
    if (!r2Object) return jsonError("File not found", 404, origin);

    return new Response(r2Object.body, {
      headers: {
        "Content-Type": r2Object.httpMetadata?.contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${f.outputName}"`,
        ...corsHeaders(origin),
      },
    });
  }

  // For multiple files, build a ZIP
  // Using the minimal ZIP format (no compression — images are already compressed)
  const zipParts = [];
  const centralDir = [];
  let offset = 0;

  for (const f of doneFiles) {
    const r2Object = await env.IMAGE_BUCKET.get(
      `jobs/${jobId}/output/${f.outputName}`
    );
    if (!r2Object) continue;

    const fileData = new Uint8Array(await r2Object.arrayBuffer());
    const fileName = new TextEncoder().encode(f.outputName);
    const crc = crc32(fileData);

    // Local file header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + fileName.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression (store)
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true); // crc32
    lv.setUint32(18, fileData.length, true); // compressed size
    lv.setUint32(22, fileData.length, true); // uncompressed size
    lv.setUint16(26, fileName.length, true); // filename length
    lv.setUint16(28, 0, true); // extra field length
    localHeader.set(fileName, 30);

    // Central directory entry (46 bytes + filename)
    const cdEntry = new Uint8Array(46 + fileName.length);
    const cv = new DataView(cdEntry.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true); // crc32
    cv.setUint32(20, fileData.length, true); // compressed size
    cv.setUint32(24, fileData.length, true); // uncompressed size
    cv.setUint16(28, fileName.length, true); // filename length
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, 0, true); // external attributes
    cv.setUint32(42, offset, true); // local header offset
    cdEntry.set(fileName, 46);

    zipParts.push(localHeader, fileData);
    centralDir.push(cdEntry);
    offset += localHeader.length + fileData.length;
  }

  // End of central directory
  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDir) cdSize += cd.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centralDir.length, true);
  ev.setUint16(10, centralDir.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);

  // Concatenate everything
  const totalLength =
    zipParts.reduce((s, p) => s + p.length, 0) + cdSize + eocd.length;
  const zipBuffer = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of zipParts) {
    zipBuffer.set(part, pos);
    pos += part.length;
  }
  for (const cd of centralDir) {
    zipBuffer.set(cd, pos);
    pos += cd.length;
  }
  zipBuffer.set(eocd, pos);

  return new Response(zipBuffer.buffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="processed-images.zip"`,
      "Content-Length": String(totalLength),
      ...corsHeaders(origin),
    },
  });
}

// ─── CRC32 for ZIP (no dependencies) ───────────────────────────
function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Scheduled cleanup (optional, run via cron) ────────────────
async function handleScheduled(env) {
  // R2 objects under jobs/ older than JOB_TTL_SECONDS get cleaned up.
  // KV entries auto-expire via expirationTtl — no cleanup needed there.
  const listed = await env.IMAGE_BUCKET.list({ prefix: "jobs/" });
  const cutoff = Date.now() - JOB_TTL_SECONDS * 1000;

  for (const obj of listed.objects) {
    if (obj.uploaded.getTime() < cutoff) {
      await env.IMAGE_BUCKET.delete(obj.key);
    }
  }
}

// ─── Router ────────────────────────────────────────────────────
export default {
  async fetch(request, env, context) {
    const { method } = request;
    const url = new URL(request.url);
    const pathname = url.pathname;
    const origin = request.headers.get("Origin");

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // Rate limit POST requests
      if (method === "POST") {
        if (!(await checkRateLimit(request, env))) {
          return jsonError("Rate limit exceeded", 429, origin);
        }
      }

      // ── POST routes ──────────────────────────────────────────
      if (method === "POST" && pathname === "/bulk") {
        return await handleBulkUpload(request, env, context);
      }
      if (method === "POST" && (pathname === "/process" || pathname === "/")) {
        return await handlePostProcess(request, env);
      }

      // ── GET routes ───────────────────────────────────────────
      const statusMatch = pathname.match(/^\/status\/([a-z0-9]+)$/);
      if (method === "GET" && statusMatch) {
        return await handleJobStatus(statusMatch[1], env, origin);
      }

      const downloadMatch = pathname.match(/^\/download\/([a-z0-9]+)$/);
      if (method === "GET" && downloadMatch) {
        return await handleJobDownload(downloadMatch[1], env, origin);
      }

      if (method === "GET") {
        const response = await handleGetProcess(request, env, context);
        const newHeaders = new Headers(response.headers);
        Object.entries(corsHeaders(origin)).forEach(([k, v]) =>
          newHeaders.set(k, v)
        );
        return new Response(response.body, {
          status: response.status,
          headers: newHeaders,
        });
      }

      return jsonError("Method not allowed", 405, origin);
    } catch (error) {
      console.error("Request failed:", error, "url:", request.url);

      if (method === "GET") {
        const imgUrl = url.searchParams.get("url");
        if (imgUrl) return fetch(imgUrl);
      }

      return jsonError("Internal server error", 500, origin);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
