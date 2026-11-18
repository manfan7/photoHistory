# STORY-004: Native preload pipeline — embedded-first thumbs + disk cache

Status: Approved
Priority: P1
Epic: Preload scaling to 15K+ files

## Goal

Native `gen_thumbs` does a full `image::open()` decode of every photo
(~370 ms for 24 MP) even though tiles are ~150 px squares, and decodes are
repeated from scratch on every cold start — the whole-archive preload burns
all cores for tens of minutes on a 15K archive.

Fix (two native layers):
1. **Embedded-first**: for each file, try the EXIF embedded preview (head-only
   read, ~10-30 ms) before any full decode; use it when its edge is ≥
   `MIN_TILE_EDGE` (280 px — covers ~148 px tiles up to DPR ~1.9, desktop
   WebView2 default 125-150% scaling). Full decode only for files with no
   usable preview or a tiny one.
2. **Disk cache**: persist generated thumbs under
   `%LOCALAPPDATA%/photoHistory/thumbs/` keyed by a stable FNV-1a hash of
   `path|size|mtime|maxEdge|stage`. Cache hits return instantly with zero
   decode, making warm starts and interrupted preloads resumable.

`ThumbOut` gains a `full: bool` flag (true = final tile quality) so the JS
preloader can persist correct `full` semantics into IndexedDB.

## Context pack

- `src-tauri/src/main.rs` — `gen_thumb_one` (368-395, full decode + separate
  head re-read for orientation), `gen_thumbs_impl` (429-434), 
  `get_embedded_preview_impl` (399-420, head-only preview path to reuse),
  `ThumbOut` (340-345), `read_head` (360-366), `apply_exif_orientation`.
- `lib/desktop.ts` — `ThumbIpc { jpegB64, w, h }`; `tauriGenThumbs`.
- `lib/preloader.ts` — Tauri chunk path writes `full: true` currently; must
  store `t.full ?? true`.
- `lib/thumbs.ts` — `flushTauriBatch` (foreground) writes `full: true`; must
  store `t.full ?? true` (foreground keeps two-stage semantics: embedded
  stage-1 paints first, preload upgrades — embedded-first inside gen_thumbs
  would change the foreground contract, so keep foreground behavior).

## Changes

1. `src-tauri/src/main.rs`:
   - FNV-1a 64-bit hash helper (std's DefaultHasher is process-seeded — not
     stable across runs).
   - Disk cache dir: `%LOCALAPPDATA%/photoHistory/thumbs` (fall back to
     `std::env::temp_dir` when the var is missing); best-effort create; cache
     file = `<hash>.jpg`; IO errors degrade silently to "cache miss".
   - `gen_thumb_one(path, max_edge, allow_embedded)`:
     cache check → hit returns `(bytes, w, h, full=true)`; miss → head read
     once (reuse for both orientation and embedded preview extraction) →
     embedded preview decodes+fits ≥ MIN_TILE_EDGE → encode it; else full
     decode + thumbnail + encode. Both written to disk cache.
     Contract: preload batch entries are final tile quality either way
     (embedded ≥280 or full decode), so `gen_thumbs` always reports
     `full=true`; the flag exists for future callers. Foreground `generate()`
     keeps its own two-stage flow via `get_embedded_preview` (unchanged).
   - `ThumbOut { jpeg_b64, w, h, full }` — serde default for older callers.
   - `gen_thumbs_impl` rayon-maps with the new signature.
   - Tests: temp-dir cache write→hit→no-decode roundtrip; mtime change → miss
     (new hash); embedded-first path returns within bounds; bench prints
     cache-hit timing.
2. `lib/desktop.ts` — `ThumbIpc` gains optional `full?: boolean`.
3. `lib/preloader.ts` + `lib/thumbs.ts` — persist `t.full ?? true` into
   IndexedDB `StoredThumb.full` (both batch paths).

## Acceptance criteria

- [ ] `gen_thumbs` returns from disk cache with zero image decode on warm
      starts (cargo test asserts hit returns identical bytes and skips decode).
- [ ] Files with embedded previews ≥280 px never trigger a full decode during
      preload; smaller/absent previews still get a full decode.
- [ ] Cache survives app restarts (path+size+mtime keyed); changing the file
      invalidates the entry.
- [ ] Foreground two-stage paint (embedded → upgrade) unchanged.
- [ ] `cargo test --release` green; verify pipeline green.

## Out of scope

- HEIC (image-rs cannot decode; still on-demand via heic2any).
- turbojpeg/fast_image_resize swap (separate story if needed).
- Web-side Service Worker caching.
