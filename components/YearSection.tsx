'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MONTHS_FULL, MONTHS_SHORT, humanSize, plural } from '@/lib/formats';
import PhotoCell from './PhotoCell';
import type { PhotoRecord } from '@/lib/types';

interface Props {
  year: number;
  records: PhotoRecord[];
  getFile: (id: string) => Promise<File>;
  onOpen: (index: number) => void;
  favs: Set<string>;
  prints: Set<string>;
  onCellContext: (rec: PhotoRecord, e: React.MouseEvent) => void;
}

interface GridMetrics {
  cols: number;
  cell: number;
  gap: number;
}

interface RowSpec {
  y: number;
  h: number;
  kind: 'month' | 'photos';
  label?: string;
  count?: number;
  items?: PhotoRecord[];
}

const MONTH_HEADER_H = 42;
const MONTH_HEADER_GAP = 10;

/** Column count / cell size from the actual container width (iOS-Photos-like density). */
function useGridMetrics(ref: React.RefObject<HTMLDivElement | null>): GridMetrics {
  const [m, setM] = useState<GridMetrics>({ cols: 4, cell: 148, gap: 6 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const width = el.clientWidth || 800;
      const gap = 6;
      const cols = Math.max(2, Math.min(9, Math.floor((width + gap) / 156)));
      const cell = Math.floor((width - gap * (cols - 1)) / cols);
      setM((prev) => (prev.cols === cols && prev.cell === cell ? prev : { cols, cell, gap }));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return m;
}

/**
 * Flatten a year into absolute-positioned rows: month separator rows +
 * dense photo rows. Heights are fixed, so total height is exact and the
 * container can be virtualized with plain translateY.
 */
function buildRows(
  records: PhotoRecord[],
  { cols, cell, gap }: GridMetrics,
): { rows: RowSpec[]; total: number } {
  const rows: RowSpec[] = [];
  const byMonth = new Map<number, PhotoRecord[]>();
  for (const r of records) {
    const arr = byMonth.get(r.month);
    if (arr) arr.push(r);
    else byMonth.set(r.month, [r]);
  }

  let y = 0;
  const months = [...byMonth.keys()].sort((a, b) => b - a);
  for (const month of months) {
    const items = byMonth.get(month)!;
    rows.push({
      kind: 'month',
      y,
      h: MONTH_HEADER_H,
      label: MONTHS_FULL[month - 1],
      count: items.length,
    });
    y += MONTH_HEADER_H + MONTH_HEADER_GAP;
    for (let i = 0; i < items.length; i += cols) {
      rows.push({ kind: 'photos', y, h: cell, items: items.slice(i, i + cols) });
      y += cell + gap;
    }
  }
  return { rows, total: Math.max(0, y - gap) };
}

/** Render only the rows intersecting the viewport (+buffer); unmount the rest. */
function useRowWindow(ref: React.RefObject<HTMLDivElement | null>, rows: RowSpec[]): [number, number] {
  const [range, setRange] = useState<[number, number]>([0, -1]);
  useEffect(() => {
    if (rows.length === 0) {
      setRange((prev) => (prev[0] === 0 && prev[1] === -1 ? prev : [0, -1]));
      return;
    }
    const EMPTY: [number, number] = [0, -1];
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || 900;
      const buffer = 600;
      if (rect.bottom < -buffer || rect.top > vh + buffer) {
        setRange((prev) => (prev[0] === EMPTY[0] && prev[1] === EMPTY[1] ? prev : EMPTY));
        return;
      }
      const relTop = Math.max(0, -rect.top);
      const last = rows[rows.length - 1];
      if (relTop >= last.y + last.h) {
        setRange((prev) => (prev[0] === EMPTY[0] && prev[1] === EMPTY[1] ? prev : EMPTY));
        return;
      }
      const relBottom = relTop + vh + buffer;
      let lo = 0;
      let hi = rows.length - 1;
      let start = rows.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].y + rows[mid].h >= relTop - buffer) {
          start = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      if (start >= rows.length) {
        setRange((prev) => (prev[0] === EMPTY[0] && prev[1] === EMPTY[1] ? prev : EMPTY));
        return;
      }
      let end = start;
      while (end + 1 < rows.length && rows[end + 1].y < relBottom) end++;
      setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, end]));
    };
    // scroll events are cheap to process here (11 sections × binary search).
    // Scroll events are ALSO suppressed in some throttled/occluded webview
    // states, so a light interval keeps the window correct everywhere.
    const onScroll = () => update();
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    const poll = setInterval(update, 200);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      clearInterval(poll);
    };
  }, [rows, ref]);
  return range;
}

