'use client';

import { plural } from '@/lib/formats';
import type { ScanState } from '@/lib/types';

interface Props {
  state: ScanState;
  onCancel: () => void;
}

export default function ScanOverlay({ state, onCancel }: Props) {
  const done = state.phase === 'analyze';
  const value = done
    ? Math.round((state.processed / Math.max(1, state.found)) * 100)
    : Math.min(95, Math.round(Math.log10(Math.max(1, state.found)) * 20));
  const R = 62;
  const C = 2 * Math.PI * R;

  return (
    <div className="overlay">
      <div className="scan-card glass glass-strong">
        <div className="ring-wrap">
          <svg width="148" height="148" viewBox="0 0 148 148">
            <defs>
              <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#5ea2ff" />
                <stop offset="55%" stopColor="#9b6eff" />
                <stop offset="100%" stopColor="#ff6ec7" />
              </linearGradient>
            </defs>
            <circle className="ring-bg" cx="74" cy="74" r={R} />
            <circle
              className="ring-fg"
              cx="74"
              cy="74"
              r={R}
              strokeDasharray={C}
              strokeDashoffset={C * (1 - value / 100)}
            />
          </svg>
          <div className="ring-center">
            <div>
              <div className="ring-num">{value}%</div>
              <div className="ring-cap">{done ? 'анализ' : 'поиск файлов'}</div>
            </div>
          </div>
        </div>

        <h2 className="scan-title">
          {done ? 'Анализируем метаданные…' : 'Сканируем папку…'}
        </h2>
        <p className="scan-file">{state.current || ' '}</p>

        <div className="scan-stats">
          <span className="chip">
            {done
              ? `${state.processed.toLocaleString('ru')} / ${state.found.toLocaleString('ru')}`
              : `${state.found.toLocaleString('ru')} найдено`}
          </span>
          {state.skipped > 0 && (
            <span className="chip">
              {state.skipped} {plural(state.skipped, 'пропущен', 'пропущено', 'пропущено')}
            </span>
          )}
        </div>

        <button className="btn btn-ghost" onClick={onCancel}>
          Прервать
        </button>
      </div>
    </div>
  );
}
