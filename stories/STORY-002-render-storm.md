# STORY-002: Render storm fix — throttled preload progress, memoized grid

Status: InReview
Priority: P1
Epic: Preload scaling to 15K+ files

## Goal

During the background preload, `notify()` fires ~26 times per 24-photo chunk
(once per entry, once after the IDB write, once at chunk end). Every notify is a
`setPreload` on `Page`, which re-renders TopBar + YearNav + all 11 YearSections
and reconciles every mounted PhotoCell. Over ~640 chunks that is thousands of
full-tree re-renders, competing with rayon decode burn.

Fix: throttle preload notifications; make the grid immune to unrelated Page
state updates (memoized sections/cells, stable callback identities).

## Context pack

- `lib/preloader.ts` — notify() call sites in `runJob` (per-entry + chunk end).
- `app/page.tsx` — `onPreloadProgress((p) => setPreload(p))` (line 99);
  inline `getFile={(id) => getFileRef.current!(id)}` passed to YearSection
  (line 542) and Lightbox (line 605); inline `onCellContext` (line 545).
- `components/YearSection.tsx` — not memoized; `buildRows` memoized on
  [records, metrics]; row items arrays are rebuilt per buildRows call (stable
  between renders thanks to the memo).
- `components/PhotoCell.tsx` — not memoized; effect deps `[rec.id]`.

## Changes

1. `lib/preloader.ts`:
   - Throttle `notify()` to at most ~4 per second (timestamp gate + trailing
     edge so the final state always lands), plus one guaranteed notify at job
     end (done === total) so the progress chip hides.
2. `app/page.tsx`:
   - `getFile` stable via `useCallback` over `getFileRef` (one identity for the
     session), passed to YearSection and Lightbox.
   - `onCellContext` wrapped in `useCallback` (deps: none — setState is stable).
3. `components/YearSection.tsx`: wrap default export in `React.memo`.
4. `components/PhotoCell.tsx`: wrap in plain `React.memo` (shallow). Function
   props MUST participate in the comparison — view switches rebuild idToIndex
   from the same record objects, so ignoring closure identity would leave
   mounted cells with a stale index (review finding 1). Effectiveness comes
   from the stable useCallback identities + memoized YearSection, not from
   ignoring closures.

## Acceptance criteria

- [ ] Preload progress triggers at most ~4 Page re-renders per second (was ~26
      per chunk, ~1-2 s).
- [ ] A Page re-render (e.g. toast, preload tick) does not re-render any
      YearSection or PhotoCell (props stable → memo blocks).
- [ ] Favorite/print toggles still re-render the affected cells instantly.
- [ ] Lightbox still opens with correct index after records change.
- [ ] Verify pipeline green.

## Out of scope

- IDB lifecycle (STORY-001), web parallelism (STORY-003), native pipeline
  (STORY-004).
