// Lazy thumbnail pipeline: browser-decodable media → downscaled canvas
// thumbnails; exotic formats (RAW/TIFF) → embedded JPEG preview extracted
// by the Rust WASM core; videos → first-frame capture.

import { extractThumbnail } from './wasm';
import { heicToJpeg, isHeicExt } from './heic';
import type { PhotoRecord, ThumbInfo } from './types';

const MAX_EDGE = 640;
const MAX_CONCURRENCY = 5;

const cache = new Map<string, ThumbInfo>();
const failed = new Set<string>();
const pending = new Map<string, Promise<ThumbInfo | null>>();

let active = 0;
const waiting: (() => void)[] = [];

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

export function peekThumb(id: string): ThumbInfo | null {
  return cache.get(id) ?? null;
}

export function ensureThumb(
  rec: PhotoRecord,
  getFile: (id: string) => Promise<File>,
): Promise<ThumbInfo | null> {
  const hit = cache.get(rec.id);
  if (hit) return Promise.resolve(hit);
  if (failed.has(rec.id)) return Promise.resolve(null);

  let p = pending.get(rec.id);
  if (!p) {
    p = withSlot(() => generate(rec, getFile)).finally(() => pending.delete(rec.id));
    pending.set(rec.id, p);
  }
  return p;
}

async function generate(rec: PhotoRecord, getFile: (id: string) => Promise<File>): Promise<ThumbInfo | null> {
  try {
    const file = await getFile(rec.id);
    const info = rec.kind === 'video' ? await videoThumb(file) : await imageThumb(file, rec);
    if (info) {
      cache.set(rec.id, info);
      return info;
    }
    failed.add(rec.id);
    return null;
  } catch {
    failed.add(rec.id);
    return null;
  }
}

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
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
      : await new Promise<Blob>((resolve, reject) =>
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
            'image/jpeg',
            0.82,
          ),
        );
  return URL.createObjectURL(blob);
}

async function bitmapToThumb(bitmap: ImageBitmap): Promise<ThumbInfo> {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const url = await canvasToJpegUrl(canvas);
  return { url, w, h };
}

async function imageThumb(file: File, rec: PhotoRecord): Promise<ThumbInfo | null> {
  if (typeof createImageBitmap === 'function' && file.type !== 'image/svg+xml') {
    try {
      return await bitmapToThumb(await createImageBitmap(file));
    } catch {
      // native decode failed — HEIC on Chrome/Firefox, or a broken file
    }
  }

  // HEIC/HEIF: decode through the libheif vendor bundle, then downscale as usual
  if (isHeicExt(rec.ext) && typeof createImageBitmap === 'function') {
    try {
      const jpg = await heicToJpeg(file);
      if (jpg) return await bitmapToThumb(await createImageBitmap(jpg));
    } catch {
      // fall through to the embedded preview / format tile
    }
  }

  if (file.type === 'image/svg+xml') {
    return { url: URL.createObjectURL(file), w: 4, h: 3 };
  }

  // EXIF thumbnails live in the metadata near the start of the file
  const headSize = Math.min(file.size, 8 * 1024 * 1024);
  const buf = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
  const jpg = await extractThumbnail(buf);
  if (jpg && jpg.length > 128) {
    const url = URL.createObjectURL(new Blob([jpg as unknown as BlobPart], { type: 'image/jpeg' }));
    const dims = await measureImage(url);
    return { url, w: dims.w, h: dims.h };
  }
  return null;
}

async function measureImage(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = { w: 4, h: 3 };
    const timer = setTimeout(() => resolve(done), 4000);
    img.onload = () => {
      clearTimeout(timer);
      resolve({ w: img.naturalWidth || 4, h: img.naturalHeight || 3 });
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(done);
    };
    img.src = url;
  });
}

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

function isBlankFrame(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number): boolean {
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

async function videoThumb(file: File): Promise<ThumbInfo | null> {
  const url = URL.createObjectURL(file);
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
    // An undecodable file still yields a canvas — but painted black. Detect
    // that and report failure so the card shows its format tile instead.
    if (isBlankFrame(ctx, w, h)) return null;
    const poster = await canvasToJpegUrl(canvas);
    return { url: poster, w, h };
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
