// Tiny IndexedDB layer: cached file metadata (keyed by path+size+mtime)
// so re-opening the same folder is instant, plus the last folder handle
// so it can be reopened with one click on the next visit.
//
// Connection lifecycle: ONE IDBDatabase per session, cached at module level
// and closed only on versionchange. Earlier every get/put called
// indexedDB.open() and leaked the connection — over a 15K-photo preload
// session that meant tens of thousands of live connections and a stall
// that grew with the number of preloaded photos.
//
// Thumb index: `thumbIndex` mirrors `thumbs` (key → { full }) with tiny
// records, so warm-start existence checks never deserialize thumbnail blobs.
// Legacy pre-v3 entries (flag unknown) are repaired progressively by the
// preloader's background trickle.

import type { PhotoRecord } from './types';

const DB_NAME = 'photohistory';
const DB_VERSION = 3;
const META_STORE = 'meta';
const KV_STORE = 'kv';
const THUMBS_STORE = 'thumbs';
const THUMB_INDEX_STORE = 'thumbIndex';

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

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  let usable = false;
  const p = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null); // not cached — cheap retry
    usable = true;
    let settled = false;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(THUMBS_STORE)) db.createObjectStore(THUMBS_STORE);
      if (!db.objectStoreNames.contains(THUMB_INDEX_STORE)) db.createObjectStore(THUMB_INDEX_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        // a timeout/blocked path already gave up on this open — close the
        // late-arriving connection instead of leaking it for the page lifetime
        db.close();
        return;
      }
      settled = true;
      // a future version request must evict this connection cleanly
      db.onversionchange = () => {
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      settled = true;
      if (dbPromise === p) dbPromise = null;
      resolve(null);
    };
    req.onblocked = () => {
      settled = true;
      if (dbPromise === p) dbPromise = null;
      resolve(null);
    };
    // a timed-out open is a dead end — never cache it, let the next call retry
    setTimeout(() => {
      if (!settled) {
        settled = true;
        if (dbPromise === p) dbPromise = null;
        resolve(null);
      }
    }, 3000);
  });
  if (usable) dbPromise = p;
  return p;
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
  await tx(THUMB_INDEX_STORE, 'readwrite', (s) => s.clear());
}

export interface StoredThumb {
  b: Blob;
  w: number;
  h: number;
  /** false = fast low-res paint (embedded preview); a full thumb replaces it */
  full?: boolean;
}

/** Tiny mirror of `thumbs`: key → quality flag, readable without blobs. */
export interface ThumbIndexEntry {
  full: boolean;
}

export async function getThumb(key: string): Promise<StoredThumb | null> {
  const v = await tx<StoredThumb>(THUMBS_STORE, 'readonly', (s) => s.get(key));
  return v && v.b instanceof Blob ? v : null;
}

/** All persisted thumb keys (keys only — zero blob deserialization). */
export async function listThumbKeys(): Promise<Set<string>> {
  const db = await openDb();
  if (!db) return new Set();
  return new Promise((resolve) => {
    try {
      const t = db.transaction(THUMBS_STORE, 'readonly');
      const req = t.objectStore(THUMBS_STORE).getAllKeys();
      req.onsuccess = () => resolve(new Set(req.result.map(String)));
      req.onerror = () => resolve(new Set());
    } catch {
      resolve(new Set());
    }
  });
}

export async function loadThumbIndex(): Promise<Map<string, ThumbIndexEntry>> {
  const db = await openDb();
  if (!db) return new Map();
  return new Promise((resolve) => {
    const empty = new Map<string, ThumbIndexEntry>();
    try {
      const t = db.transaction(THUMB_INDEX_STORE, 'readonly');
      const s = t.objectStore(THUMB_INDEX_STORE);
      const keysReq = s.getAllKeys();
      const valsReq = s.getAll();
      let keys: IDBValidKey[] = [];
      let vals: ThumbIndexEntry[] = [];
      keysReq.onsuccess = () => { keys = keysReq.result; };
      valsReq.onsuccess = () => { vals = valsReq.result; };
      t.oncomplete = () => {
        const m = new Map<string, ThumbIndexEntry>();
        for (let i = 0; i < keys.length; i++) {
          const v = vals[i];
          if (v && typeof v.full === 'boolean') m.set(String(keys[i]), v);
        }
        resolve(m);
      };
      t.onerror = () => resolve(empty);
    } catch {
      resolve(empty);
    }
  });
}

export async function putThumbIndexBatch(entries: [string, ThumbIndexEntry][]): Promise<void> {
  const db = await openDb();
  if (!db || entries.length === 0) return;
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction(THUMB_INDEX_STORE, 'readwrite');
      const s = t.objectStore(THUMB_INDEX_STORE);
      for (const [k, v] of entries) s.put(v, k);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Persist thumbs and their index flags in one atomic transaction. */
export async function putThumbBatch(entries: [string, StoredThumb][]): Promise<void> {
  const db = await openDb();
  if (!db || entries.length === 0) return;
  await new Promise<void>((resolve) => {
    try {
      const t = db.transaction([THUMBS_STORE, THUMB_INDEX_STORE], 'readwrite');
      const st = t.objectStore(THUMBS_STORE);
      const si = t.objectStore(THUMB_INDEX_STORE);
      for (const [k, v] of entries) {
        st.put(v, k);
        si.put({ full: v.full ?? true }, k);
      }
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
      t.onabort = () => resolve();
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
