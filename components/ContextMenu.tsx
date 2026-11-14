'use client';

import { useEffect, useRef } from 'react';

export interface CtxItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}

/** Glass right-click menu, viewport-clamped, closes on outside click / Esc / scroll. */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('contextmenu', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [onClose]);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(x, vw - 280));
  const top = Math.max(8, Math.min(y, vh - items.length * 46 - 24));

  return (
    <div ref={ref} className="ctxmenu glass glass-strong" style={{ left, top }}>
      {items.map((it, i) => (
        <button
          key={i}
          className={`menu-item${it.active ? ' active' : ''}`}
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.icon}
          <span className="mi-label">{it.label}</span>
        </button>
      ))}
    </div>
  );
}
