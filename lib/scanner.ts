// Recursive folder scanner + metadata analysis pipeline.
//
// Date resolution order per file:
//   1. EXIF (DateTimeOriginal → DateTimeDigitized → DateTime) via the Rust WASM core
//   2. Container date (QuickTime/MP4 mvhd) via the WASM core
//   3. Filesystem modification time as the fallback

import { parseMedia } from './wasm';
import { tauriAnalyzeFiles, tauriReadFileAsFile, tauriScanFolder, type Analyzed } from './desktop';
import {
  CONTAINER_CAPABLE,
  EXIF_CAPABLE,
  RENDERABLE_IMAGE,
  RENDERABLE_VIDEO,
  SKIPPED_DIRS,
  extOf,
  kindOf,
} from './formats';
import { loadMetaCache, metaKey, saveMetaBatch } from './cache';
import { dateFromName, dateFromPath } from './dateHints';
import type { DateSource, PhotoRecord, ScanResult, ScanState } from './types';

const HEAD_BYTES = 2 * 1024 * 1024; // metadata almost always lives in the first 2 MB
const MAX_FULL_READ = 64 * 1024 * 1024; // above this, use head + tail slices only
const TAIL_BYTES = 2 * 1024 * 1024; // the mp4 moov box is often at the end
const PARALLEL_ANALYZE = 6; // metadata reads are IO-bound — a small pool is 4-6x faster
const YIELD_EVERY = 20; // analyzed files between UI yields

export interface ScanCallbacks {
  onProgress: (state: ScanState) => void;
  isCancelled: () => boolean;
}

interface WalkItem {
  getFile: () => Promise<File>;
  /** path as stored by the walk phase (may include the picked root folder) */
  rawPath: string;
}

interface CacheEntry {
  /** cache format version — v1 entries (no name-hint dating) are ignored */
  v: 2;
  dateISO: string;
  dateSource: DateSource;
  camera: string | null;
  hasEmbeddedThumb: boolean;
}

function dirEntries(dir: FileSystemDirectoryHandle): AsyncIterable<FileSystemHandle> {
  return (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values();
}

function isSkippedDir(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRS.has(name.toLowerCase());
}

function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sleep = () => new Promise((r) => setTimeout(r, 0));

async function walkDirectory(
  root: FileSystemDirectoryHandle,
  prefix: string,
  found: WalkItem[],
  cb: ScanCallbacks,
  depth = 0,
): Promise<void> {
  if (cb.isCancelled() || depth > 32) return;
  for await (const entry of dirEntries(root)) {
    if (cb.isCancelled()) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      if (!isSkippedDir(entry.name)) {
        await walkDirectory(entry as FileSystemDirectoryHandle, path, found, cb, depth + 1);
      }
    } else {
      const handle = entry as FileSystemFileHandle;
      found.push({ getFile: () => handle.getFile(), rawPath: path });
      if (found.length % 50 === 0) {
        cb.onProgress({ phase: 'walk', found: found.length, processed: 0, skipped: 0, current: entry.name });
      }
    }
  }
}

export async function scanDirectoryHandle(
  root: FileSystemDirectoryHandle,
  cb: ScanCallbacks,
): Promise<ScanResult> {
  const found: WalkItem[] = [];
  cb.onProgress({ phase: 'walk', found: 0, processed: 0, skipped: 0, current: root.name });
  await walkDirectory(root, '', found, cb);
  return analyzeItems(found, cb);
}

export async function scanFileList(files: File[], cb: ScanCallbacks): Promise<ScanResult> {
  const items: WalkItem[] = files.map((f) => ({
    getFile: () => Promise.resolve(f),
    rawPath: f.webkitRelativePath || f.name,
  }));
  return analyzeItems(items, cb);
}

/**
 * Tauri mode: the folder is scanned and dated natively (rayon, one IPC call),
 * files are read from disk by path. Falls back to nothing — this branch runs
 * only inside the desktop shell.
 */
