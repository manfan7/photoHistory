'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from '@/components/TopBar';
import EmptyState from '@/components/EmptyState';
import ScanOverlay from '@/components/ScanOverlay';
import YearSection from '@/components/YearSection';
import Lightbox from '@/components/Lightbox';
import { IconCalendar, IconFolder, IconImage, IconSparkle, IconVideo } from '@/components/icons';
import { scanDirectoryHandle, scanFileList, type ScanCallbacks } from '@/lib/scanner';
import { humanSize, plural } from '@/lib/formats';
import { clearMetaCache, getSavedHandle, saveHandle } from '@/lib/cache';
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

  const getFileRef = useRef<((id: string) => Promise<File>) | null>(null);
  const lastSourceRef = useRef<FileSystemDirectoryHandle | File[] | null>(null);
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
      const h = await getSavedHandle();
      if (h) setRestoredName(h.name);
      void getWasm();
    })();
    if (inputRef.current) {
      (inputRef.current as unknown as { webkitdirectory: boolean }).webkitdirectory = true;
    }
  }, []);

  const runScan = useCallback(
    async (source: FileSystemDirectoryHandle | File[], name: string) => {
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
        const result =
          source instanceof Array
            ? await scanFileList(source, cb)
            : await scanDirectoryHandle(source, cb);
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
    else if (src) void runScan(src, folderName ?? src.name);
  }, [runScan, folderName]);

  const resetCache = useCallback(async () => {
    await clearMetaCache();
    showToast('Кэш метаданных очищен');
    rescan();
  }, [rescan, showToast]);

  // ── grouping ─────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const byYear = new Map<number, PhotoRecord[]>();
    for (const r of records) {
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
  }, [records, yearsAsc]);

  const idToIndex = useMemo(() => {
    const m = new Map<string, number>();
    records.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [records]);

  const stats = useMemo(() => {
    const photos = records.filter((r) => r.kind === 'image').length;
    const videos = records.length - photos;
    const size = records.reduce((s, r) => s + r.size, 0);
    const metaDated = records.filter((r) => r.dateSource !== 'fs').length;
    return {
      photos,
      videos,
      size,
      years: groups.length,
      metaPct: records.length ? Math.round((metaDated / records.length) * 100) : 0,
      minYear: groups.length ? Math.min(...groups.map((g) => g.year)) : null,
      maxYear: groups.length ? Math.max(...groups.map((g) => g.year)) : null,
    };
  }, [records, groups]);

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
        onPick={pickFolder}
        onDemo={loadDemo}
        onToggleSort={() => setYearsAsc((v) => !v)}
        onRescan={rescan}
        onResetCache={resetCache}
        onAbout={() => setAboutOpen(true)}
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

      {phase === 'ready' && records.length > 0 && (
        <>
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

          <div className="year-nav" key={thumbEpoch}>
            {groups.map((g) => (
              <button
                key={g.year}
                className={`chip${activeYear === g.year ? ' active' : ''}`}
                onClick={() => jumpToYear(g.year)}
              >
                {g.year}
                <span style={{ opacity: 0.55 }}>{g.records.length}</span>
              </button>
            ))}
          </div>

          <div className="archive">
            {groups.map((g) => (
              <YearSection
                key={`${g.year}-${thumbEpoch}`}
                year={g.year}
                records={g.records}
                getFile={(id) => getFileRef.current!(id)}
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

      {phase === 'ready' && records.length === 0 && (
        <div className="empty-wrap" style={{ marginTop: '14vh' }}>
          <div className="empty-card glass" style={{ textAlign: 'center' }}>
            <h1 className="empty-title">Медиафайлов не найдено</h1>
            <p className="empty-sub">
              В выбранной папке нет изображений или видео. Попробуйте другую папку.
            </p>
            <div className="empty-actions">
              <button className="btn btn-primary" onClick={pickFolder}>
                Выбрать другую папку
              </button>
              <button className="btn" onClick={loadDemo}>
                Посмотреть демо
              </button>
            </div>
          </div>
        </div>
      )}

      {viewerIndex !== null && records[viewerIndex] && (
        <Lightbox
          records={records}
          index={viewerIndex}
          getFile={(id) => getFileRef.current!(id)}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
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
