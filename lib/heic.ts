// HEIC/HEIF decoding for browsers that lack native support (Chrome, Firefox).
// Uses libheif + libde265 compiled to JS/WASM (heic2any), loaded lazily from
// /vendor on the first HEIC file so non-iPhone users never pay the cost.
// Decodes are serialized: the libheif build runs synchronously inside its
// worker, so a burst of 667 iPhone photos would otherwise queue chaotically.

type Heic2anyFn = (opts: {
  blob: Blob;
  toType?: string;
  quality?: number;
}) => Promise<Blob | Blob[]>;

let loader: Promise<Heic2anyFn | null> | null = null;

function loadDecoder(): Promise<Heic2anyFn | null> {
  loader ??= new Promise((resolve) => {
    const base = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '');
    const script = document.createElement('script');
    script.src = `${base}/vendor/heic2any.min.js`;
    script.async = true;
    script.onload = () => {
      resolve((window as unknown as { heic2any?: Heic2anyFn }).heic2any ?? null);
    };
    script.onerror = () => {
      console.warn('heic2any vendor script failed to load');
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return loader;
}

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export function isHeicExt(ext: string): boolean {
  return ext === 'heic' || ext === 'heif' || ext === 'hif';
}

/** Decode a HEIC/HEIF blob to JPEG, or null if decoding is impossible. */
export async function heicToJpeg(file: Blob, quality = 0.86): Promise<Blob | null> {
  const decoder = await loadDecoder();
  if (!decoder) return null;
  try {
    return await serialize(async () => {
      const out = await decoder({ blob: file, toType: 'image/jpeg', quality });
      const blob = Array.isArray(out) ? out[0] : out;
      return blob ?? null;
    });
  } catch (err) {
    console.warn('heic decode failed:', err);
    return null;
  }
}
