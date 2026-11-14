'use client';

import { useEffect, useState } from 'react';
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
  // keep fallback tiles inside the soft violet→pink→raspberry palette
  return 262 + (h % 92);
}

/**
 * One square tile in the virtualized grid. Mounts only when its row scrolls
 * into view, so the ensureThumb() call here effectively fires for visible
 * photos only — no IntersectionObserver needed.
 */
export default function PhotoCell({ rec, getFile, onOpen }: Props) {
  const [thumb, setThumb] = useState<ThumbInfo | null>(peekThumb(rec.id));
  const [failed, setFailed] = useState(false);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let alive = true;
    ensureThumb(rec, getFile).then((t) => {
      if (!alive) return;
      if (t) setThumb(t);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);

  const showImage = thumb && !broken;
  const hue = hueFor(rec.ext);

  return (
    <button
      className="vcell"
      onClick={onOpen}
      title={rec.name}
      aria-label={`${rec.name}, ${formatDateShort(rec.dateISO)}`}
    >
      {!showImage && !failed && <div className="vcell-tint" />}

      {!showImage && failed && (
        <div
          className="card-fallback"
          style={{
            background: `linear-gradient(145deg, hsla(${hue}, 62%, 58%, 0.38), hsla(${(hue + 60) % 360}, 62%, 46%, 0.16))`,
          }}
        >
          {rec.kind === 'video' ? <IconPlay size={24} /> : <IconImage size={24} />}
          <div className="fb-ext">{(rec.ext || 'FILE').toUpperCase()}</div>
          <div className="fb-sub">нет предпросмотра</div>
        </div>
      )}

      {thumb && (
        <img
          className="vcell-img"
          src={thumb.url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setBroken(true)}
        />
      )}

      <div className="card-sheen" />
      <div className="card-date">{formatDateShort(rec.dateISO)}</div>

      {rec.kind === 'video' && showImage && (
        <div className="card-badge">
          <IconPlay size={15} />
        </div>
      )}
    </button>
  );
}
