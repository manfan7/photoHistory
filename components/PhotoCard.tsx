'use client';

import { useEffect, useRef, useState } from 'react';
import { ensureThumb, peekThumb } from '@/lib/thumbs';
import { formatDateShort } from '@/lib/formats';
import { IconImage, IconPlay } from './icons';
import type { PhotoRecord, ThumbInfo } from '@/lib/types';

interface Props {
  rec: PhotoRecord;
  getFile: (id: string) => Promise<File>;
  onOpen: () => void;
}

function hueFor(ext: string): number {
  let h = 0;
  for (let i = 0; i < ext.length; i++) h = (h * 31 + ext.charCodeAt(i)) % 360;
  return h;
}

export default function PhotoCard({ rec, getFile, onOpen }: Props) {
  const [thumb, setThumb] = useState<ThumbInfo | null>(peekThumb(rec.id));
  const [failed, setFailed] = useState(false);
  const [imgBroken, setImgBroken] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          io.disconnect();
          ensureThumb(rec, getFile).then((t) => {
            if (!alive) return;
            if (t) setThumb(t);
            else setFailed(true);
          });
        }
      },
      { rootMargin: '900px 0px' },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);

  const showImage = thumb && !imgBroken;
  const aspect = thumb && showImage ? `${thumb.w} / ${thumb.h}` : '4 / 3';
  const hue = hueFor(rec.ext);

  return (
    <button
      ref={ref}
      className="card"
      onClick={onOpen}
      title={rec.name}
      aria-label={`${rec.name}, ${formatDateShort(rec.dateISO)}`}
    >
      <div className="card-img-wrap" style={{ aspectRatio: aspect }}>
        {!showImage && !failed && <div className="card-skeleton" />}

        {!showImage && (failed || imgBroken) && (
          <div
            className="card-fallback"
            style={{
              background: `linear-gradient(145deg, hsla(${hue}, 70%, 55%, 0.4), hsla(${(hue + 60) % 360}, 70%, 45%, 0.18))`,
            }}
          >
            {rec.kind === 'video' ? <IconPlay size={26} /> : <IconImage size={26} />}
            <div className="fb-ext">{(rec.ext || 'FILE').toUpperCase()}</div>
            <div className="fb-sub">просмотр в браузере недоступен</div>
          </div>
        )}

        {thumb && (
          <img
            className="card-img"
            src={thumb.url}
            alt={rec.name}
            loading="lazy"
            draggable={false}
            onError={() => setImgBroken(true)}
          />
        )}

        <div className="card-sheen" />
        <div className="card-date">{formatDateShort(rec.dateISO)}</div>

        {rec.kind === 'video' && showImage && (
          <div className="card-badge">
            <IconPlay size={16} />
          </div>
        )}
      </div>
    </button>
  );
}
