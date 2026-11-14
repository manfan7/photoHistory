// Thumbnail pipeline built on gallery best practices:
//   1. decode + downscale off the main thread (thumbWorker.ts, 2 workers)
//   2. persist generated thumbs in IndexedDB keyed by path+size+mtime —
//      re-opening the same folder renders instantly with zero re-decodes
//   3. bounded LRU of object URLs keeps memory flat while scrolling
//   4. HEIC decodes via libheif first (heic2any), videos grab a poster frame
//      on the main thread; exotic formats fall back to EXIF previews

import { getThumb, metaKey, putThumbBatch, type StoredThumb } from './cache';
import {
  b64ToBlob,
  isTauri,
  tauriAssetUrl,
  tauriGenThumbs,
  tauriGetEmbeddedPreview,
  withTimeout,
} from './desktop';
import { heicToJpeg, isHeicExt } from './heic';
import { extractThumbnail } from './wasm';
import type { PhotoRecord, ThumbInfo } from './types';
import type { ThumbIpc } from './desktop';

const MAX_EDGE = 560; // cards are ~150px squares; 560 covers hi-DPI
const JPEG_QUALITY = 0.78;
// one worker per spare core (2–6) — decodes are CPU-bound and parallelize
const WORKER_COUNT =
  typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? Math.max(2, Math.min(6, navigator.hardwareConcurrency - 2))
    : 3;
const LRU_MAX = 700;
const IDB_WRITE_BATCH = 24;

interface Entry {
  url: string;
  w: number;
  h: number;
}

const lru = new Map<string, Entry>();
const failedIds = new Set<string>();
const pending = new Map<string, Promise<Entry | null>>();
const idbBuffer = new Map<string, StoredThumb>();
const noStoreIds = new Set<string>(); // svg etc. — don't persist

let active = 0;
const waiting: (() => void)[] = [];
const MAX_CONCURRENCY = 8;

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENCY) {
    await new Promise<void>((r) => waiting.push(r));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// ── worker pool ─────────────────────────────────────────────────

type WorkerResult = { blob: Blob; w: number; h: number } | { error: string };

const workers: Worker[] = [];
const workerBusy: boolean[] = [];
const workerWaiters = new Map<number, (r: WorkerResult) => void>();
let workerTaskSeq = 0;
const workerQueue: {
  blob: Blob;
  resolve: (r: WorkerResult) => void;
}[] = [];

function initWorkers(): boolean {
  if (workers.length > 0) return true;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
  for (let i = 0; i < WORKER_COUNT; i++) {
    try {
      const w = new Worker(new URL('./thumbWorker.ts', import.meta.url));
      const idx = i;
      w.onmessage = (e: MessageEvent<{ id: number } & WorkerResult>) => {
        const { id, ...result } = e.data;
        const waiter = workerWaiters.get(id);
        workerWaiters.delete(id);
        workerBusy[idx] = false;
        waiter?.(result as WorkerResult);
        dispatchWorkerTasks();
      };
      w.onerror = () => {
        workerBusy[idx] = false;
        dispatchWorkerTasks();
      };
      workers.push(w);
      workerBusy.push(false);
    } catch {
      return false;
    }
  }
  return workers.length > 0;
}

function dispatchWorkerTasks() {
  for (let i = 0; i < workers.length; i++) {
    if (workerBusy[i]) continue;
    const task = workerQueue.shift();
    if (!task) return;
    workerBusy[i] = true;
    const id = ++workerTaskSeq;
    workerWaiters.set(id, task.resolve);
    workers[i].postMessage({ id, blob: task.blob, maxEdge: MAX_EDGE, quality: JPEG_QUALITY });
  }
}

function decodeViaWorker(blob: Blob): Promise<WorkerResult> {
  return new Promise((resolve) => {
    workerQueue.push({ blob, resolve });
    dispatchWorkerTasks();
  });
}

// ── main-thread fallback (old browsers / worker failure) ────────

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d') as OffscreenCanvasRenderingContext2D };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d') as CanvasRenderingContext2D };
}

async function canvasToJpegUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
      : await new Promise<Blob>((resolve, reject) =>
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
            'image/jpeg',
            JPEG_QUALITY,
          ),
        );
  return URL.createObjectURL(blob);
}

async function decodeMainThread(blob: Blob): Promise<{ blob: Blob; w: number; h: number } | null> {
  if (typeof createImageBitmap === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const out =
      'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
        : await new Promise<Blob>((resolve, reject) =>
            (canvas as HTMLCanvasElement).toBlob(
              (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
              'image/jpeg',
              JPEG_QUALITY,
            ),
          );
    return { blob: out, w, h };
  } catch {
    return null;
  }
}

// ── video poster (main thread — needs a DOM element) ────────────

function eventOnce(el: HTMLElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      el.removeEventListener(event, finish);
      el.removeEventListener('error', finish);
      resolve();
    }
    el.addEventListener(event, finish, { once: true });
    el.addEventListener('error', finish, { once: true });
  });
}

function isBlankFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
): boolean {
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 397) {
      if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) lit++;
    }
    return lit === 0;
  } catch {
    return false;
  }
}

async function videoThumb(
  file: File,
  nativeUrl?: string,
): Promise<{ blob: Blob; w: number; h: number } | null> {
  // Tauri: stream straight from disk via the asset protocol — a 100 MB video
  // no longer travels through base64 IPC just to grab a poster frame
  const ownUrl = !nativeUrl;
  const url = nativeUrl ?? URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  try {
    video.src = url;
    await eventOnce(video, 'loadeddata', 10000);
    const target = Number.isFinite(video.duration) ? Math.min(1.5, video.duration * 0.1) : 0.1;
    try {
      video.currentTime = target;
    } catch {
      /* some codecs refuse seeking — first frame is fine */
    }
    await eventOnce(video, 'seeked', 10000);
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.drawImage(video, 0, 0, w, h);
    if (isBlankFrame(ctx, w, h)) return null;
    const blob =
      'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
        : await new Promise<Blob>((resolve, reject) =>
            (canvas as HTMLCanvasElement).toBlob(
              (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
              'image/jpeg',
              JPEG_QUALITY,
            ),
          );
    return { blob, w, h };
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    if (ownUrl) URL.revokeObjectURL(url);
  }
}

// ── IndexedDB write buffering ───────────────────────────────────

function queueIdbPut(rec: PhotoRecord, thumb: StoredThumb) {
  idbBuffer.set(metaKey(rec), thumb);
  if (idbBuffer.size >= IDB_WRITE_BATCH) void flushIdb();
}

async function flushIdb(): Promise<void> {
  if (idbBuffer.size === 0) return;
  const entries = [...idbBuffer.entries()];
  idbBuffer.clear();
  await putThumbBatch(entries);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushIdb());
}

// ── public API ──────────────────────────────────────────────────

function lruSet(id: string, entry: Entry) {
  if (lru.has(id)) lru.delete(id);
  lru.set(id, entry);
  if (lru.size > LRU_MAX) {
    for (const [oldId, old] of lru) {
      if (lru.size <= LRU_MAX * 0.8) break;
      URL.revokeObjectURL(old.url);
      lru.delete(oldId);
      failedIds.delete(oldId); // allow regeneration on revisit
    }
  }
}

export function peekThumb(id: string): ThumbInfo | null {
  const hit = lru.get(id);
  if (hit) {
    lru.delete(id);
    lru.set(id, hit); // refresh LRU position
    return hit;
  }
  return null;
}

export function ensureThumb(
  rec: PhotoRecord,
  getFile: (id: string) => Promise<File>,
): Promise<ThumbInfo | null> {
  const hit = peekThumb(rec.id);
  if (hit) return Promise.resolve(hit);
  if (failedIds.has(rec.id)) return Promise.resolve(null);

  let p = pending.get(rec.id);
  if (!p) {
    p = withSlot(() => generate(rec, getFile)).finally(() => pending.delete(rec.id));
    pending.set(rec.id, p);
  }
  return p;
}

// ── Tauri native batch queue ────────────────────────────────────
// Visible cells each request a thumb; instead of one IPC call per photo we
// micro-batch (~50 ms window) so rayon decodes the whole visible area in a
// single native call across all cores.

interface BatchReq {
  rec: PhotoRecord;
  resolve: (e: Entry | null) => void;
}

const tauriBatch: BatchReq[] = [];
let tauriTimer: ReturnType<typeof setTimeout> | null = null;

function tauriBatchRequest(rec: PhotoRecord): Promise<Entry | null> {
  return new Promise((resolve) => {
    tauriBatch.push({ rec, resolve });
    if (tauriTimer === null) {
      tauriTimer = setTimeout(() => {
        tauriTimer = null;
        void flushTauriBatch();
      }, 50);
    }
  });
}

async function flushTauriBatch(): Promise<void> {
  const batch = tauriBatch.splice(0);
  if (batch.length === 0) return;
  const byId = new Map<string, BatchReq>();
  for (const b of batch) if (!byId.has(b.rec.id)) byId.set(b.rec.id, b);
  const reqs = [...byId.values()];
  let results: (ThumbIpc | null)[] = [];
  try {
    results = await withTimeout(
      tauriGenThumbs(
        reqs.map((b) => b.rec.absPath as string),
        MAX_EDGE,
      ),
      20000,
      'gen_thumbs',
    );
  } catch {
    results = [];
  }
  reqs.forEach((b, i) => {
    const t = results[i];
    if (t && t.jpegB64) {
      const blob = b64ToBlob(t.jpegB64, 'image/jpeg');
      const entry: Entry = { url: URL.createObjectURL(blob), w: t.w, h: t.h };
      lruSet(b.rec.id, entry);
      queueIdbPut(b.rec, { b: blob, w: t.w, h: t.h, full: true });
      notifyThumbUpgrade(b.rec.id);
      b.resolve(entry);
    } else {
      b.resolve(null); // image-rs can't decode it — caller falls back to JS
    }
  });
}

