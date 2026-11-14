/* tslint:disable */
/* eslint-disable */

/**
 * Extract the embedded JPEG preview (EXIF thumbnail, IFD1) as raw JPEG bytes.
 * Used to preview formats the browser cannot decode natively (RAW, TIFF, HEIC).
 */
export function extract_thumbnail(data: Uint8Array | number[]): Uint8Array | undefined;

export function init(): void;

/**
 * Parse metadata from raw file bytes (a head/tail slice or the whole file).
 * Tries EXIF first, then the QuickTime/MP4 container date.
 */
export function parse_media(data: Uint8Array | number[]): any | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly extract_thumbnail: (a: number, b: number) => [number, number];
    readonly init: () => void;
    readonly parse_media: (a: number, b: number) => any;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
