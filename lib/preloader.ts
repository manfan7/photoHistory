// Background thumbnail preloader — the pattern that makes mobile galleries
// feel instant: after the scan, the whole archive's thumbnails are generated
// ahead of time (native rayon batches on desktop, worker pipeline on web)
// and persisted to IndexedDB. Scrolling then becomes pure cache hits.
//
// Priority rules: visible-cell requests always go first (foregroundPending
// check), HEIC is skipped here (libheif decodes take ~8 s — on-demand only),
// the job aborts when a new scan starts (seq guard).
//
// Warm-start existence checks never read thumbnail blobs: a tiny thumbIndex
// store (key → { full }) plus getAllKeys() decide everything. Reading full
// blobs per photo deserialized ~1 GB on a 15K-photo warm start and was a
// major freeze contributor. Legacy pre-index entries are repaired by a
// bounded background trickle that learns their quality flag.

import {
  getThumb,
  listThumbKeys,
  loadThumbIndex,
  metaKey,
  putThumbBatch,
  putThumbIndexBatch,
  type StoredThumb,
  type ThumbIndexEntry,
} from './cache';
import { b64ToBlob, isTauri, tauriGenThumbs } from './desktop';
import { isHeicExt } from './heic';
import { ensureThumb, foregroundPending, notifyThumbUpgrade } from './thumbs';
import type { PhotoRecord } from './types';

const MAX_EDGE = 560;
const CHUNK = 24;
const YIELD_MS = 60;

let jobSeq = 0;
let runningSeq = -1;
let progress = { done: 0, total: 0 };
const listeners = new Set<(p: { done: number; total: number }) => void>();