// thumb upgrade pub/sub — background preloader replaces low-res paints with
// full thumbs and subscribed cells re-render
const upgradeListeners = new Map<string, Set<() => void>>();

export function onThumbUpgrade(id: string, cb: () => void): () => void {
  let set = upgradeListeners.get(id);
  if (!set) {
    set = new Set();
    upgradeListeners.set(id, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) upgradeListeners.delete(id);
  };
}

export function notifyThumbUpgrade(id: string): void {
  upgradeListeners.get(id)?.forEach((cb) => cb());
}

const pendingNotify = new Set<string>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

/** Batched async notify — avoids sync re-render churn per thumb. */
export function notifyUpgradeListenersSoon(id: string): void {
  pendingNotify.add(id);
  if (notifyTimer === null) {
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      for (const id2 of pendingNotify) notifyThumbUpgrade(id2);
      pendingNotify.clear();
    }, 60);
  }
}

/** True while visible-cell requests are in flight — background work yields. */
export function foregroundPending(): boolean {
  return tauriBatch.length > 0 || pending.size > 0;
}

async function generate(rec: PhotoRecord, getFile: (id: string) => Promise<File>): Promise<Entry | null> {
  try {
    // 1) persisted thumb (IndexedDB) — warm sessions paint instantly
    const stored = await getThumb(metaKey(rec));
    if (stored) {
      const entry: Entry = { url: URL.createObjectURL(stored.b), w: stored.w, h: stored.h };
      lruSet(rec.id, entry);
      if (stored.full !== false) return entry;
      // low-res paint now; the background preloader upgrades it soon
      notifyUpgradeListenersSoon(rec.id);
      return entry;
    }

    // 2) Tauri native: instant first paint from the embedded EXIF preview
    //    (decoded from the file head only), then the rayon full thumb
    if (isTauri() && rec.absPath) {
      if (rec.hasEmbeddedThumb) {
        try {
          const t = await withTimeout(
            tauriGetEmbeddedPreview(rec.absPath, MAX_EDGE),
            8000,
            'embedded_preview',
          );
          if (t && t.jpegB64) {
            const blob = b64ToBlob(t.jpegB64, 'image/jpeg');
            const entry: Entry = { url: URL.createObjectURL(blob), w: t.w, h: t.h };
            lruSet(rec.id, entry);
            queueIdbPut(rec, { b: blob, w: t.w, h: t.h, full: false });
            notifyUpgradeListenersSoon(rec.id);
            return entry;
          }
        } catch {
          /* no usable embedded preview — go for the full decode */
        }
      }
      const native = await tauriBatchRequest(rec);
      if (native) return native;
      // image-rs can't decode it (HEIC/RAW) — fall through to the JS paths
    }

    const file = await getFile(rec.id);
    let out: { blob: Blob; w: number; h: number } | null = null;

    if (rec.kind === 'video') {
      out = await videoThumb(file, isTauri() && rec.absPath ? tauriAssetUrl(rec.absPath) : undefined);
    } else if (file.type === 'image/svg+xml') {
      noStoreIds.add(rec.id);
      return { url: URL.createObjectURL(file), w: 4, h: 3 };
    } else {
      let src: Blob = file;
      if (isHeicExt(rec.ext)) {
        const jpg = await heicToJpeg(file);
        if (!jpg) throw new Error('heic decode failed');
        src = jpg;
      }
      const result = initWorkers()
        ? await raceWorkerFallback(src)
        : await decodeMainThread(src);
      out = result;
    }

    if (!out || out.w < 1) {
      // try the EXIF embedded preview before giving up
      const head = new Uint8Array(await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer());
      const jpg = await extractThumbnail(head);
      if (jpg && jpg.length > 128) {
        const blob = new Blob([jpg as unknown as BlobPart], { type: 'image/jpeg' });
        out = (await decodeMainThread(blob)) ?? (await unwrapWorker(await decodeViaWorker(blob)));
      }
    }

    if (!out) {
      failedIds.add(rec.id);
      return null;
    }

    const entry: Entry = { url: URL.createObjectURL(out.blob), w: out.w, h: out.h };
    lruSet(rec.id, entry);
    if (!noStoreIds.has(rec.id)) queueIdbPut(rec, { b: out.blob, w: out.w, h: out.h, full: true });
    notifyThumbUpgrade(rec.id);
    return entry;
  } catch {
    failedIds.add(rec.id);
    return null;
  }
}

async function raceWorkerFallback(src: Blob): Promise<{ blob: Blob; w: number; h: number } | null> {
  const result = await decodeViaWorker(src);
  if ('error' in result) return decodeMainThread(src);
  return result;
}

async function unwrapWorker(result: WorkerResult): Promise<{ blob: Blob; w: number; h: number } | null> {
  return 'error' in result ? null : result;
}
