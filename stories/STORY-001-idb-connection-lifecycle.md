# STORY-001: IndexedDB connection lifecycle + thumb index

Status: InReview
Priority: P0 — fixes the user-reported freeze ("hangs after N preloaded photos")
Epic: Preload scaling to 15K+ files (archive measured: 15,393 images + 144 videos)

## Goal

The archive has grown to ~15.5K media files. The thumb pipeline opens a fresh
`indexedDB.open()` connection on every cache call and never closes it, and the
background preloader's warm-start existence check reads the full thumbnail blob
from IndexedDB for every photo. Over a preload session this leaks tens of
thousands of live IDB connections and deserializes ~1-1.5 GB of blobs purely for
existence checks — memory grows with N until the WebView stalls.

Fix: one cached IDB connection per session + a tiny `thumbIndex` store so warm
starts skip cached photos without touching blobs, plus a bounded background
repair trickle for legacy entries whose `full` flag is unknown.

## Context pack

- `lib/cache.ts` — `openDb()` (lines 25-40) leaks a connection per call; `tx()`
  opens per call; `putThumbBatch` (107-121); `clearMetaCache` (89-92);
  `getThumb` (102-105).
- `lib/preloader.ts` — `runJob` warm-start check `getThumb(metaKey(r))` per
  record, serial (line 69).
- `lib/thumbs.ts` — `generate()` step 1 reads persisted thumb; `queueIdbPut`
  buffers writes (24) → `flushIdb` → `putThumbBatch`.
- Consumers of `tx()` (must keep API stable): `lib/favorites.ts` (kv store),
  `lib/scanner.ts` (meta store).

## Changes

1. `lib/cache.ts`:
   - Module-level `dbPromise` — open once per session; `onversionchange` closes
     and resets the cached promise; timeout path must NOT cache `null`.
   - DB_VERSION 2 → 3; new store `thumbIndex` (key → `{ full: boolean }`).
   - `putThumbBatch` writes both `thumbs` and `thumbIndex` atomically
     (single transaction over both stores); index flag = `v.full ?? true`.
   - New `listThumbKeys(): Promise<Set<string>>` via `getAllKeys` (keys only,
     zero blob reads) and `loadThumbIndex(): Promise<Map<string, {full}>>` via
     tiny `getAll` on `thumbIndex`.
   - `clearMetaCache` clears `thumbIndex` too.
2. `lib/preloader.ts`:
   - Build warm-start state once per job: `thumbIndex` map + `listThumbKeys` set.
   - Chunk skip decision: index says full → skip; index says !full → regenerate
     (upgrade); key in thumbs but not in index → skip + push to a legacy repair
     queue (bounded trickle after the main loop: small batches of `getThumb`
     that only repair index entries); no key → generate.
   - notify() once per chunk end (per-entry notifies move to STORY-002 throttle
     semantics; keep a single notify here to avoid behavior change beyond scope).

## Acceptance criteria

- [ ] One IDB connection for a whole session (no `indexedDB.open` per call in
      steady state); versionchange path closes it cleanly.
- [ ] Warm start with 15K cached thumbs performs zero full-blob existence reads
      (only `getAllKeys` + tiny index getAll).
- [ ] Legacy entries (pre-v3) are repaired into `thumbIndex` progressively in
      the background, and `full:false` legacy entries still get upgraded.
- [ ] Favorites/print/meta flows (`tx()`) unchanged.
- [ ] Verify pipeline green (tsc + dateHints tests; cargo tests untouched).

## Out of scope

- Render-storm throttling and React memoization (STORY-002).
- Web preload parallelism / b64 conversion (STORY-003).
- Native pipeline changes (STORY-004).