export function onPreloadProgress(cb: (p: { done: number; total: number }) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Progress ticks drive a top-level state update on Page; unthrottled they
// re-rendered the whole tree ~26 times per 24-photo chunk. Cap at ~4/s with
// a trailing edge so the final state always lands.
const NOTIFY_MIN_INTERVAL = 250;
let lastNotifyAt = 0;
let trailingTimer: ReturnType<typeof setTimeout> | null = null;

function notifyNow(): void {
  if (trailingTimer) {
    clearTimeout(trailingTimer);
    trailingTimer = null;
  }
  lastNotifyAt = Date.now();
  listeners.forEach((cb) => cb({ ...progress }));
}

function notify(): void {
  const since = Date.now() - lastNotifyAt;
  if (since >= NOTIFY_MIN_INTERVAL) return notifyNow();
  if (trailingTimer === null) {
    trailingTimer = setTimeout(notifyNow, NOTIFY_MIN_INTERVAL - since);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startThumbPreloader(
  records: PhotoRecord[],
  getFile: (id: string) => Promise<File>,
): void {
  const seq = ++jobSeq;
  void runJob(records, getFile, seq);
}

async function runJob(
  records: PhotoRecord[],
  getFile: (id: string) => Promise<File>,
  seq: number,
): Promise<void> {
  runningSeq = seq;
  const targets = records.filter((r) => r.kind === 'image' && !isHeicExt(r.ext));
  progress = { done: 0, total: targets.length };
  notify();

  // warm-start state: tiny index + all persisted keys — no blob reads
  const index = await loadThumbIndex();
  const persisted = await listThumbKeys();
  if (seq !== jobSeq) return;
  // legacy entries whose quality flag is unknown: [key, record]
  const repairQueue: [string, PhotoRecord][] = [];

  for (let i = 0; i < targets.length; i += CHUNK) {
    if (seq !== jobSeq) return;
    // visible cells win: wait out foreground traffic before background chunks
    let idle = 0;
    while (foregroundPending() && seq === jobSeq) {
      await sleep(80);
      if (++idle > 200) break; // don't wait forever on stuck foreground
    }
    if (seq !== jobSeq) return;

    const chunk = targets.slice(i, i + CHUNK);
    const tauriPaths: string[] = [];
    const tauriRecs: PhotoRecord[] = [];
    const webRecs: PhotoRecord[] = [];

    for (const r of chunk) {
      const key = metaKey(r);
      const idx = index.get(key);
      if (idx && idx.full) {
        progress.done++;
        continue;
      }
      if (!idx && persisted.has(key)) {
        // legacy entry — quality unknown; assume done now, trickle-repair later
        repairQueue.push([key, r]);
        progress.done++;
        continue;
      }
      if (isTauri() && r.absPath) {
        tauriPaths.push(r.absPath);
        tauriRecs.push(r);
      } else {
        webRecs.push(r);
      }
    }

    // web pipeline (workers): bounded parallel pool — serial per-record
    // awaits starved the worker pool on big archives
    if (webRecs.length > 0) {
      const WEB_POOL = 6;
      let next = 0;
      const runOne = async (): Promise<void> => {
        while (next < webRecs.length && seq === jobSeq) {
          const r = webRecs[next++];
          const t = await ensureThumb(r, getFile);
          if (t) progress.done++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(WEB_POOL, webRecs.length) }, runOne));
      if (seq !== jobSeq) return;
    }

    if (tauriPaths.length > 0) {
      try {
        const res = await tauriGenThumbs(tauriPaths, MAX_EDGE);
        const entries: [string, StoredThumb][] = [];
        for (let j = 0; j < res.length; j++) {
          const t = res[j];
          const r = tauriRecs[j];
          if (t && t.jpegB64) {
            const blob = await b64ToBlob(t.jpegB64, 'image/jpeg');
            entries.push([metaKey(r), { b: blob, w: t.w, h: t.h, full: t.full ?? true }]);
            index.set(metaKey(r), { full: t.full ?? true });
            notifyThumbUpgrade(r.id);
            progress.done++;
          }
        }
        if (entries.length > 0) await putThumbBatch(entries);
      } catch {
        /* transient IPC failure — chunk is simply skipped */
      }
    }
    notify(); // once per chunk — progress ticks stay cheap
    await sleep(YIELD_MS);
  }

  await repairLegacyEntries(repairQueue, seq);
  notifyNow(); // guaranteed final state — hides the progress chip
}

/**
 * Legacy (pre-thumbIndex) entries: learn their quality flag in small batches
 * and repair the index. `full:false` ones are upgraded right away via the
 * native path, matching the old per-photo getThumb semantics.
 */
async function repairLegacyEntries(
  queue: [string, PhotoRecord][],
  seq: number,
): Promise<void> {
  for (let i = 0; i < queue.length; i += CHUNK) {
    if (seq !== jobSeq) return;
    const slice = queue.slice(i, i + CHUNK);
    const indexEntries: [string, ThumbIndexEntry][] = [];
    const upgradePaths: string[] = [];
    const upgradeRecs: PhotoRecord[] = [];

    for (const [key, r] of slice) {
      const stored = await getThumb(key); // blob read — legacy keys only
      const full = stored ? stored.full !== false : true;
      indexEntries.push([key, { full }]);
      if (stored && stored.full === false && isTauri() && r.absPath) {
        upgradePaths.push(r.absPath);
        upgradeRecs.push(r);
      }
    }
    await putThumbIndexBatch(indexEntries);
    if (seq !== jobSeq) return;
    await sleep(YIELD_MS);

    if (upgradePaths.length > 0) {
      try {
        const res = await tauriGenThumbs(upgradePaths, MAX_EDGE);
        const entries: [string, StoredThumb][] = [];
        for (let j = 0; j < res.length; j++) {
          const t = res[j];
          const r = upgradeRecs[j];
          if (t && t.jpegB64) {
            const blob = await b64ToBlob(t.jpegB64, 'image/jpeg');
            entries.push([metaKey(r), { b: blob, w: t.w, h: t.h, full: t.full ?? true }]);
            notifyThumbUpgrade(r.id);
          }
        }
        if (entries.length > 0) await putThumbBatch(entries);
      } catch {
        /* transient IPC failure — remaining upgrades retry next session */
      }
      await sleep(YIELD_MS);
    }
  }
}
