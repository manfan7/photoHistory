// Recursive folder scanner + metadata analysis pipeline.
//
// Date resolution order per file:
//   1. EXIF (DateTimeOriginal → DateTimeDigitized → DateTime) via the Rust WASM core
//   2. Container date (QuickTime/MP4 mvhd) via the WASM core
//   3. Filesystem modification time as the fallback

import { parseMedia } from './wasm';
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
import type { DateSource, PhotoRecord, ScanResult, ScanState } from './types';

const HEAD_BYTES = 2 * 1024 * 1024; // metadata almost always lives in the first 2 MB
const MAX_FULL_READ = 64 * 1024 * 1024; // above this, use head + tail slices only
const TAIL_BYTES = 2 * 1024 * 1024; // the mp4 moov box is often at the end
const YIELD_EVERY = 8; // files between UI yields

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

/** Shared analysis loop for both FSA handles and plain File lists. */
async function analyzeItems(items: WalkItem[], cb: ScanCallbacks): Promise<ScanResult> {
  const cache = await loadMetaCache();
  const newCacheEntries: [string, CacheEntry][] = [];

  const records: PhotoRecord[] = [];
  const accessor = new Map<string, () => Promise<File>>();
  let skipped = 0;
  const total = items.length;

  for (let i = 0; i < total; i++) {
    if (cb.isCancelled()) break;
    const item = items[i];
    let file: File;
    try {
      file = await item.getFile();
    } catch {
      skipped++;
      continue;
    }

    // strip the picked folder prefix so the archive shows content, not the root name
    const relPath = stripRoot(item.rawPath);
    accessor.set(relPath, item.getFile);

    const rec = await analyzeFile(file, relPath, cache, newCacheEntries);
    if (rec) records.push(rec);
    else skipped++;

    cb.onProgress({ phase: 'analyze', found: total, processed: i + 1, skipped, current: file.name });
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await sleep();
  }

  if (newCacheEntries.length > 0) await saveMetaBatch(newCacheEntries);

  const getFile = async (id: string): Promise<File> => {
    const getter = accessor.get(id);
    if (!getter) throw new Error(`unknown file: ${id}`);
    return getter();
  };

  records.sort((a, b) => b.dateISO.localeCompare(a.dateISO) || a.name.localeCompare(b.name));
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
    dateISO = fmtLocal(new Date(file.lastModified));
    dateSource = 'fs';
  }

  const entry: CacheEntry = { dateISO, dateSource, camera, hasEmbeddedThumb };
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
