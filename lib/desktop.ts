// Desktop (Tauri) bridge. The Tauri shell exposes the global API bundle
// (withGlobalTauri), so no npm package is needed — commands live in
// src-tauri/src/main.rs. In Tauri mode the whole media pipeline (scan →
// EXIF/container dating → thumbnails) runs natively with rayon threading;
// every call below has a web fallback in the regular pipeline.

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!t) throw new Error('Tauri API недоступен');
  return t.core.invoke(cmd, args) as Promise<T>;
}

export interface DirEntry {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

export interface Analyzed {
  dateTaken: string | null;
  camera: string | null;
  thumbLen: number;
}

export interface ThumbIpc {
  jpegB64: string;
  w: number;
  h: number;
}

export async function tauriPickArchiveFolder(): Promise<string | null> {
  return tauriInvoke<string | null>('pick_archive_folder');
}

export async function tauriScanFolder(dir: string): Promise<DirEntry[]> {
  return tauriInvoke<DirEntry[]>('scan_folder', { dir });
}

export async function tauriAnalyzeFiles(paths: string[]): Promise<(Analyzed | null)[]> {
  return tauriInvoke<(Analyzed | null)[]>('analyze_files', { paths });
}

export async function tauriGenThumbs(paths: string[], maxEdge: number): Promise<(ThumbIpc | null)[]> {
  return tauriInvoke<(ThumbIpc | null)[]>('gen_thumbs', { paths, maxEdge });
}

export async function tauriGetEmbeddedPreview(path: string, maxEdge: number): Promise<ThumbIpc | null> {
  return tauriInvoke<ThumbIpc | null>('get_embedded_preview', { path, maxEdge });
}

export async function tauriReadFileB64(path: string): Promise<string> {
  return tauriInvoke<string>('read_file_b64', { path });
}

/** WebView2 reads the file straight from disk via the asset protocol —
 *  no base64 IPC copy, instant for full-view and videos. */
export function tauriAssetUrl(path: string): string {
  const t = (window as unknown as { __TAURI__?: TauriGlobal & { core: { convertFileSrc: (p: string, protocol?: string) => string } } }).__TAURI__;
  if (!t) throw new Error('Tauri API недоступен');
  return t.core.convertFileSrc(path, 'asset');
}

export function withTimeout<T>(p: Promise<T>, ms: number, tag = 'op'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag} timeout`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function tauriReadFileAsFile(path: string, name: string, mime: string): Promise<File> {
  const b64 = await tauriReadFileB64(path);
  return new File([b64ToBlob(b64, mime)], name, { type: mime });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

export interface PrintDirRef {
  kind: 'fsa' | 'tauri';
  /** FSA directory handle (web) or absolute path (desktop) */
  ref: FileSystemDirectoryHandle | string;
}

export async function pickPrintDir(): Promise<PrintDirRef | null> {
  if (isTauri()) {
    const path = await tauriInvoke<string | null>('pick_print_folder');
    return path ? { kind: 'tauri', ref: path } : null;
  }
  if (typeof window !== 'undefined' && window.showDirectoryPicker) {
    const handle = await window.showDirectoryPicker({
      id: 'photohistory-print',
      mode: 'readwrite',
      startIn: 'pictures',
    });
    return { kind: 'fsa', ref: handle };
  }
  return null;
}

export function describePrintDir(dir: PrintDirRef): string {
  return dir.kind === 'tauri' ? String(dir.ref) : (dir.ref as FileSystemDirectoryHandle).name;
}

async function fsaExists(handle: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await handle.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function uniqueName(handle: FileSystemDirectoryHandle, name: string): Promise<string> {
  if (!(await fsaExists(handle, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await fsaExists(handle, candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/** Copy the file into the print folder; returns the final file name. */
export async function saveForPrint(dir: PrintDirRef, file: File, name: string): Promise<string> {
  if (dir.kind === 'tauri') {
    const dataB64 = await blobToBase64(file);
    return tauriInvoke<string>('save_for_print', { dir: String(dir.ref), name, dataB64 });
  }
  const handle = dir.ref as FileSystemDirectoryHandle;
  const finalName = await uniqueName(handle, name);
  const fh = await handle.getFileHandle(finalName, { create: true });
  const ws = await fh.createWritable();
  await ws.write(file);
  await ws.close();
  return finalName;
}
