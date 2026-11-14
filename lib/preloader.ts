// Background thumbnail preloader — the pattern that makes mobile galleries
// feel instant: after the scan, the whole archive's thumbnails are generated
// ahead of time (native rayon batches on desktop, worker pipeline on web)
// and persisted to IndexedDB. Scrolling then becomes pure cache hits.
//
// Priority rules: visible-cell requests always go first (foregroundPending
// check), HEIC is skipped here (libheif decodes take ~8 s — on-demand only),
// the job aborts when a new scan starts (seq guard).

import { getThumb, metaKey, putThumbBatch, type StoredThumb } from './cache';
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

function notify(): void {
  listeners.forEach((cb) => cb({ ...progress }));
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

    for (const r of chunk) {
      const stored = await getThumb(metaKey(r));
      if (stored && stored.full !== false) {
        progress.done++;
        continue;
      }
      if (isTauri() && r.absPath) {
        tauriPaths.push(r.absPath);
        tauriRecs.push(r);
      } else {
        // web pipeline (workers) — decode + persist
        const t = await ensureThumb(r, getFile);
        if (t) progress.done++;
        notify();
        if (seq !== jobSeq) return;
        await sleep(30);
      }
    }

    if (tauriPaths.length > 0) {
      try {
        const res = await tauriGenThumbs(tauriPaths, MAX_EDGE);
        const entries: [string, StoredThumb][] = [];
        res.forEach((t, j) => {
          const r = tauriRecs[j];
          if (t && t.jpegB64) {
            const blob = b64ToBlob(t.jpegB64, 'image/jpeg');
            entries.push([metaKey(r), { b: blob, w: t.w, h: t.h, full: true }]);
            notifyThumbUpgrade(r.id);
            progress.done++;
          }
        });
        if (entries.length > 0) await putThumbBatch(entries);
      } catch {
        /* transient IPC failure — chunk is simply skipped */
      }
    }
    notify();
    await sleep(YIELD_MS);
  }
}
