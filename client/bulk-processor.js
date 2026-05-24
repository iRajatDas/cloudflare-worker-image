/**
 * Bulk Image Processor — Client Library
 *
 * Single upload → job ID → poll → download ZIP.
 * No parallel requests, no client-side zipping.
 *
 * Usage:
 *   import { BulkProcessor } from './bulk-processor';
 *
 *   const processor = new BulkProcessor('https://image.your-domain.workers.dev');
 *
 *   const job = await processor.upload(files, {
 *     format: 'webp',
 *     quality: 75,
 *     action: 'resize!1200,0,2',
 *   });
 *
 *   // Poll with progress callback
 *   const result = await processor.waitForCompletion(job.jobId, {
 *     onProgress: (status) => {
 *       console.log(`${status.completedFiles}/${status.totalFiles} done`);
 *       // status.files[i].status = 'pending' | 'processing' | 'done' | 'error'
 *     },
 *   });
 *
 *   // Download ZIP (or single file)
 *   await processor.download(job.jobId, 'my-images.zip');
 */

export class BulkProcessor {
  constructor(apiUrl = "") {
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  /**
   * Upload N files in a single request. Returns immediately with a job ID.
   *
   * @param {File[] | FileList} files
   * @param {{ format?: string, quality?: number, action?: string }} opts
   * @returns {Promise<{ jobId: string, totalFiles: number, statusUrl: string, downloadUrl: string }>}
   */
  async upload(files, opts = {}) {
    const { format = "webp", quality = 80, action = "" } = opts;

    const form = new FormData();
    for (const file of files) {
      form.append("images", file);
    }

    const params = new URLSearchParams({ format, quality: String(quality) });
    if (action) params.set("action", action);

    const res = await fetch(`${this.apiUrl}/bulk?${params}`, {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Upload failed: HTTP ${res.status}`);
    }

    return res.json();
  }

  /**
   * Poll job status once.
   *
   * @param {string} jobId
   * @returns {Promise<JobStatus>}
   */
  async getStatus(jobId) {
    const res = await fetch(`${this.apiUrl}/status/${jobId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Status check failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  /**
   * Poll until the job is complete. Returns final status.
   *
   * @param {string} jobId
   * @param {{ onProgress?: (status: JobStatus) => void, pollInterval?: number, timeout?: number, signal?: AbortSignal }} opts
   * @returns {Promise<JobStatus>}
   */
  async waitForCompletion(jobId, opts = {}) {
    const {
      onProgress,
      pollInterval = 2000,
      timeout = 5 * 60 * 1000, // 5 min
      signal,
    } = opts;

    const start = Date.now();

    while (true) {
      if (signal?.aborted) throw new Error("Cancelled");
      if (Date.now() - start > timeout) throw new Error("Job timed out");

      const status = await this.getStatus(jobId);
      onProgress?.(status);

      if (status.status === "complete") {
        return status;
      }

      // Wait before next poll
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, pollInterval);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Cancelled"));
          },
          { once: true }
        );
      });
    }
  }

  /**
   * Trigger download of processed files (ZIP or single file).
   *
   * @param {string} jobId
   * @param {string} [filename='processed-images.zip']
   */
  async download(jobId, filename = "processed-images.zip") {
    const res = await fetch(`${this.apiUrl}/download/${jobId}`);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Download failed: HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /**
   * Single-file processing (stream-through, no job/poll needed).
   *
   * @param {File} file
   * @param {{ format?: string, quality?: number, action?: string }} opts
   * @returns {Promise<{ blob: Blob, originalSize: number, processedSize: number, savingsPercent: number }>}
   */
  async processSingle(file, opts = {}) {
    const { format = "webp", quality = 80, action = "" } = opts;

    const form = new FormData();
    form.append("image", file);

    const params = new URLSearchParams({ format, quality: String(quality) });
    if (action) params.set("action", action);

    const res = await fetch(`${this.apiUrl}/process?${params}`, {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Processing failed: HTTP ${res.status}`);
    }

    return {
      blob: await res.blob(),
      originalSize: +(res.headers.get("X-Original-Size") ?? file.size),
      processedSize: +(res.headers.get("X-Processed-Size") ?? 0),
      savingsPercent: +(res.headers.get("X-Savings-Percent") ?? 0),
    };
  }
}

/**
 * @typedef {Object} JobStatus
 * @property {string} jobId
 * @property {'processing' | 'complete'} status
 * @property {number} totalFiles
 * @property {number} completedFiles
 * @property {number} failedFiles
 * @property {Array<{
 *   name: string,
 *   status: 'pending' | 'processing' | 'done' | 'error',
 *   originalSize: number,
 *   processedSize: number | null,
 *   savingsPercent: string | null,
 *   error: string | null
 * }>} files
 */
