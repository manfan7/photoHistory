'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureThumb, peekThumb } from '@/lib/thumbs';
import { heicToJpeg, isHeicExt } from '@/lib/heic';
import { formatDateShort, humanSize } from '@/lib/formats';
import {
  IconCamera,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconChip,
  IconClose,
  IconHeart,
  IconPrinter,
} from './icons';
import type { PhotoRecord, ThumbInfo } from '@/lib/types';

interface Props {
  records: PhotoRecord[];
  index: number;
  getFile: (id: string) => Promise<File>;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  fav: boolean;
  printed: boolean;
  onToggleFav: () => void;
  onTogglePrint: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  exif: 'EXIF',
  container: 'Контейнер',
  name: 'Имя файла',
  fs: 'Файл',
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

interface ViewState {
  zoom: number;
  x: number;
  y: number;
}

export default function Lightbox({
  records,
  index,
  getFile,
  onClose,
  onIndexChange,
  fav,
  printed,
  onToggleFav,
  onTogglePrint,
}: Props) {
  const rec = records[index];
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [fullReady, setFullReady] = useState(false);
  const [fallbackThumb, setFallbackThumb] = useState<ThumbInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const decodedUrlRef = useRef<string | null>(null);
  const heicTriedRef = useRef<string | null>(null);

  // zoom / pan state; zoom=1 means "fit the screen" (object-fit: contain)
  const [view, setView] = useState<ViewState>({ zoom: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const pinchRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchDistRef = useRef<number | null>(null);

  const thumbUrl = rec ? peekThumb(rec.id)?.url ?? null : null;

  const older = useCallback(
    () => onIndexChange(Math.min(records.length - 1, index + 1)),
    [index, records.length, onIndexChange],
  );
  const newer = useCallback(() => onIndexChange(Math.max(0, index - 1)), [index, onIndexChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace') onClose();
      else if (e.key === 'ArrowLeft') newer();
      else if (e.key === 'ArrowRight') older();
      else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') onToggleFav();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, newer, older, onToggleFav]);

  const clampOffset = useCallback((x: number, y: number, scale: number): { x: number; y: number } => {
    const st = stageRef.current;
    const img = imgRef.current;
    if (!st || !img || !img.naturalWidth) return { x: 0, y: 0 };
    const sw = st.clientWidth;
    const sh = st.clientHeight;
    const fit = Math.min(sw / img.naturalWidth, sh / img.naturalHeight);
    const w = img.naturalWidth * fit * scale;
    const h = img.naturalHeight * fit * scale;
    const mx = Math.max(0, (w - sw) / 2);
    const my = Math.max(0, (h - sh) / 2);
    return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) };
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      setView((v) => {
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
        if (nz === v.zoom) return v;
        const st = stageRef.current;
        if (!st) return v;
        const r = st.getBoundingClientRect();
        const cx = clientX - (r.left + r.width / 2);
        const cy = clientY - (r.top + r.height / 2);
        const nx = (v.x + cx) * (nz / v.zoom) - cx;
        const ny = (v.y + cy) * (nz / v.zoom) - cy;
        const c = clampOffset(nx, ny, nz);
        return { zoom: nz, x: c.x, y: c.y };
      });
    },
    [clampOffset],
  );

  const zoomCenter = useCallback(
    (factor: number) => {
      const st = stageRef.current;
      if (!st) return;
      const r = st.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    },
    [zoomAt],
  );

  const fitOneToOne = useCallback(() => {
    const img = imgRef.current;
    const st = stageRef.current;
    if (!img || !st || !img.naturalWidth) return;
    const fit = Math.min(st.clientWidth / img.naturalWidth, st.clientHeight / img.naturalHeight);
    const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, 1 / fit));
    setView((v) => ({ zoom: target, x: clampOffsetRef.current.x, y: clampOffsetRef.current.y }));
  }, []);

  // keep a stable clamp for fitOneToOne (clamped to current zoom)
  const clampOffsetRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    clampOffsetRef.current = clampOffset(0, 0, 1);
  });

  // reset the viewport when the photo changes
  useEffect(() => {
    setView({ zoom: 1, x: 0, y: 0 });
    setDragging(false);
    pinchRef.current.clear();
    pinchDistRef.current = null;
  }, [rec?.id]);

  // wheel zoom (non-passive so we can preventDefault)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (rec?.kind === 'video') return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0018));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, rec?.kind]);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    heicTriedRef.current = null;
    setFullUrl(null);
    setFullReady(false);
    setFallbackThumb(null);
    setFailed(false);
    setLoading(true);

    (async () => {
      try {
        if (rec.renderable) {
          // thumb (already in cache) renders instantly; the original decodes on top
          const file = await getFile(rec.id);
          if (!alive) return;
          objectUrl = URL.createObjectURL(file);
          setFullUrl(objectUrl);
          setLoading(false);
        } else {
          const thumb = peekThumb(rec.id) ?? (await ensureThumb(rec, getFile));
          if (!alive) return;
          if (!thumb) {
            setFailed(true);
          }
          setFallbackThumb(thumb);
          setLoading(false);
        }
      } catch {
        if (alive) {
          setFailed(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      alive = false;
      // Only revoke URLs created here; thumbnail URLs are shared with the
      // card grid and owned by the thumb cache.
      if (objectUrl && rec.renderable) URL.revokeObjectURL(objectUrl);
      if (decodedUrlRef.current) {
        URL.revokeObjectURL(decodedUrlRef.current);
        decodedUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);

  // Chrome/Firefox cannot decode HEIC natively: when the <img> fails, decode
  // the file through the libheif vendor bundle and swap the URL.
  const handleImgError = useCallback(async () => {
    if (!rec || !isHeicExt(rec.ext) || heicTriedRef.current === rec.id) {
      setFullReady(false);
      setFailed(true);
      return;
    }
    heicTriedRef.current = rec.id;
    try {
      const file = await getFile(rec.id);
      const jpg = await heicToJpeg(file);
      if (!jpg) throw new Error('decode failed');
      const decoded = URL.createObjectURL(jpg);
      decodedUrlRef.current = decoded;
      setFullUrl(decoded);
    } catch {
      setFailed(true);
    }
  }, [rec, getFile]);

  if (!rec) return null;

  const zoomable = rec.kind !== 'video';

  return (
    <div
      className="lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-label={rec.name}
    >
      <div
        ref={stageRef}
        className="lb-stage"
        onDoubleClick={(e) => {
          if (!zoomable) return;
          if (view.zoom > 1.01) setView({ zoom: 1, x: 0, y: 0 });
          else zoomAt(e.clientX, e.clientY, 2.5);
        }}
        onPointerDown={(e) => {
          if (!zoomable) return;
          pinchRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pinchRef.current.size >= 2) {
            pinchDistRef.current = null;
            dragRef.current = null;
            setDragging(false);
            return;
          }
          if (view.zoom > 1.001) {
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            dragRef.current = { px: e.clientX, py: e.clientY, ox: view.x, oy: view.y };
            setDragging(true);
          }
        }}
        onPointerMove={(e) => {
          if (!zoomable) return;
          const pts = pinchRef.current;
          if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pts.size >= 2) {
            const [p1, p2] = [...pts.values()];
            const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
            if (pinchDistRef.current && dist > 0) {
              zoomAt((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, dist / pinchDistRef.current);
            }
            pinchDistRef.current = dist;
            return;
          }
          if (dragRef.current) {
            const dx = e.clientX - dragRef.current.px;
            const dy = e.clientY - dragRef.current.py;
            setView((v) => {
              const c = clampOffset(dragRef.current!.ox + dx, dragRef.current!.oy + dy, v.zoom);
              return { zoom: v.zoom, x: c.x, y: c.y };
            });
          }
        }}
        onPointerUp={(e) => {
          pinchRef.current.delete(e.pointerId);
          if (pinchRef.current.size < 2) pinchDistRef.current = null;
          dragRef.current = null;
          setDragging(false);
        }}
        onPointerCancel={(e) => {
          pinchRef.current.delete(e.pointerId);
          if (pinchRef.current.size < 2) pinchDistRef.current = null;
          dragRef.current = null;
          setDragging(false);
        }}
      >
        {loading && !thumbUrl && !fallbackThumb && <div className="lb-spinner" />}

        {failed ? (
          <div className="about-card glass glass-strong" style={{ textAlign: 'center', margin: 0 }}>
            <div className="about-title">
              Формат .{(rec.ext || '?').toUpperCase()} не открывается в браузере
            </div>
            <p className="about-text">
              Браузер не умеет декодировать этот формат, а встроенной миниатюры в файле нет.
              Файл найден и включён в архив — его дату и камеру вы видите ниже.
            </p>
          </div>
        ) : rec.renderable ? (
          <>
            {thumbUrl && !fullReady && (
              <img className="lb-thumb" src={thumbUrl} alt="" draggable={false} />
            )}
            {fullUrl &&
              (rec.kind === 'video' ? (
                <video
                  key={fullUrl}
                  className={`lb-video${fullReady ? ' ready' : ''}`}
                  src={fullUrl}
                  controls
                  autoPlay
                  onLoadedData={() => setFullReady(true)}
                />
              ) : (
                <img
                  key={fullUrl}
                  ref={imgRef}
                  className={`lb-img${fullReady ? ' ready' : ''}${dragging ? ' dragging' : ''}`}
                  style={{
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                    cursor: view.zoom > 1.001 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
                  }}
                  src={fullUrl}
                  alt={rec.name}
                  draggable={false}
                  onLoad={() => setFullReady(true)}
                  onError={() => void handleImgError()}
                />
              ))}
          </>
        ) : fallbackThumb ? (
          <img
            className="lb-img ready"
            src={fallbackThumb.url}
            alt={rec.name}
            draggable={false}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          />
        ) : null}

        {zoomable && (
          <div className="lb-zoom glass glass-strong" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => zoomCenter(0.8)} aria-label="Уменьшить">
              −
            </button>
            <span className="lb-zoom-val">{Math.round(view.zoom * 100)}%</span>
            <button onClick={() => zoomCenter(1.25)} aria-label="Увеличить">
              +
            </button>
            <button onClick={fitOneToOne} aria-label="Реальный размер" title="Реальный размер (1:1)">
              1:1
            </button>
            <button
              onClick={() => setView({ zoom: 1, x: 0, y: 0 })}
              aria-label="Вписать в экран"
              title="Вписать в экран"
            >
              ⤢
            </button>
          </div>
        )}
      </div>

      <div className="lb-top glass glass-strong">
        <button className="lb-back" onClick={onClose} aria-label="Назад к архиву">
          <IconChevronLeft size={15} />
          <span>Назад</span>
        </button>
        <span className="lb-name">{rec.name}</span>
        <button
          className={`lb-act${fav ? ' active' : ''}`}
          onClick={onToggleFav}
          aria-label="В избранное"
          title="В избранное (F)"
        >
          <IconHeart size={16} filled={fav} />
        </button>
        <button
          className={`lb-act${printed ? ' active' : ''}`}
          onClick={onTogglePrint}
          aria-label="Для печати"
          title="Для печати"
        >
          <IconPrinter size={16} />
        </button>
        <span className="lb-counter">
          {records.length - index} / {records.length}
        </span>
      </div>

      <button className="lb-btn glass prev" onClick={older} disabled={index >= records.length - 1} aria-label="Старше">
        <IconChevronLeft size={22} />
      </button>
      <button className="lb-btn glass next" onClick={newer} disabled={index <= 0} aria-label="Новее">
        <IconChevronRight size={22} />
      </button>
      <button className="btn glass-strong lb-close" onClick={onClose} aria-label="Закрыть">
        <IconClose size={20} />
      </button>

      <div className="lb-info glass glass-strong">
        <span className="lb-meta">
          <IconCalendar size={15} />
          <b>{formatDateShort(rec.dateISO)}</b>
        </span>
        {rec.camera && (
          <span className="lb-meta">
            <IconCamera size={15} />
            <b>{rec.camera}</b>
          </span>
        )}
        <span className="lb-meta">
          <IconChip size={15} />
          <b>{humanSize(rec.size)}</b>
        </span>
        <span className={`lb-source${rec.dateSource === 'fs' ? ' fs' : rec.dateSource === 'name' ? ' name' : ''}`}>
          {SOURCE_LABEL[rec.dateSource]}
        </span>
      </div>
    </div>
  );
}
