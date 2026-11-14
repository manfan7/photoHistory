'use client';

import { useCallback, useEffect, useState } from 'react';
import { ensureThumb, peekThumb } from '@/lib/thumbs';
import { formatDateShort, humanSize } from '@/lib/formats';
import { IconCamera, IconCalendar, IconChevronLeft, IconChevronRight, IconClose, IconChip } from './icons';
import type { PhotoRecord } from '@/lib/types';

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
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const older = useCallback(
    () => onIndexChange(Math.min(records.length - 1, index + 1)),
    [index, records.length, onIndexChange],
  );
  const newer = useCallback(() => onIndexChange(Math.max(0, index - 1)), [index, onIndexChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') newer();
      else if (e.key === 'ArrowRight') older();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, newer, older]);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setLoading(true);
    setFailed(false);
    setUrl(null);

    (async () => {
      try {
        if (rec.renderable) {
          const file = await getFile(rec.id);
          if (!alive) return;
          objectUrl = URL.createObjectURL(file);
        } else {
          const thumb = peekThumb(rec.id) ?? (await ensureThumb(rec, getFile));
          if (!alive) return;
          if (!thumb) {
            setFailed(true);
            setLoading(false);
            return;
          }
          objectUrl = thumb.url;
        }
        setUrl(objectUrl);
      } catch {
        if (alive) {
          setFailed(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      alive = false;
      // Only revoke object URLs we created for original files here; thumbnail
      // URLs are shared with the card grid and managed by the thumb cache.
      if (objectUrl && rec.renderable) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);

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
        {loading && !failed && <div className="lb-spinner" />}
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
        ) : (
          url &&
          (rec.kind === 'video' ? (
            <video
              key={url}
              className="lb-video"
              src={url}
              controls
              autoPlay
              onLoadedData={() => setLoading(false)}
            />
          ) : (
            <img
              key={url}
              className="lb-img"
              src={url}
              alt={rec.name}
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setFailed(true);
              }}
            />
          ))
        )}
      </div>

      <div className="lb-top glass glass-strong">
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
