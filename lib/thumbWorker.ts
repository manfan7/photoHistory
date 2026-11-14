// Web worker: decode an image blob and downscale it to a thumbnail entirely
// off the main thread (best practice for large galleries — full-resolution
// decodes on the UI thread cause scroll jank).

interface ThumbRequest {
  id: number;
  blob: Blob;
  maxEdge: number;
  quality: number;
}

self.onmessage = async (e: MessageEvent<ThumbRequest>) => {
  const { id, blob, maxEdge, quality } = e.data;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    self.postMessage({ id, blob: out, w, h });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
