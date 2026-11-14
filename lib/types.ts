export type DateSource = 'exif' | 'container' | 'name' | 'fs';

export interface PhotoRecord {
  /** Stable id — relative path inside the scanned folder */
  id: string;
  name: string;
  ext: string;
  relPath: string;
  size: number;
  lastModified: number;
  /** Always present: metadata date or filesystem fallback. "YYYY-MM-DDTHH:MM:SS" */
  dateISO: string;
  dateSource: DateSource;
  camera: string | null;
  kind: 'image' | 'video';
  /** The browser can decode this natively (img/video tags) */
  renderable: boolean;
  /** File carries an embedded JPEG preview we can extract via WASM */
  hasEmbeddedThumb: boolean;
  year: number;
  /** 1–12 */
  month: number;
}

export interface ScanState {
  phase: 'walk' | 'analyze';
  found: number;
  processed: number;
  skipped: number;
  current: string;
}

export interface ScanResult {
  records: PhotoRecord[];
  skipped: number;
  getFile: (id: string) => Promise<File>;
}

export interface ThumbInfo {
  url: string;
  w: number;
  h: number;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
      startIn?: string;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}