export async function scanTauriFolder(dir: string, cb: ScanCallbacks): Promise<ScanResult> {
  const entries = await tauriScanFolder(dir);
  const total = entries.length;
  cb.onProgress({ phase: 'walk', found: total, processed: 0, skipped: 0, current: '' });

  const cache = await loadMetaCache();
  const newCacheEntries: [string, CacheEntry][] = [];

  // analyze in chunks so the progress ring moves and cancellation works —
  // the native side parallelizes each batch across all cores (rayon)
  const analyzed: (Analyzed | null)[] = new Array(total).fill(null);
  const CHUNK = 150;
  for (let s = 0; s < total; s += CHUNK) {
    if (cb.isCancelled()) break;
    const slice = entries.slice(s, s + CHUNK).map((e) => e.abs);
    const part = await tauriAnalyzeFiles(slice);
    for (let j = 0; j < part.length; j++) analyzed[s + j] = part[j] ?? null;
    cb.onProgress({
      phase: 'analyze',
      found: total,
      processed: Math.min(s + CHUNK, total),
      skipped: 0,
      current: '',
    });
  }

  const records: PhotoRecord[] = [];
  const accessor = new Map<string, () => Promise<File>>();
  let skipped = 0;

  for (let i = 0; i < total; i++) {
    if (cb.isCancelled()) break;
    const entry = entries[i];
    const name = entry.rel.split('/').pop() || entry.rel;
    const ext = extOf(name);
    const kind = kindOf(ext, '');
    if (!kind) {
      skipped++;
      continue;
    }

    const mime =
      kind === 'image' ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : `video/${ext}`;
    accessor.set(entry.rel, () => tauriReadFileAsFile(entry.abs, name, mime));

    const key = metaKey({ relPath: entry.rel, size: entry.size, lastModified: entry.mtimeMs });
    let entryData = cache.get(key) ?? null;
    if (!entryData) {
      const a = analyzed[i];
      let dateISO: string | null = a?.dateTaken ?? null;
      let dateSource: DateSource = EXIF_CAPABLE.has(ext) ? 'exif' : 'container';
      const camera = a?.camera ?? null;
      const hasEmbeddedThumb = (a?.thumbLen ?? 0) > 512;
      if (!dateISO) {
        const hint = dateFromName(name) ?? dateFromPath(entry.rel);
        if (hint) {
          dateISO = hint;
          dateSource = 'name';
        }
      }
      if (!dateISO) {
        dateISO = fmtLocal(new Date(entry.mtimeMs));
        dateSource = 'fs';
      }
      entryData = { v: 2, dateISO, dateSource, camera, hasEmbeddedThumb };
      newCacheEntries.push([key, entryData]);
    }

    const renderable = kind === 'image' ? RENDERABLE_IMAGE.has(ext) : RENDERABLE_VIDEO.has(ext);
    records.push({
      id: entry.rel,
      name,
      ext,
      relPath: entry.rel,
      size: entry.size,
      lastModified: entry.mtimeMs,
      dateISO: entryData.dateISO,
      dateSource: entryData.dateSource,
      camera: entryData.camera,
      kind,
      renderable,
      hasEmbeddedThumb: entryData.hasEmbeddedThumb,
      year: Number(entryData.dateISO.slice(0, 4)) || 1970,
      month: Number(entryData.dateISO.slice(5, 7)) || 1,
      absPath: entry.abs,
    });

    if (i % 50 === 0) {
      cb.onProgress({ phase: 'analyze', found: total, processed: i + 1, skipped, current: name });
    }
  }

  if (newCacheEntries.length > 0) await saveMetaBatch(newCacheEntries);
  cb.onProgress({ phase: 'analyze', found: total, processed: total, skipped, current: '' });

  const getFile = async (id: string): Promise<File> => {
    const getter = accessor.get(id);
    if (!getter) throw new Error(`unknown file: ${id}`);
    return getter();
  };

  records.sort((a, b) => b.dateISO.localeCompare(a.dateISO) || a.name.localeCompare(b.name));
  return { records, skipped, getFile };
}

/** Shared analysis loop for both FSA handles and plain File lists. */
async function analyzeItems(items: WalkItem[], cb: ScanCallbacks): Promise<ScanResult> {
  const cache = await loadMetaCache();
  const newCacheEntries: [string, CacheEntry][] = [];

  const total = items.length;
  const results: (PhotoRecord | null)[] = new Array(total).fill(null);
  const accessor = new Map<string, () => Promise<File>>();
  let skipped = 0;
  let nextIdx = 0;
  let done = 0;
  let currentName = '';

  const worker = async (): Promise<void> => {
    while (!cb.isCancelled()) {
      const i = nextIdx++;
      if (i >= total) return;
      const item = items[i];
      const relPath = stripRoot(item.rawPath);
      accessor.set(relPath, item.getFile);

      let file: File | null = null;
      try {
        file = await item.getFile();
      } catch {
        /* unreadable file */
      }

      let rec: PhotoRecord | null = null;
      if (file) {
        currentName = file.name;
        rec = await analyzeFile(file, relPath, cache, newCacheEntries);
      }
      if (!rec) skipped++;
      results[i] = rec;

      done++;
      if (done % YIELD_EVERY === 0) {
        cb.onProgress({ phase: 'analyze', found: total, processed: done, skipped, current: currentName });
        await sleep();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(PARALLEL_ANALYZE, total) }, worker));

  if (newCacheEntries.length > 0) await saveMetaBatch(newCacheEntries);

  const records = results.filter((r): r is PhotoRecord => r !== null);
  records.sort((a, b) => b.dateISO.localeCompare(a.dateISO) || a.name.localeCompare(b.name));

  const getFile = async (id: string): Promise<File> => {
    const getter = accessor.get(id);
    if (!getter) throw new Error(`unknown file: ${id}`);
    return getter();
  };

  return { records, skipped, getFile };
}

