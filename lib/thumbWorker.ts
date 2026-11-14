// Web worker: decode an image blob and downscale it to a thumbnail entirely
// off the main thread (best practice for large galleries — full-resolution
// decodes on the UI thread cause scroll jank).
//
// Fast path: image dimensions are read straight from the file header (JPEG
// SOFn / PNG IHDR), then createImageBitmap({ resizeWidth, resizeHeight })
// decodes straight to the target size — several times faster and far lighter
// on memory than decoding a 12-megapixel photo and scaling afterwards.

interface ThumbRequest {
  id: number;
  blob: Blob;
  maxEdge: number;
  quality: number;
}

interface Dims {
  w: number;
  h: number;
}

/** Read pixel dimensions from the file header without decoding. */
function probeDims(head: Uint8Array): Dims | null {
  // JPEG: scan segment markers until an SOF0–SOF15 frame header
  if (head[0] === 0xff && head[1] === 0xd8) {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = head[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const len = (head[i + 2] << 8) | head[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          h: (head[i + 5] << 8) | head[i + 6],
          w: (head[i + 7] << 8) | head[i + 8],
        };
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  // PNG: IHDR width/height at fixed offsets
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    const be = (a: number) => ((head[a] << 24) | (head[a + 1] << 16) | (head[a + 2] << 8) | head[a + 3]) >>> 0;
    return { w: be(16), h: be(20) };
  }
  return null;
}

async function decodeToSize(
  blob: Blob,
  maxEdge: number,
): Promise<{ bitmap: ImageBitmap; w: number; h: number }> {
  let dims: Dims | null = null;
  try {
    dims = probeDims(new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer()));
  } catch {
    dims = null;
  }

  if (dims && dims.w > 0 && dims.h > 0) {
    const scale = Math.min(1, maxEdge / Math.max(dims.w, dims.h));
    const w = Math.max(1, Math.round(dims.w * scale));
    const h = Math.max(1, Math.round(dims.h * scale));
    try {
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'medium',
      });
      return { bitmap, w, h };
    } catch {
      /* resize-during-decode unsupported — fall through to full decode */
    }
  }

  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  return {
    bitmap,
    w: Math.max(1, Math.round(bitmap.width * scale)),
    h: Math.max(1, Math.round(bitmap.height * scale)),
  };
}

self.onmessage = async (e: MessageEvent<ThumbRequest>) => {
  const { id, blob, maxEdge, quality } = e.data;
  try {
    const { bitmap, w, h } = await decodeToSize(blob, maxEdge);
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
