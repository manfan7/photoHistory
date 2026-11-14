'use client';

import { useEffect, useState } from 'react';
import { ensureThumb, onThumbUpgrade, peekThumb } from '@/lib/thumbs';
import { formatDateShort } from '@/lib/formats';
import { IconHeart, IconImage, IconPlay, IconPrinter } from './icons';
import type { PhotoRecord, ThumbInfo } from '@/lib/types';

interface Props {
  rec: PhotoRecord;
  getFile: (id: string) => Promise<File>;
  onOpen: () => void;
  fav: boolean;
  printed: boolean;
  onContext: (e: React.MouseEvent) => void;
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
export default function PhotoCell({ rec, getFile, onOpen, fav, printed, onContext }: Props) {
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
    // low-res first paint upgrades to the full thumb when the background
    // preloader (or a foreground request) replaces it
    const unsub = onThumbUpgrade(rec.id, () => {
      const t = peekThumb(rec.id);
      if (t) setThumb(t);
    });
    return () => {
      alive = false;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id]);

  const showImage = thumb && !broken;
  const hue = hueFor(rec.ext);

  return (
    <button
      className="vcell"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(e);
      }}
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

      {(fav || printed) && (
        <div className="cell-marks">
          {fav && (
            <span className="mark fav" title="В избранном">
              <IconHeart size={12} filled />
            </span>
          )}
          {printed && (
            <span className="mark print" title="Выбрано для печати">
              <IconPrinter size={12} />
            </span>
          )}
        </div>
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
