export const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'webp', 'bmp', 'dib', 'ico', 'cur',
  'svg', 'avif', 'heic', 'heif', 'hif', 'tif', 'tiff', 'jp2', 'j2k', 'jpf', 'jxl',
  'psd', 'psb', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf',
  'orf', 'rw2', 'raw', 'pef', 'ptx', 'srw', 'x3f', 'erf', 'kdc', 'dcr', 'mos',
  'mef', '3fr', 'fff', 'iiq', 'rwl', 'gpr', 'braw', 'mrw', 'sti',
]);

export const VIDEO_EXTS = new Set([
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', 'mpe',
  'm2v', 'm4p', '3gp', '3g2', 'ts', 'mts', 'm2ts', 'vob', 'ogv', 'f4v', 'rm',
  'rmvb', 'asf', 'divx', 'mxf', 'gvi', 'qt',
]);

/** Formats kamadak-exif can parse (JPEG & TIFF containers, incl. most RAW). */
export const EXIF_CAPABLE = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'tif', 'tiff', 'cr2', 'nef', 'nrw', 'arw', 'srf',
  'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'ptx', 'srw', 'x3f', 'erf', 'kdc',
  'dcr', 'mos', 'mef', '3fr', 'fff', 'iiq', 'rwl', 'gpr', 'mrw',
]);

/** QuickTime/MP4 family — the WASM core scans these for an mvhd date. */
export const CONTAINER_CAPABLE = new Set(['mp4', 'm4v', 'm4p', 'mov', '3gp', '3g2', 'qt']);

/** The browser can usually decode these directly. */
export const RENDERABLE_IMAGE = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif',
  // Safari decodes HEIC natively; on other browsers the card falls back to the embedded preview
  'heic', 'heif', 'hif',
]);

export const RENDERABLE_VIDEO = new Set(['mp4', 'm4v', 'm4p', 'webm', 'mov', 'ogv', '3gp']);

export const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.next', 'out', 'build', 'dist', 'target', 'pkg',
  '$recycle.bin', 'system volume information', 'photohistory', 'appdata',
]);

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function kindOf(ext: string, mime: string): 'image' | 'video' | null {
  if (IMAGE_EXTS.has(ext) || mime.startsWith('image/')) return 'image';
  if (VIDEO_EXTS.has(ext) || mime.startsWith('video/')) return 'video';
  return null;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function formatDateShort(dateISO: string): string {
  const m = MONTHS_SHORT[Number(dateISO.slice(5, 7)) - 1];
  return `${Number(dateISO.slice(8, 10))} ${m} ${dateISO.slice(0, 4)}`;
}
