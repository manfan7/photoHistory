// Loader for the Rust → WebAssembly core (wasm-pack, target "web").
// The generated glue JS is loaded as a native ES module from /public/wasm,
// so the bundler never touches it — this keeps static export trivial.

export interface MediaMeta {
  dateTaken: string | null;
  camera: string | null;
  thumbLen: number;
}

let modPromise: Promise<WasmModule | null> | null = null;

interface WasmModule {
  default: () => Promise<void>;
  parse_media: (data: Uint8Array) => MediaMeta | null | undefined;
  extract_thumbnail: (data: Uint8Array) => Uint8Array | null | undefined;
}

function wasmBase(): string {
  return (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '');
}

async function loadModule(): Promise<WasmModule | null> {
  try {
    const url = `${wasmBase()}/wasm/photo_history_wasm.js`;
    const mod = (await import(/* webpackIgnore: true */ url)) as WasmModule;
    await mod.default();
    return mod;
  } catch (err) {
    console.warn('WASM core unavailable, falling back to filesystem dates:', err);
    return null;
  }
}

export function getWasm(): Promise<WasmModule | null> {
  modPromise ??= loadModule();
  return modPromise;
}

export async function parseMedia(data: Uint8Array): Promise<MediaMeta | null> {
  const mod = await getWasm();
  if (!mod) return null;
  try {
    return mod.parse_media(data) ?? null;
  } catch (err) {
    console.warn('parse_media failed:', err);
    return null;
  }
}

export async function extractThumbnail(data: Uint8Array): Promise<Uint8Array | null> {
  const mod = await getWasm();
  if (!mod) return null;
  try {
    return mod.extract_thumbnail(data) ?? null;
  } catch (err) {
    console.warn('extract_thumbnail failed:', err);
    return null;
  }
}
