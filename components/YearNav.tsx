'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons';
import type { PhotoRecord } from '@/lib/types';

interface Props {
  groups: { year: number; records: PhotoRecord[] }[];
  activeYear: number | null;
  onJump: (year: number) => void;
}

/**
 * Sticky year quick-nav. With many years the strip overflows, so it supports:
 * wheel → horizontal scroll, pointer drag, glass arrow buttons at the edges
 * (shown only when there is hidden content) and edge fade hints.
 */
export default function YearNav({ groups, activeYear, onJump }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const drag = useRef<{ startX: number; startLeft: number; moved: boolean } | null>(null);

  const updateArrows = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = navRef.current;
    if (!el) return;
    const onScroll = () => updateArrows();
    // vertical wheel over the strip scrolls it horizontally
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onScroll);
    // scroll events can be suppressed in throttled webview states — poll cheaply
    const poll = setInterval(updateArrows, 350);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onScroll);
      clearInterval(poll);
    };
  }, [groups, updateArrows]);

  // keep the active year chip visible (scroll-spy updates it constantly)
  useEffect(() => {
    const el = navRef.current;
    if (!el || activeYear === null) return;
    const chip = el.querySelector('.chip.active');
    chip?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeYear]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return; // touch scrolls natively
    const el = navRef.current;
    if (!el) return;
    drag.current = { startX: e.clientX, startLeft: el.scrollLeft, moved: false };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers have no capture target */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = navRef.current;
    if (!d || !el) return;
    const dx = e.clientX - d.startX;
    if (Math.abs(dx) > 5) d.moved = true;
    if (d.moved) el.scrollLeft = d.startLeft - dx;
  };

  const endDrag = () => {
    setTimeout(() => {
      drag.current = null;
    }, 0);
  };

  // a drag that ends over a chip must not open the year
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current?.moved) {
      e.preventDefault();
      e.stopPropagation();
      drag.current = null;
    }
  };

  return (
    <div
      ref={wrapRef}
      className={`year-nav-wrap${canLeft ? ' can-left' : ''}${canRight ? ' can-right' : ''}`}
    >
      <button
        className="year-nav-arrow left glass glass-strong"
        onClick={() => {
          navRef.current?.scrollBy({ left: -360 });
          setTimeout(updateArrows, 400);
        }}
        aria-label="Годы левее"
      >
        <IconChevronLeft size={16} />
      </button>

      <div
        ref={navRef}
        className="year-nav"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
      >
        {groups.map((g) => (
          <button
            key={g.year}
            className={`chip${activeYear === g.year ? ' active' : ''}`}
            onClick={() => onJump(g.year)}
          >
            {g.year}
            <span style={{ opacity: 0.55 }}>{g.records.length}</span>
          </button>
        ))}
      </div>

      <div className="fade left" aria-hidden="true" />
      <div className="fade right" aria-hidden="true" />

      <button
        className="year-nav-arrow right glass glass-strong"
        onClick={() => {
          navRef.current?.scrollBy({ left: 360 });
          setTimeout(updateArrows, 400);
        }}
        aria-label="Годы правее"
      >
        <IconChevronRight size={16} />
      </button>
    </div>
  );
}
