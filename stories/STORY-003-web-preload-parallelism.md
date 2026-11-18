# STORY-003: Web preload parallelism + fast base64 conversion + worker resilience

Status: Done
Priority: P1
Epic: Preload scaling to 15K+ files

## Goal

The web pipeline (GitHub Pages build, non-Tauri browsers) preloads strictly
serially (`await ensureThumb` + 30 ms sleep per photo) — ~15K photos would take
hours. `b64ToBlob` converts every native thumb with a per-byte JS loop
(~2.4M iterations per 24-photo chunk). Worker `onerror` leaves the waiter
promise unresolved forever, permanently wedging that cell and skewing
`foregroundPending()`.

## Context pack

- `lib/preloader.ts` — web branch of `runJob` (lines 78-84): serial per record.
- `lib/desktop.ts` — `b64ToBlob` (lines 88-93): atob + charCodeAt loop;
  `withTimeout` used by callers.
- `lib/thumbs.ts` — worker pool: `initWorkers` (75-101), `onerror` (90-93)
  marks the worker free but never resolves its current task's waiter;
  `decodeViaWorker` (115-120); `MAX_CONCURRENCY = 8` semaphore.

## Changes

1. `lib/desktop.ts` — `b64ToBlob` via `fetch(`data:${mime};base64,${b64}`)`
   (native decoder, no per-byte loop). Fallback to the old loop if fetch
   throws (data URLs are always same-origin, but keep it defensive).
2. `lib/preloader.ts` — web branch runs a bounded parallel pool (6) per chunk
   via a tiny inline semaphore; keep the 60 ms yield between chunks, the seq
   guard, and the foreground-yield wait unchanged.
3. `lib/thumbs.ts` — track each worker's current task id; `onerror` resolves
   that waiter with `{ error }` (caller falls back to main-thread decode), so
   a crashed worker can no longer wedge a cell forever.

## Acceptance criteria

- [ ] Web preload decodes up to 6 photos concurrently per chunk (worker pool
      saturated, queue bounded by chunk size).
- [ ] b64→Blob conversion uses the native data-URL path (no byte loop).
- [ ] A worker crash resolves the pending promise with an error instead of
      hanging; main-thread fallback kicks in.
- [ ] Tauri path behavior unchanged.
- [ ] Verify pipeline green.

## Out of scope

- IDB lifecycle (STORY-001), render storm (STORY-002), native pipeline
  (STORY-004).
