'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureThumb, peekThumb } from '@/lib/thumbs';
import { heicToJpeg, isHeicExt } from '@/lib/heic';
import { formatDateShort, humanSize } from '@/lib/formats';
import { IconCamera, IconCalendar, IconChevronLeft, IconChevronRight, IconClose, IconChip } from './icons';
import type { PhotoRecord, ThumbInfo } from '@/lib/types';

interface Props {
  records: PhotoRecord[];
  index: number;
  getFile: (id: string) => Promise<File>;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

const SOURCE_LABEL: Record<string, string> = {
  exif: 'EXIF',
  container: 'Контейнер',
  fs: 'Файл',
};

export default function Lightbox({ records, index, getFile, onClose, onIndexChange }: Props) {
  const rec = records[index];
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [fullReady, setFullReady] = useState(false);
  const [fallbackThumb, setFallbackThumb] = useState<ThumbInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const decodedUrlRef = useRef<string | null>(null);
  const heicTriedRef = useRef<string | null>(null);

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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, newer, older]);

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

  return (
    <div
      className="lightbox"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-label={rec.name}
    >
      <div className="lb-img-area">
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
                  className={`lb-img${fullReady ? ' ready' : ''}`}
                  src={fullUrl}
                  alt={rec.name}
                  onLoad={() => setFullReady(true)}
                  onError={() => void handleImgError()}
                />
              ))}
          </>
        ) : fallbackThumb ? (
          <img className="lb-img ready" src={fallbackThumb.url} alt={rec.name} draggable={false} />
        ) : null}
      </div>

      <div className="lb-top glass glass-strong">
        <button className="lb-back" onClick={onClose} aria-label="Назад к архиву">
          <IconChevronLeft size={15} />
          <span>Назад</span>
        </button>
        <span className="lb-name">{rec.name}</span>
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
        <span className={`lb-source${rec.dateSource === 'fs' ? ' fs' : ''}`}>
          {SOURCE_LABEL[rec.dateSource]}
        </span>
      </div>
    </div>
  );
}
