import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Фотоархив — liquid glass photo history',
  description:
    'Современный фотоархив в стиле Liquid Glass: анализирует метаданные (EXIF) через Rust → WebAssembly и раскладывает фотографии по годам.',
  applicationName: 'Фотоархив',
};

export const viewport: Viewport = {
  themeColor: '#070a14',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
