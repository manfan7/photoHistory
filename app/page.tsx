'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar, { type ViewMode } from '@/components/TopBar';
import EmptyState from '@/components/EmptyState';
import ScanOverlay from '@/components/ScanOverlay';
import YearSection from '@/components/YearSection';
import YearNav from '@/components/YearNav';
import Lightbox from '@/components/Lightbox';
import ContextMenu from '@/components/ContextMenu';
import {
  IconCalendar,
  IconFolder,
  IconHeart,
  IconImage,
  IconPrinter,
  IconSparkle,
  IconVideo,
} from '@/components/icons';
import { scanDirectoryHandle, scanFileList, type ScanCallbacks } from '@/lib/scanner';
import { humanSize, plural } from '@/lib/formats';
import { clearMetaCache, getSavedHandle, saveHandle } from '@/lib/cache';
import { FAV_STORE, LAST_DIR_PATH_STORE, PRINT_DIR_STORE, PRINT_STORE } from '@/lib/favorites';
import {
  describePrintDir,
  isTauri,
  pickPrintDir,
  saveForPrint,
  tauriPickArchiveFolder,
  type PrintDirRef,
} from '@/lib/desktop';
import { scanTauriFolder } from '@/lib/scanner';
import { getWasm } from '@/lib/wasm';
import type { PhotoRecord, ScanState } from '@/lib/types';

type Phase = 'idle' | 'scanning' | 'ready';

interface DemoItem {
  name: string;
  mime: string;
  lastModified: number;
}

