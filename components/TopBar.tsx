'use client';

import { useEffect, useRef, useState } from 'react';
import {
  IconFolder,
  IconHeart,
  IconImage,
  IconInfo,
  IconMore,
  IconPrinter,
  IconRefresh,
  IconSort,
  IconSparkle,
  IconTrash,
} from './icons';

export type ViewMode = 'all' | 'fav' | 'print';

interface Props {
  folderName: string | null;
  hasResults: boolean;
  yearsAsc: boolean;
  view: ViewMode;
  favCount: number;
  printCount: number;
  onViewChange: (v: ViewMode) => void;
  onPick: () => void;
  onDemo: () => void;
  onToggleSort: () => void;
  onRescan: () => void;
  onResetCache: () => void;
  onAbout: () => void;
  onPickPrintDir: () => void;
}

export default function TopBar({
  folderName,
  hasResults,
  yearsAsc,
  view,
  favCount,
  printCount,
  onViewChange,
  onPick,
  onDemo,
  onToggleSort,
  onRescan,
  onResetCache,
  onAbout,
  onPickPrintDir,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <nav className="topbar glass">
      <div className="brand">
        <div className="brand-logo">
          <IconImage size={19} />
        </div>
        <span className="brand-title">Фотоархив</span>
      </div>

      {folderName && (
        <span className="folder-chip">
          <IconFolder size={15} />
          <span>{folderName}</span>
        </span>
      )}

      <div className="topbar-spacer" />

      {hasResults && (
        <div className="viewtabs" role="tablist">
          <button
            className={view === 'all' ? 'active' : ''}
            onClick={() => onViewChange('all')}
            role="tab"
            aria-selected={view === 'all'}
          >
            <IconImage size={15} />
            <span className="vt-label">Все</span>
          </button>
          <button
            className={view === 'fav' ? 'active' : ''}
            onClick={() => onViewChange('fav')}
            role="tab"
            aria-selected={view === 'fav'}
          >
            <IconHeart size={15} filled={view === 'fav'} />
            <span className="vt-label">Избранное</span>
            {favCount > 0 && <span className="vt-count">{favCount}</span>}
          </button>
          <button
            className={view === 'print' ? 'active' : ''}
            onClick={() => onViewChange('print')}
            role="tab"
            aria-selected={view === 'print'}
          >
            <IconPrinter size={15} />
            <span className="vt-label">Печать</span>
            {printCount > 0 && <span className="vt-count">{printCount}</span>}
          </button>
        </div>
      )}

      {hasResults && <div className="topbar-spacer" />}

      <button className="btn btn-primary" onClick={onPick}>
        <IconFolder size={16} />
        <span className="btn-label">Выбрать папку</span>
      </button>

      <div className="menu-wrap" ref={wrapRef}>
        <button
          className="btn btn-icon"
          onClick={() => setOpen((v) => !v)}
          aria-label="Меню"
          aria-expanded={open}
        >
          <IconMore size={20} />
        </button>

        {open && (
          <div className="menu" role="menu">
            <button className="menu-item" onClick={act(onPick)}>
              <IconFolder size={17} />
              <span className="mi-label">Открыть папку…</span>
            </button>
            <button className="menu-item" onClick={act(onDemo)}>
              <IconSparkle size={17} />
              <span className="mi-label">Демо-архив</span>
            </button>

            <div className="menu-sep" />

            <button className="menu-item" onClick={act(onRescan)} disabled={!hasResults}>
              <IconRefresh size={17} />
              <span className="mi-label">Пересканировать</span>
            </button>
            <button className="menu-item" onClick={act(onToggleSort)}>
              <IconSort size={17} />
              <span className="mi-label">Годы</span>
              <span className="mi-hint">{yearsAsc ? 'сверху старые' : 'сверху новые'}</span>
            </button>
            <button className="menu-item" onClick={act(onPickPrintDir)}>
              <IconPrinter size={17} />
              <span className="mi-label">Папка для печати…</span>
            </button>
            <button className="menu-item" onClick={act(onResetCache)}>
              <IconTrash size={17} />
              <span className="mi-label">Сбросить кэш метаданных</span>
            </button>

            <div className="menu-sep" />

            <button className="menu-item" onClick={act(onAbout)}>
              <IconInfo size={17} />
              <span className="mi-label">О приложении</span>
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
