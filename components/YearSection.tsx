'use client';

import { MONTHS_SHORT, MONTHS_FULL, humanSize, plural } from '@/lib/formats';
import PhotoCard from './PhotoCard';
import type { PhotoRecord } from '@/lib/types';

interface Props {
  year: number;
  records: PhotoRecord[];
  getFile: (id: string) => Promise<File>;
  onOpen: (index: number) => void;
}

export default function YearSection({ year, records, getFile, onOpen }: Props) {
  const photos = records.filter((r) => r.kind === 'image');
  const videos = records.length - photos.length;
  const size = records.reduce((s, r) => s + r.size, 0);

  const byMonth = new Array(12).fill(0) as number[];
  for (const r of records) byMonth[r.month - 1]++;
  const maxMonth = Math.max(...byMonth, 1);

  const present = byMonth.map((c, i) => c > 0 && i);
  const firstIdx = present.find((i) => i !== false) as number | false;
  const lastIdx = [...present].reverse().find((i) => i !== false) as number | false;
  const range =
    firstIdx !== false && lastIdx !== false
      ? firstIdx === lastIdx
        ? MONTHS_FULL[firstIdx]
        : `${MONTHS_SHORT[firstIdx]} — ${MONTHS_SHORT[lastIdx]}`
      : '';

  const parts = [
    `${records.length} ${plural(records.length, 'медиафайл', 'медиафайла', 'медиафайлов')}`,
  ];
  if (videos > 0) parts.push(`${videos} ${plural(videos, 'видео', 'видео', 'видео')}`);
  parts.push(humanSize(size));

  return (
    <section className="year-section" id={`year-${year}`}>
      <header className="year-head glass">
        <div className="year-num grad-text">{year}</div>
        <div className="year-meta">
          <div className="year-count">{parts.join(' · ')}</div>
          <div className="month-bars" title="Фотографии по месяцам">
            {byMonth.map((c, i) => (
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

      <div className="masonry">
        {records.map((rec, i) => (
          <PhotoCard key={rec.id} rec={rec} getFile={getFile} onOpen={() => onOpen(i)} />
        ))}
      </div>
    </section>
  );
}