export default function Page() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [records, setRecords] = useState<PhotoRecord[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [scanState, setScanState] = useState<ScanState | null>(null);
  const [yearsAsc, setYearsAsc] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [restoredName, setRestoredName] = useState<string | null>(null);
  const [supportsFSA, setSupportsFSA] = useState(false);
  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [thumbEpoch, setThumbEpoch] = useState(0);
  const [view, setView] = useState<ViewMode>('all');
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [prints, setPrints] = useState<Set<string>>(new Set());
  const [printDir, setPrintDir] = useState<PrintDirRef | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; rec: PhotoRecord } | null>(null);

  const getFileRef = useRef<((id: string) => Promise<File>) | null>(null);
  const lastSourceRef = useRef<FileSystemDirectoryHandle | File[] | { tauriDir: string } | null>(null);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3200);
  }, []);

  // mount: environment capabilities + last folder offer + warm up the WASM core
  useEffect(() => {
    setSupportsFSA('showDirectoryPicker' in window);
    (async () => {
      if (isTauri()) {
        const savedPath = await LAST_DIR_PATH_STORE.load();
        if (savedPath) setRestoredName(savedPath.split(/[\\/]/).filter(Boolean).pop() || 'Фотоархив');
      } else {
        const h = await getSavedHandle();
        if (h) setRestoredName(h.name);
      }
      const [favsSaved, printsSaved, dirSaved] = await Promise.all([
        FAV_STORE.load(),
        PRINT_STORE.load(),
        PRINT_DIR_STORE.load(),
      ]);
      setFavs(favsSaved);
      setPrints(printsSaved);
      if (dirSaved) setPrintDir(dirSaved);
      void getWasm();
    })();
    if (inputRef.current) {
      (inputRef.current as unknown as { webkitdirectory: boolean }).webkitdirectory = true;
    }
    // debug hooks for automated testing (?debug=1)
    if (typeof window !== 'undefined' && window.location.search.includes('debug=1')) {
      (window as unknown as Record<string, unknown>).__phDebug = {
        setPrintDir,
        setFavs,
        setPrints,
      };
    }
  }, []);

  const runScan = useCallback(
    async (source: FileSystemDirectoryHandle | File[] | { tauriDir: string }, name: string) => {
      cancelledRef.current = false;
      lastSourceRef.current = source;
      setViewerIndex(null);
      setFolderName(name);
      setPhase('scanning');
      setScanState({ phase: 'walk', found: 0, processed: 0, skipped: 0, current: '' });

      const cb: ScanCallbacks = {
        onProgress: (s) => setScanState(s),
        isCancelled: () => cancelledRef.current,
      };

      try {
        let result;
        if (!(source instanceof Array) && 'tauriDir' in source) {
          result = await scanTauriFolder(source.tauriDir, cb);
        } else if (source instanceof Array) {
          result = await scanFileList(source, cb);
        } else {
          result = await scanDirectoryHandle(source, cb);
        }
        getFileRef.current = result.getFile;
        setRecords(result.records);
        setSkippedCount(result.skipped);
        setThumbEpoch((e) => e + 1);
        if (cancelledRef.current && result.records.length > 0) {
          showToast('Анализ прерван — показаны уже обработанные файлы');
        }
        setPhase('ready');
      } catch (err) {
        console.error(err);
        showToast('Не удалось просканировать папку');
        setPhase(records.length > 0 ? 'ready' : 'idle');
      } finally {
        setScanState(null);
      }
    },
    [records.length, showToast],
  );

  const pickFolder = useCallback(async () => {
    if (isTauri()) {
      // native dialog + fully native rayon pipeline
      const dir = await tauriPickArchiveFolder();
      if (!dir) return;
      const name = dir.split(/[\\/]/).filter(Boolean).pop() || 'Фотоархив';
      void LAST_DIR_PATH_STORE.save(dir);
      setRestoredName(name);
      await runScan({ tauriDir: dir }, name);
      return;
    }
    if (!('showDirectoryPicker' in window)) {
      inputRef.current?.click();
      return;
    }
    try {
      const root = await window.showDirectoryPicker!({
        id: 'photohistory',
        mode: 'read',
        startIn: 'pictures',
      });
      void saveHandle(root);
      setRestoredName(root.name);
      await runScan(root, root.name);
    } catch {
      /* user cancelled the native dialog */
    }
  }, [runScan]);

  const pickViaInput = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const arr = Array.from(files);
      const first = arr[0];
      const rel = first.webkitRelativePath || first.name;
      const name = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : 'Выбранная папка';
      await runScan(arr, name);
    },
    [runScan],
  );

  const loadDemo = useCallback(async () => {
    try {
      const base = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/$/, '');
      const manifest = (await fetch(`${base}/demo/manifest.json`).then((r) => r.json())) as DemoItem[];
      const files = await Promise.all(
        manifest.map(async (item) => {
          const blob = await fetch(`${base}/demo/${encodeURIComponent(item.name)}`).then((r) => r.blob());
          return new File([blob], item.name, { type: item.mime, lastModified: item.lastModified });
        }),
      );
      await runScan(files, 'Демо-архив');
    } catch (err) {
      console.error(err);
      showToast('Демо недоступно');
    }
  }, [runScan, showToast]);

  const openRestored = useCallback(async () => {
    if (isTauri()) {
      const saved = await LAST_DIR_PATH_STORE.load();
      if (!saved) return;
      const name = saved.split(/[\\/]/).filter(Boolean).pop() || 'Фотоархив';
      await runScan({ tauriDir: saved }, name);
      return;
    }
    const h = await getSavedHandle();
    if (!h) return;
    type PermHandle = FileSystemDirectoryHandle & {
      queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<string>;
      requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<string>;
    };
    const ph = h as PermHandle;
    try {
      let perm = 'prompt';
      try {
        perm = (await ph.queryPermission?.({ mode: 'read' })) ?? 'prompt';
      } catch {
        /* Firefox/Safari without this API go straight to request */
      }
      if (perm !== 'granted') {
        perm = (await ph.requestPermission?.({ mode: 'read' })) ?? 'denied';
      }
      if (perm === 'granted') await runScan(h, h.name);
      else showToast('Доступ не выдан');
    } catch {
      showToast('Доступ не выдан');
    }
  }, [runScan, showToast]);

  const rescan = useCallback(() => {
    const src = lastSourceRef.current;
    if (src instanceof Array) void runScan(src, folderName ?? 'Папка');
    else if (src && 'tauriDir' in src) void runScan(src, folderName ?? src.tauriDir.split(/[\\/]/).filter(Boolean).pop() ?? 'Папка');
    else if (src) void runScan(src, folderName ?? src.name);
  }, [runScan, folderName]);

  const resetCache = useCallback(async () => {
    await clearMetaCache();
    showToast('Кэш метаданных очищен');
    rescan();
  }, [rescan, showToast]);

  // ── favorites / print handlers ──────────────────────────────────
  const toggleFav = useCallback((rec: PhotoRecord) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(rec.id)) next.delete(rec.id);
      else next.add(rec.id);
      void FAV_STORE.save(next);
      return next;
    });
  }, []);

  const choosePrintDir = useCallback(async (): Promise<PrintDirRef | null> => {
    try {
      const dir = await pickPrintDir();
      if (dir) {
        setPrintDir(dir);
        void PRINT_DIR_STORE.save(dir);
      }
      return dir;
    } catch {
      return null;
    }
  }, []);

  const saveRecForPrint = useCallback(
    async (rec: PhotoRecord) => {
      let dir = printDir;
      if (!dir) dir = await choosePrintDir();
      if (!dir) {
        showToast('Папка для печати не выбрана');
        return;
      }
      try {
        const file = await getFileRef.current!(rec.id);
        const finalName = await saveForPrint(dir, file, rec.name);
        setPrints((prev) => {
          const next = new Set(prev).add(rec.id);
          void PRINT_STORE.save(next);
          return next;
        });
        showToast(`Скопировано для печати: ${finalName}`);
      } catch (err) {
        console.error(err);
        showToast('Не удалось скопировать файл');
      }
    },
    [printDir, choosePrintDir, showToast],
  );

  const togglePrint = useCallback(
    (rec: PhotoRecord) => {
      if (prints.has(rec.id)) {
        setPrints((prev) => {
          const next = new Set(prev);
          next.delete(rec.id);
          void PRINT_STORE.save(next);
          return next;
        });
        showToast('Убрано из печати');
      } else {
        void saveRecForPrint(rec);
      }
    },
    [prints, saveRecForPrint, showToast],
  );

  const saveAllForPrint = useCallback(async () => {
    let dir = printDir;
    if (!dir) dir = await choosePrintDir();
    if (!dir) {
      showToast('Папка для печати не выбрана');
      return;
    }
    const list = records.filter((r) => prints.has(r.id));
    let ok = 0;
    for (const rec of list) {
      try {
        const f = await getFileRef.current!(rec.id);
        await saveForPrint(dir, f, rec.name);
        ok++;
      } catch {
        /* keep going */
      }
    }
    showToast(`Скопировано ${ok} из ${list.length}`);
  }, [printDir, choosePrintDir, records, prints, showToast]);

  // ── grouping ─────────────────────────────────────────────────────
  const viewRecords = useMemo(() => {
    if (view === 'fav') return records.filter((r) => favs.has(r.id));
    if (view === 'print') return records.filter((r) => prints.has(r.id));
    return records;
  }, [view, records, favs, prints]);

  const groups = useMemo(() => {
    const byYear = new Map<number, PhotoRecord[]>();
    for (const r of viewRecords) {
      let arr = byYear.get(r.year);
      if (!arr) {
        arr = [];
        byYear.set(r.year, arr);
      }
      arr.push(r);
    }
    const list = [...byYear.entries()]
      .map(([year, recs]) => ({ year, records: recs }))
      .sort((a, b) => (yearsAsc ? a.year - b.year : b.year - a.year));
    return list;
  }, [viewRecords, yearsAsc]);

  const idToIndex = useMemo(() => {
    const m = new Map<string, number>();
    viewRecords.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [viewRecords]);

  const stats = useMemo(() => {
    const photos = viewRecords.filter((r) => r.kind === 'image').length;
    const videos = viewRecords.length - photos;
    const size = viewRecords.reduce((s, r) => s + r.size, 0);
    const metaDated = viewRecords.filter((r) => r.dateSource !== 'fs').length;
    return {
      photos,
      videos,
      size,
      years: groups.length,
      total: viewRecords.length,
      metaPct: viewRecords.length ? Math.round((metaDated / viewRecords.length) * 100) : 0,
      minYear: groups.length ? Math.min(...groups.map((g) => g.year)) : null,
      maxYear: groups.length ? Math.max(...groups.map((g) => g.year)) : null,
    };
  }, [viewRecords, groups]);

  const favCount = useMemo(() => records.reduce((n, r) => (favs.has(r.id) ? n + 1 : n), 0), [records, favs]);
  const printCount = useMemo(() => records.reduce((n, r) => (prints.has(r.id) ? n + 1 : n), 0), [records, prints]);

  // scroll-spy for the year quick-nav
  useEffect(() => {
    if (phase !== 'ready' || groups.length === 0) return;
    const onScroll = () => {
      let current: number | null = null;
      for (const g of groups) {
        const el = document.getElementById(`year-${g.year}`);
        if (el && el.getBoundingClientRect().top <= 180) current = g.year;
      }
      setActiveYear(current ?? groups[groups.length - 1].year);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [phase, groups]);

  const jumpToYear = (year: number) => {
    document.getElementById(`year-${year}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const openViewer = (globalIndex: number) => setViewerIndex(globalIndex);

  return (
    <main>
      <div className="scene" aria-hidden="true">
        <div className="blob blob-1" />
        <div className="blob blob-2" />
        <div className="blob blob-3" />
        <div className="blob blob-4" />
      </div>

      <TopBar
        folderName={folderName}
        hasResults={records.length > 0}
        yearsAsc={yearsAsc}
        view={view}
        favCount={favCount}
        printCount={printCount}
        onViewChange={setView}
        onPick={pickFolder}
        onDemo={loadDemo}
        onToggleSort={() => setYearsAsc((v) => !v)}
        onRescan={rescan}
        onResetCache={resetCache}
        onAbout={() => setAboutOpen(true)}
        onPickPrintDir={() => void choosePrintDir()}
      />

      {phase === 'idle' && (
        <EmptyState
          onPick={pickFolder}
          onDemo={loadDemo}
          restoredName={restoredName}
          onRestore={openRestored}
          supportsFSA={supportsFSA}
        />
      )}

      {phase === 'scanning' && scanState && (
        <ScanOverlay
          state={scanState}
          onCancel={() => {
            cancelledRef.current = true;
          }}
        />
      )}

      {phase === 'ready' && viewRecords.length > 0 && (
        <>
          {view === 'print' && (
            <div className="viewbar glass">
              <span className="chip">
                <IconFolder size={14} />
                {printDir ? describePrintDir(printDir) : 'Папка для печати не выбрана'}
              </span>
              <button className="btn" onClick={() => void choosePrintDir()}>
                Выбрать папку
              </button>
              <button className="btn btn-primary" onClick={() => void saveAllForPrint()}>
                <IconPrinter size={15} />
                Сохранить всё в папку
              </button>
              <span className="viewbar-hint">правый клик по фото → «Сохранить для печати»</span>
            </div>
          )}
          {view === 'fav' && (
            <div className="viewbar glass">
              <span className="chip">
                <IconHeart size={14} filled />
                Избранные фотографии ({favCount})
              </span>
              <span className="viewbar-hint">правый клик по фото → «В избранное», клавиша F в просмотрщике</span>
            </div>
          )}
          <div className="stats-bar glass">
            <span className="stat">
              <IconImage size={16} />
              <b>{stats.photos.toLocaleString('ru')}</b>&nbsp;
              {plural(stats.photos, 'фото', 'фото', 'фото')}
            </span>
            {stats.videos > 0 && (
              <>
                <i className="stat-divider" />
                <span className="stat">
                  <IconVideo size={16} />
                  <b>{stats.videos.toLocaleString('ru')}</b>&nbsp;видео
                </span>
              </>
            )}
            <i className="stat-divider" />
            <span className="stat">
              <IconCalendar size={16} />
              <b>
                {stats.minYear === stats.maxYear
                  ? stats.minYear
                  : `${stats.minYear}–${stats.maxYear}`}
              </b>
            </span>
            <i className="stat-divider" />
            <span className="stat">
              <IconFolder size={16} />
              <b>{humanSize(stats.size)}</b>
            </span>
            <i className="stat-divider" />
            <span className="stat">
              <IconSparkle size={16} />
              метаданные: <b>{stats.metaPct}%</b>
            </span>
            {skippedCount > 0 && (
              <>
                <i className="stat-divider" />
                <span className="stat">пропущено: {skippedCount}</span>
              </>
            )}
          </div>

          <YearNav groups={groups} activeYear={activeYear} onJump={jumpToYear} />

          <div className="archive">
            {groups.map((g) => (
              <YearSection
                key={`${g.year}-${thumbEpoch}`}
                year={g.year}
                records={g.records}
                getFile={(id) => getFileRef.current!(id)}
                favs={favs}
                prints={prints}
                onCellContext={(rec, e) => setCtxMenu({ x: e.clientX, y: e.clientY, rec })}
                onOpen={(i) => {
                  const rec = g.records[i];
                  const idx = idToIndex.get(rec.id);
                  if (idx !== undefined) openViewer(idx);
                }}
              />
            ))}

            <p className="footer">
              <b>Фотоархив</b> · Next.js + Rust (WebAssembly) · файлы обрабатываются локально в
              браузере
            </p>
          </div>
        </>
      )}

      {phase === 'ready' && viewRecords.length === 0 && (
        <div className="empty-wrap" style={{ marginTop: '14vh' }}>
          <div className="empty-card glass" style={{ textAlign: 'center' }}>
            {view === 'fav' ? (
              <>
                <h1 className="empty-title">В избранном пока пусто</h1>
                <p className="empty-sub">
                  Отметьте фотографии: правый клик по плитке → «В избранное», или клавиша F в
                  просмотрщике.
                </p>
              </>
            ) : view === 'print' ? (
              <>
                <h1 className="empty-title">Список печати пуст</h1>
                <p className="empty-sub">
                  Правый клик по фотографии → «Сохранить для печати» — файл скопируется в
                  выбранную папку и появится здесь.
                </p>
              </>
            ) : (
              <>
                <h1 className="empty-title">Медиафайлов не найдено</h1>
                <p className="empty-sub">
                  В выбранной папке нет изображений или видео. Попробуйте другую папку.
                </p>
              </>
            )}
            <div className="empty-actions">
              <button className="btn btn-primary" onClick={() => setView('all')}>
                Вернуться ко всем фото
              </button>
              <button className="btn" onClick={loadDemo}>
                Посмотреть демо
              </button>
            </div>
          </div>
        </div>
      )}

      {viewerIndex !== null && viewRecords[viewerIndex] && (
        <Lightbox
          records={viewRecords}
          index={viewerIndex}
          getFile={(id) => getFileRef.current!(id)}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          fav={favs.has(viewRecords[viewerIndex].id)}
          printed={prints.has(viewRecords[viewerIndex].id)}
          onToggleFav={() => toggleFav(viewRecords[viewerIndex])}
          onTogglePrint={() => togglePrint(viewRecords[viewerIndex])}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              label: 'Открыть',
              icon: <IconImage size={17} />,
              onClick: () => {
                const idx = idToIndex.get(ctxMenu.rec.id);
                if (idx !== undefined) openViewer(idx);
              },
            },
            {
              label: favs.has(ctxMenu.rec.id) ? 'Убрать из избранного' : 'В избранное',
              icon: <IconHeart size={17} filled={favs.has(ctxMenu.rec.id)} />,
              onClick: () => toggleFav(ctxMenu.rec),
            },
            {
              label: prints.has(ctxMenu.rec.id)
                ? 'Убрать из печати'
                : 'Сохранить для печати',
              icon: <IconPrinter size={17} />,
              onClick: () => {
                if (prints.has(ctxMenu.rec.id)) {
                  setPrints((prev) => {
                    const next = new Set(prev);
                    next.delete(ctxMenu.rec.id);
                    void PRINT_STORE.save(next);
                    return next;
                  });
                  showToast('Убрано из печати');
                } else {
                  void saveRecForPrint(ctxMenu.rec);
                }
              },
            },
          ]}
        />
      )}

      {aboutOpen && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setAboutOpen(false)}>
          <div className="about-card glass glass-strong">
            <h2 className="about-title">
              <span className="grad-text">Фотоархив</span> · liquid glass
            </h2>
            <p className="about-text">
              Приложение полностью анализирует выбранную папку: читает EXIF-метаданные каждого
              файла через ядро на Rust, скомпилированное в WebAssembly, извлекает дату съёмки и
              камеру, а для видео — дату из контейнера. Если метаданных нет — берётся дата файла.
            </p>
            <p className="about-text">
              Все файлы обрабатываются локально в вашем браузере и никуда не загружаются.
            </p>
            <div className="about-stack">
              <span className="chip">Next.js</span>
              <span className="chip">React</span>
              <span className="chip">Rust → WASM</span>
              <span className="chip">kamadak-exif</span>
              <span className="chip">IndexedDB кэш</span>
            </div>
            <div style={{ marginTop: 22, display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setAboutOpen(false)}>
                Понятно
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast glass glass-strong">{toast}</div>}

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => void pickViaInput(e.target.files)}
      />
    </main>
  );
}
