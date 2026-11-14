'use client';

import { useEffect, useRef, useState } from 'react';
import {
  IconFolder,
  IconImage,
  IconInfo,
  IconMore,
  IconRefresh,
  IconSort,
  IconSparkle,
  IconTrash,
} from './icons';

interface Props {
  folderName: string | null;
  hasResults: boolean;
  yearsAsc: boolean;
  onPick: () => void;
  onDemo: () => void;
  onToggleSort: () => void;
  onRescan: () => void;
  onResetCache: () => void;
  onAbout: () => void;
}

export default function TopBar({
  folderName,
  hasResults,
  yearsAsc,
  onPick,
  onDemo,
  onToggleSort,
  onRescan,
  onResetCache,
  onAbout,
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
