'use client';

import { IconFolder, IconImage, IconSparkle, IconChip } from './icons';

interface Props {
  onPick: () => void;
  onDemo: () => void;
  restoredName: string | null;
  onRestore: () => void;
  supportsFSA: boolean;
}

export default function EmptyState({ onPick, onDemo, restoredName, onRestore, supportsFSA }: Props) {
  return (
    <div className="empty-wrap">
      <div className="empty-card glass">
        <div className="empty-glyph">
          <IconImage size={44} />
        </div>
        <h1 className="empty-title">Фотоархив</h1>
        <p className="empty-sub">
          Выберите папку с фотографиями — приложение полностью проанализирует все файлы,
          прочитает дату съёмки из метаданных (EXIF) и разложит всё по годам.
        </p>

        {restoredName && (
          <div style={{ marginBottom: 18 }}>
            <button className="btn btn-primary" onClick={onRestore}>
              <IconFolder size={17} />
              Продолжить: {restoredName}
            </button>
          </div>
        )}

        <div className="empty-actions">
          <button className="btn btn-primary" onClick={onPick}>
            <IconFolder size={17} />
            {supportsFSA ? 'Выбрать папку' : 'Выбрать папку'}
          </button>
          <button className="btn" onClick={onDemo}>
            <IconSparkle size={17} />
            Посмотреть демо
          </button>
        </div>

        <p className="empty-note">
          По умолчанию открывайте папку <b>«Фотоархив»</b> — например <b>D:\Фотоархив</b>.
          <br />
          Поддерживаются все популярные форматы: JPG, PNG, HEIC, TIFF, RAW (CR2, NEF, ARW, DNG…),
          видео MP4 / MOV и другие. Дата берётся из EXIF, из контейнера видео или — из даты файла.
        </p>

        <div className="about-stack" style={{ justifyContent: 'center' }}>
          <span className="chip">
            <IconChip size={14} /> EXIF через Rust → WebAssembly
          </span>
          <span className="chip">
            <IconFolder size={14} /> Работает локально, файлы никуда не загружаются
          </span>
        </div>
      </div>
    </div>
  );
}
