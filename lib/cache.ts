// Tiny IndexedDB layer: cached file metadata (keyed by path+size+mtime)
// so re-opening the same folder is instant, plus the last folder handle
// so it can be reopened with one click on the next visit.

import type { PhotoRecord } from './types';

const DB_NAME = 'photohistory';
const DB_VERSION = 2;
const META_STORE = 'meta';
const KV_STORE = 'kv';
const THUMBS_STORE = 'thumbs';

interface CachedMeta {
  v: 2;
  dateISO: string;
  dateSource: PhotoRecord['dateSource'];
  camera: string | null;
  hasEmbeddedThumb: boolean;
}

export function metaKey(rec: { relPath: string; size: number; lastModified: number }): string {
  return `${rec.relPath}|${rec.size}|${rec.lastModified}`;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(THUMBS_STORE)) db.createObjectStore(THUMBS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    setTimeout(() => resolve(null), 3000);
  });
}

export function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const t = db.transaction(store, mode);
          const req = run(t.objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function loadMetaCache(): Promise<Map<string, CachedMeta>> {
  const keys = await tx<IDBValidKey[]>(META_STORE, 'readonly', (s) => s.getAllKeys());
  const vals = await tx<CachedMeta[]>(META_STORE, 'readonly', (s) => s.getAll());
  const map = new Map<string, CachedMeta>();
  if (keys && vals) {
    for (let i = 0; i < keys.length; i++) {
      const v = vals[i] as CachedMeta | undefined;
      // ignore v1 entries written before name-hint dating existed
      if (v && typeof v.dateISO === 'string' && v.v === 2) map.set(String(keys[i]), v);
    }
  }
  return map;
}

export async function saveMetaBatch(entries: [string, CachedMeta][]): Promise<void> {
  const db = await openDb();
  if (!db || entries.length === 0) return;
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(META_STORE, 'readwrite');
      const s = t.objectStore(META_STORE);
      for (const [k, v] of entries) s.put(v, k);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearMetaCache(): Promise<void> {
  await tx(META_STORE, 'readwrite', (s) => s.clear());
  await tx(THUMBS_STORE, 'readwrite', (s) => s.clear());
}

export interface StoredThumb {
  b: Blob;
  w: number;
  h: number;
  /** false = fast low-res paint (embedded preview); a full thumb replaces it */
  full?: boolean;
}

export async function getThumb(key: string): Promise<StoredThumb | null> {
  const v = await tx<StoredThumb>(THUMBS_STORE, 'readonly', (s) => s.get(key));
  return v && v.b instanceof Blob ? v : null;
}

export async function putThumbBatch(entries: [string, StoredThumb][]): Promise<void> {
  const db = await openDb();
  if (!db || entries.length === 0) return;
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(THUMBS_STORE, 'readwrite');
      const s = t.objectStore(THUMBS_STORE);
      for (const [k, v] of entries) s.put(v, k);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getSavedHandle(): Promise<FileSystemDirectoryHandle | null> {
  return (await tx<FileSystemDirectoryHandle>(KV_STORE, 'readonly', (s) => s.get('lastDir'))) ?? null;
}

export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await tx(KV_STORE, 'readwrite', (s) => s.put(handle, 'lastDir'));
}