/** Input-mode paths start with the picked folder name; strip it for display. */
function stripRoot(path: string): string {
  const slash = path.indexOf('/');
  return slash > 0 ? path.slice(slash + 1) : path;
}

async function analyzeFile(
  file: File,
  relPath: string,
  cache: Map<string, CacheEntry>,
  newCacheEntries: [string, CacheEntry][],
): Promise<PhotoRecord | null> {
  const ext = extOf(file.name);
  const kind = kindOf(ext, file.type || '');
  if (!kind) return null;

  const key = metaKey({ relPath, size: file.size, lastModified: file.lastModified });
  const cached = cache.get(key);
  if (cached) {
    return finalizeRecord(file, relPath, ext, kind, cached);
  }

  let dateISO: string | null = null;
  let dateSource: DateSource = 'fs';
  let camera: string | null = null;
  let hasEmbeddedThumb = false;

  const tryMeta = EXIF_CAPABLE.has(ext) || CONTAINER_CAPABLE.has(ext);
  if (tryMeta && file.size > 64) {
    try {
      let meta = null;
      if (file.size <= HEAD_BYTES + 4096) {
        meta = await parseMedia(new Uint8Array(await file.arrayBuffer()));
      } else {
        meta = await parseMedia(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()));
        if (!meta?.dateTaken && file.size > HEAD_BYTES) {
          if (file.size <= MAX_FULL_READ && EXIF_CAPABLE.has(ext)) {
            meta = await parseMedia(new Uint8Array(await file.arrayBuffer()));
          }
          if (!meta?.dateTaken) {
            meta = await parseMedia(
              new Uint8Array(await file.slice(Math.max(0, file.size - TAIL_BYTES)).arrayBuffer()),
            );
          }
        }
      }
      if (meta) {
        if (meta.dateTaken) {
          dateISO = meta.dateTaken;
          dateSource = EXIF_CAPABLE.has(ext) ? 'exif' : 'container';
        }
        camera = meta.camera ?? null;
        hasEmbeddedThumb = meta.thumbLen > 512;
      }
    } catch {
      // malformed metadata — fall through to the filesystem date
    }
  }

  if (!dateISO) {
    // metadata missing (stripped by messengers/editors) — try the file name,
    // then folder names, before settling for the filesystem mtime
    const hint = dateFromName(file.name) ?? dateFromPath(relPath);
    if (hint) {
      dateISO = hint;
      dateSource = 'name';
    }
  }

  if (!dateISO) {
    dateISO = fmtLocal(new Date(file.lastModified));
    dateSource = 'fs';
  }

  const entry: CacheEntry = { v: 2, dateISO, dateSource, camera, hasEmbeddedThumb };
  newCacheEntries.push([key, entry]);
  return finalizeRecord(file, relPath, ext, kind, entry);
}

function finalizeRecord(
  file: File,
  relPath: string,
  ext: string,
  kind: 'image' | 'video',
  entry: CacheEntry,
): PhotoRecord {
  const renderable = kind === 'image' ? RENDERABLE_IMAGE.has(ext) : RENDERABLE_VIDEO.has(ext);
  return {
    id: relPath,
    name: file.name,
    ext,
    relPath,
    size: file.size,
    lastModified: file.lastModified,
    dateISO: entry.dateISO,
    dateSource: entry.dateSource,
    camera: entry.camera,
    kind,
    renderable,
    hasEmbeddedThumb: entry.hasEmbeddedThumb,
    year: Number(entry.dateISO.slice(0, 4)) || 1970,
    month: Number(entry.dateISO.slice(5, 7)) || 1,
  };
}