export default function YearSection({ year, records, getFile, onOpen, favs, prints, onCellContext }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const metrics = useGridMetrics(wrapRef);
  const { rows, total } = useMemo(() => buildRows(records, metrics), [records, metrics]);
  const [start, end] = useRowWindow(wrapRef, rows);
  const idxById = useMemo(() => new Map(records.map((r, i) => [r.id, i] as const)), [records]);

  const photos = records.filter((r) => r.kind === 'image');
  const videos = records.length - photos.length;
  const size = records.reduce((s, r) => s + r.size, 0);

  const byMonthBars = new Array(12).fill(0) as number[];
  for (const r of records) byMonthBars[r.month - 1]++;
  const maxMonth = Math.max(...byMonthBars, 1);

  const present = byMonthBars.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
  const firstIdx = present[0];
  const lastIdx = present[present.length - 1];
  const range =
    firstIdx !== undefined && lastIdx !== undefined
      ? firstIdx === lastIdx
        ? MONTHS_FULL[firstIdx]
        : `${MONTHS_SHORT[firstIdx]} — ${MONTHS_SHORT[lastIdx]}`
      : '';

  const parts = [`${records.length} ${plural(records.length, 'медиафайл', 'медиафайла', 'медиафайлов')}`];
  if (videos > 0) parts.push(`${videos} видео`);
  parts.push(humanSize(size));

  const visible = rows.slice(start, end + 1);

  return (
    <section className="year-section" id={`year-${year}`}>
      <header className="year-head glass">
        <div className="year-num grad-text">{year}</div>
        <div className="year-meta">
          <div className="year-count">{parts.join(' · ')}</div>
          <div className="month-bars" title="Фотографии по месяцам">
            {byMonthBars.map((c, i) => (
              <i
                key={i}
                className={c === 0 ? 'empty' : ''}
                style={{ height: `${c === 0 ? 3 : 4 + Math.round((c / maxMonth) * 22)}px` }}
              />
            ))}
          </div>
        </div>
        <div className="year-range">{range}</div>
      </header>

      <div ref={wrapRef} className="vgrid" style={{ height: total }}>
        {visible.map((row) => {
          if (row.kind === 'month') {
            return (
              <div
                key={`m${row.y}`}
                className="vmonth"
                style={{ transform: `translateY(${row.y}px)`, height: row.h }}
              >
                <span className="vmonth-label">{row.label} {year}</span>
                <span className="vmonth-count">{row.count}</span>
                <i className="vmonth-line" />
              </div>
            );
          }
          return (
            <div
              key={`r${row.y}`}
              className="vrow"
              style={{
                transform: `translateY(${row.y}px)`,
                gridTemplateColumns: `repeat(${metrics.cols}, 1fr)`,
                gap: metrics.gap,
              }}
            >
              {row.items!.map((rec) => (
                <PhotoCell
                  key={rec.id}
                  rec={rec}
                  getFile={getFile}
                  fav={favs.has(rec.id)}
                  printed={prints.has(rec.id)}
                  onContext={(e) => onCellContext(rec, e)}
                  onOpen={() => {
                    const idx = idxById.get(rec.id);
                    if (idx !== undefined) onOpen(idx);
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
