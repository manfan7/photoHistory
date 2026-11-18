# Epic outcome: preload scaling to 15K files

Branch `perf/preload-scaling` (7 commits on 725a39a), review APPROVED 2026-11-18.
Merge pending user approval.

## What was done

- STORY-001: one cached IDBDatabase per session (was: a leaked connection per
  cache call); DB v3 adds `thumbIndex` (tiny key→full mirror) written
  atomically with `thumbs`; warm-start existence checks use getAllKeys + the
  index — zero blob deserialization; legacy entries repaired by a background
  trickle.
- STORY-002: preload progress throttled to ~4/s with a trailing edge; stable
  callback identities in page.tsx; YearSection/PhotoCell shallow-memoized
  (review lesson: never ignore closure identity in a memo comparator — view
  switches rebuild idToIndex from the same record objects).
- STORY-003: web preload runs a 6-wide parallel pool; b64ToBlob via native
  data-URL fetch; crashed thumb workers resolve their waiter (main-thread
  fallback instead of a wedged cell).
- STORY-004: native gen_thumbs is embedded-first (EXIF preview ≥280px edge)
  and disk-cached under %LOCALAPPDATA%/photoHistory/thumbs keyed by stable
  FNV-1a(path|size|mtime|maxEdge); writes go through tmp+rename.

## Measured results

- User archive: 15,393 images + 144 videos (12× the previous stress target).
- Freeze root causes: leaked IDB connections + ~1GB warm-start blob reads +
  ~26 full-tree re-renders per preload chunk + full-decode-everything native
  preload. All four eliminated; freeze mechanism verified gone (stress test:
  heap 62MB peak → 14MB settled, no accumulation).
- Native bench: cache hits 22 thumbs in 72ms vs 446-490ms decode; single big
  photo ~1s decode → ~3ms hit. Warm start = instant (pure cache hits).
- Web stress (324 files, fresh origin): full preload in ~36s (~9 files/s).

## What was learned (retro input)

- Archive JPEGs carry no IFD1 embedded previews (sampled 300) — embedded-first
  helps camera archives, the disk cache carries the win for phone archives.
- Review caught a real P0 in the memo comparator: "rec identity changes with
  closure inputs" is false across view switches. Rule: memo comparators must
  never ignore function props when closures capture per-render state.
- Harness: role agents not deployed in this project/session — the main session
  ran all MAD phases itself (see docs/harness/agents-log.md).

## Known follow-ups (non-blocking)

- Optional: per-writer unique tmp suffix for the disk cache (reviewer nit).
- Pre-existing: worker script-load failure wedges later tasks; progress chip
  parks on failed chunks.
- Optional: turbojpeg/fast_image_resize for the remaining full decodes;
  Service Worker for web asset caching.
