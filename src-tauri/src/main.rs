// Фотоархив desktop shell: the same liquid glass web frontend, served from
// the static export embedded into the binary (frontendDist: ../out).
//
// Native commands give the desktop build a fully native, rayon-multithreaded
// pipeline: folder scan, EXIF/container dating (reusing the WASM crate's
// parser code), and thumbnail generation — the webview only renders.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

// ── print folder (existing feature) ─────────────────────────────

#[derive(Default)]
struct PrintDir(Mutex<Option<String>>);

#[tauri::command]
fn pick_print_folder(state: State<PrintDir>) -> Option<String> {
    let dir = rfd::FileDialog::new()
        .set_title("Папка для печатаемых фотографий")
        .pick_folder()?;
    let path = dir.to_string_lossy().to_string();
    *state.0.lock().unwrap() = Some(path.clone());
    Some(path)
}

#[tauri::command]
fn get_print_folder(state: State<PrintDir>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
async fn save_for_print(dir: String, name: String, data_b64: String) -> Result<String, String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("bad payload: {e}"))?;
    write_print_file(Path::new(&dir), &name, &data)
}

fn write_print_file(dir: &Path, name: &str, data: &[u8]) -> Result<String, String> {
    if !dir.is_dir() {
        return Err("Папка для печати не найдена".to_string());
    }
    let final_name = unique_name(dir, name);
    std::fs::write(dir.join(&final_name), data).map_err(|e| format!("write failed: {e}"))?;
    Ok(final_name)
}

/// "photo.jpg" → "photo (1).jpg", "photo (2).jpg", …
fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = Path::new(name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000u32 {
        let candidate = format!("{stem} ({i}){ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem} ({}).", DateSeed::now_millis())
}

mod date_seed {
    use std::time::{SystemTime, UNIX_EPOCH};
    pub struct DateSeed;
    impl DateSeed {
        pub fn now_millis() -> u128 {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        }
    }
}
use date_seed::DateSeed;

// ── native media pipeline (scan / analyze / thumbnails) ─────────

#[derive(Default)]
struct ArchiveDir(Mutex<Option<String>>);

const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "gif", "webp", "bmp", "dib", "ico", "svg", "avif",
    "heic", "heif", "hif", "tif", "tiff", "jp2", "j2k", "jpf", "jxl", "psd", "psb", "cr2",
    "cr3", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "raw", "pef", "ptx",
    "srw", "x3f", "erf", "kdc", "dcr", "mos", "mef", "3fr", "fff", "iiq", "rwl", "gpr", "braw",
    "mrw", "sti",
];
const VIDEO_EXTS: &[&str] = &[
    "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpg", "mpeg", "mpe", "m2v", "m4p",
    "3gp", "3g2", "ts", "mts", "m2ts", "vob", "ogv", "f4v", "rm", "rmvb", "asf", "divx", "mxf",
    "gvi", "qt",
];
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".next", "out", "build", "dist", "target", "pkg", "$recycle.bin",
    "system volume information", "photohistory", "appdata",
];

fn ext_of(name: &str) -> String {
    let dot = match name.rfind('.') {
        Some(d) if d > 0 && d < name.len() - 1 => d,
        _ => return String::new(),
    };
    name[dot + 1..].to_lowercase()
}

fn is_media_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext) || VIDEO_EXTS.contains(&ext)
}

#[derive(Serialize)]
pub struct DirEntryOut {
    rel: String,
    abs: String,
    size: u64,
    mtime_ms: u64,
}

fn collect_media(root: &Path, rel_prefix: &str, out: &mut Vec<DirEntryOut>, depth: u32) {
    if depth > 32 {
        return;
    }
    let rd = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if ft.is_dir() {
            let lower = name.to_lowercase();
            if name.starts_with('.') || SKIP_DIRS.contains(&lower.as_str()) {
                continue;
            }
            let child_rel = if rel_prefix.is_empty() {
                name.clone()
            } else {
                format!("{rel_prefix}/{name}")
            };
            collect_media(&entry.path(), &child_rel, out, depth + 1);
        } else {
            let ext = ext_of(&name);
            if !is_media_ext(&ext) {
                continue;
            }
            let (size, mtime_ms) = match entry.metadata() {
                Ok(md) => (
                    md.len(),
                    md.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                ),
                Err(_) => (0, 0),
            };
            let rel = if rel_prefix.is_empty() {
                name.clone()
            } else {
                format!("{rel_prefix}/{name}")
            };
            out.push(DirEntryOut {
                rel,
                abs: entry.path().to_string_lossy().to_string(),
                size,
                mtime_ms,
            });
        }
    }
}

#[tauri::command]
async fn analyze_files(paths: Vec<String>) -> Vec<Option<Analyzed>> {
    tauri::async_runtime::spawn_blocking(move || analyze_files_impl(paths))
        .await
        .map_err(|e| format!("join error: {e}"))
        .unwrap_or_default()
}

#[tauri::command]
async fn gen_thumbs(paths: Vec<String>, max_edge: u32) -> Vec<Option<ThumbOut>> {
    tauri::async_runtime::spawn_blocking(move || gen_thumbs_impl(paths, max_edge))
        .await
        .map_err(|e| format!("join error: {e}"))
        .unwrap_or_default()
}

#[tauri::command]
fn pick_archive_folder(state: State<ArchiveDir>) -> Option<String> {
    let dir = rfd::FileDialog::new()
        .set_title("Папка с фотографиями")
        .pick_folder()?;
    let path = dir.to_string_lossy().to_string();
    *state.0.lock().unwrap() = Some(path.clone());
    Some(path)
}

#[tauri::command]
async fn scan_folder(dir: String) -> Result<Vec<DirEntryOut>, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("Папка не найдена".to_string());
    }
    let mut out = Vec::new();
    collect_media(&root, "", &mut out, 0);
    Ok(out)
}

#[derive(Serialize)]
pub struct Analyzed {
    date_taken: Option<String>,
    camera: Option<String>,
    thumb_len: usize,
    orientation: u32,
}

/// EXIF + QuickTime container dating for one file, mirroring the JS
/// escalation order (head 2 MB → full ≤64 MB → tail). Metadata-less formats
/// (PNG screenshots, stripped messengers images) never trigger full reads —
/// only containers that can actually carry a date do.
fn analyze_one_real(path: &Path, ext: &str) -> Option<Analyzed> {
    const HEAD: u64 = 2 * 1024 * 1024;
    const MAX_FULL: u64 = 64 * 1024 * 1024;
    const EXIF_CAPABLE: &[&str] = &[
        "jpg", "jpeg", "jpe", "jfif", "tif", "tiff", "cr2", "nef", "nrw", "arw", "srf", "sr2",
        "dng", "raf", "orf", "rw2", "pef", "ptx", "srw", "x3f", "erf", "kdc", "dcr", "mos",
        "mef", "3fr", "fff", "iiq", "rwl", "gpr", "mrw",
    ];
    const CONTAINER_CAPABLE: &[&str] = &["mp4", "m4v", "m4p", "mov", "3gp", "3g2", "qt"];

    let exif_cap = EXIF_CAPABLE.contains(&ext);
    let container_cap = CONTAINER_CAPABLE.contains(&ext);
    if !exif_cap && !container_cap {
        // nothing to parse (PNG, webp, mkv…) — zero reads, instant
        return None;
    }
    let size = std::fs::metadata(path).ok()?.len();

    let read_slice = |start: u64, len: u64| -> Option<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(path).ok()?;
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::with_capacity(len as usize);
        f.take(len).read_to_end(&mut buf).ok()?;
        Some(buf)
    };

    let mut date: Option<String> = None;
    let mut camera: Option<String> = None;
    let mut thumb_len: usize = 0;
    let mut orientation: u32 = 1;

    let mut parsed = |bytes: &[u8]| -> Option<photo_history_wasm::MediaMeta> {
        match photo_history_wasm::exif_meta(bytes) {
            Some(m) => Some(m),
            None if container_cap => photo_history_wasm::mp4::mp4_creation_date(bytes).map(|d| {
                photo_history_wasm::MediaMeta {
                    date_taken: Some(d),
                    camera: None,
                    thumb_len: 0,
                    orientation: 1,
                }
            }),
            _ => None,
        }
    };

    if let Some(bytes) = read_slice(0, HEAD) {
        if let Some(m) = parsed(&bytes) {
            date = m.date_taken;
            camera = m.camera;
            thumb_len = m.thumb_len;
            orientation = m.orientation;
        }
    }
    if date.is_none() && size > HEAD {
        // full read only for formats whose metadata can live deeper in the
        // file (RAW TIFF structures); containers (mp4/mov) use the tail
        if exif_cap && size <= MAX_FULL {
            if let Ok(full) = std::fs::read(path) {
                if let Some(m) = parsed(&full) {
                    date = m.date_taken;
                    camera = m.camera.or(camera);
                    thumb_len = if m.thumb_len > 0 { m.thumb_len } else { thumb_len };
                    if m.orientation > 1 {
                        orientation = m.orientation;
                    }
                }
            }
        } else if container_cap {
            if let Some(bytes) = read_slice(size.saturating_sub(HEAD), HEAD) {
                if let Some(m) = parsed(&bytes) {
                    date = m.date_taken;
                }
            }
        }
    }

    if date.is_none() && camera.is_none() && thumb_len == 0 {
        return None;
    }
    Some(Analyzed {
        date_taken: date,
        camera,
        thumb_len,
        orientation,
    })
}

#[tauri::command]
fn analyze_files_impl(paths: Vec<String>) -> Vec<Option<Analyzed>> {
    paths
        .par_iter()
        .map(|p| {
            let path = Path::new(p);
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            analyze_one_real(path, &ext)
        })
        .collect()
}

#[derive(Serialize)]
pub struct ThumbOut {
    jpeg_b64: String,
    w: u32,
    h: u32,
    /// true = final tile quality (preload batches are final either way)
    full: bool,
}

fn apply_exif_orientation(img: image::DynamicImage, orientation: u32) -> image::DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn read_head(path: &Path, len: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    f.take(len).read_to_end(&mut head).ok()?;
    Some(head)
}

/// Stable across runs (std's DefaultHasher is process-seeded, unusable for a
/// persistent cache). FNV-1a 64.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Pixel dimensions straight from the JPEG SOFn frame header — cache hits
/// return without a decode, so dims must come from the cached bytes.
fn jpeg_dims(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xff {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        if marker == 0x01 || (0xd0..=0xd9).contains(&marker) {
            i += 2;
            continue;
        }
        let len = ((bytes[i + 2] as usize) << 8) | bytes[i + 3] as usize;
        let is_sof = (0xc0..=0xcf).contains(&marker)
            && marker != 0xc4
            && marker != 0xc8
            && marker != 0xcc;
        if is_sof {
            if i + 9 > bytes.len() {
                return None;
            }
            let h = ((bytes[i + 5] as u32) << 8) | bytes[i + 6] as u32;
            let w = ((bytes[i + 7] as u32) << 8) | bytes[i + 8] as u32;
            return Some((w, h));
        }
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

/// Disk cache for generated thumbs (~750 MB for a 15K archive — acceptable
/// for a local photo app). Keyed by path|size|mtime|max_edge: changing the
/// file invalidates the entry. IO problems degrade silently to a miss.
fn thumb_cache_dir() -> Option<PathBuf> {
    let base = match std::env::var("LOCALAPPDATA") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => std::env::temp_dir(),
    };
    let dir = base.join("photoHistory").join("thumbs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn thumb_cache_key(path: &Path, max_edge: u32) -> Option<String> {
    let md = std::fs::metadata(path).ok()?;
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(format!(
        "{}|{}|{}|{}",
        path.to_string_lossy(),
        md.len(),
        mtime_ms,
        max_edge
    ))
}

fn thumb_cache_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{:016x}.jpg", fnv1a64(key.as_bytes())))
}

fn fit_dims(w0: u32, h0: u32, max_edge: u32) -> (u32, u32) {
    let scale = 1.0f64.min(max_edge as f64 / w0.max(h0) as f64);
    (
        ((w0 as f64 * scale).round() as u32).max(1),
        ((h0 as f64 * scale).round() as u32).max(1),
    )
}

fn encode_thumb_jpeg(img: &image::DynamicImage, w: u32, h: u32, quality: u8) -> Option<Vec<u8>> {
    let thumb = if w == img.width() && h == img.height() {
        img.to_rgb8()
    } else {
        img.thumbnail(w, h).to_rgb8()
    };
    let mut jpeg = Vec::with_capacity(48 * 1024);
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality);
    thumb.write_with_encoder(enc).ok()?;
    Some(jpeg)
}

/// Embedded previews below this edge are not worth using as a tile's final
/// quality — fall through to a full decode. 280 px covers a ~148 px tile up
/// to DPR ~1.9 (desktop WebView2 runs at 125–150% scaling).
const MIN_TILE_EDGE: u32 = 280;

/// Decode path, no cache: embedded preview first (head-only read), full
/// decode as the fallback. Contract: returned thumbs are final tile quality.
fn gen_thumb_one_decode(path: &Path, max_edge: u32) -> Option<ThumbOut> {
    let head = read_head(path, 2 * 1024 * 1024);
    let orientation = head
        .as_deref()
        .and_then(|h| photo_history_wasm::exif_meta(h))
        .map(|m| m.orientation)
        .unwrap_or(1);

    if let Some(preview) = head
        .as_deref()
        .and_then(|h| photo_history_wasm::embedded_preview_bytes(h))
    {
        if let Ok(img) = image::load_from_memory(&preview) {
            let img = apply_exif_orientation(img, orientation);
            let (w0, h0) = (img.width(), img.height());
            if w0.max(h0) >= MIN_TILE_EDGE {
                let (w, h) = fit_dims(w0, h0, max_edge);
                if let Some(jpeg) = encode_thumb_jpeg(&img, w, h, 76) {
                    return Some(ThumbOut {
                        jpeg_b64: base64::engine::general_purpose::STANDARD.encode(jpeg),
                        w,
                        h,
                        full: true,
                    });
                }
            }
        }
    }

    let img = image::open(path).ok()?;
    let img = apply_exif_orientation(img, orientation);
    let (w0, h0) = (img.width(), img.height());
    let (w, h) = fit_dims(w0, h0, max_edge);
    let jpeg = encode_thumb_jpeg(&img, w, h, 78)?;
    Some(ThumbOut {
        jpeg_b64: base64::engine::general_purpose::STANDARD.encode(jpeg),
        w,
        h,
        full: true,
    })
}

fn gen_thumb_one_cached(path: &Path, max_edge: u32, cache_dir: Option<&Path>) -> Option<ThumbOut> {
    let cp = match cache_dir {
        Some(dir) => thumb_cache_key(path, max_edge).map(|key| thumb_cache_path(dir, &key)),
        None => None,
    };

    if let Some(cp) = &cp {
        if let Ok(bytes) = std::fs::read(cp) {
            if bytes.len() > 128 && bytes.starts_with(&[0xff, 0xd8]) {
                if let Some((w, h)) = jpeg_dims(&bytes) {
                    return Some(ThumbOut {
                        jpeg_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                        w,
                        h,
                        full: true,
                    });
                }
            }
        }
    }

    let out = gen_thumb_one_decode(path, max_edge)?;
    if let Some(cp) = &cp {
        if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(&out.jpeg_b64) {
            // write temp + rename: a background preload chunk and a foreground
            // batch can decode the same path concurrently; rename keeps the
            // cache file always a complete image (last writer wins atomically)
            let tmp = cp.with_extension("jpg.tmp");
            if std::fs::write(&tmp, &raw).is_ok() {
                let _ = std::fs::rename(&tmp, cp);
            } else {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
    Some(out)
}

/// Single-file decode path without cache — used by the decode benches.
#[cfg_attr(not(test), allow(dead_code))]
fn gen_thumb_one(path: &Path, max_edge: u32) -> Option<ThumbOut> {
    gen_thumb_one_cached(path, max_edge, None)
}

/// Instant first paint: the EXIF embedded preview, decoded from the file head
/// only (no full-image decode). Returns downscaled JPEG ≤ max_edge.
fn get_embedded_preview_impl(path: &Path, max_edge: u32) -> Option<ThumbOut> {
    let head = read_head(path, 2 * 1024 * 1024)?;
    let preview = photo_history_wasm::embedded_preview_bytes(&head)?;
    let img = image::load_from_memory(&preview).ok()?;
    let (w0, h0) = (img.width(), img.height());
    let scale = 1.0f64.min(max_edge as f64 / w0.max(h0) as f64);
    let w = ((w0 as f64 * scale).round() as u32).max(1);
    let h = ((h0 as f64 * scale).round() as u32).max(1);
    let thumb = if w == w0 && h == h0 {
        img
    } else {
        img.thumbnail(w, h)
    };
    let mut jpeg = Vec::with_capacity(32 * 1024);
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 76);
    thumb.to_rgb8().write_with_encoder(enc).ok()?;
    Some(ThumbOut {
        jpeg_b64: base64::engine::general_purpose::STANDARD.encode(jpeg),
        w,
        h,
        full: false, // stage-1 fast paint — the preload/full thumb replaces it
    })
}

#[tauri::command]
fn get_embedded_preview(path: String, max_edge: u32) -> Option<ThumbOut> {
    get_embedded_preview_impl(Path::new(&path), max_edge)
}

/// Thumbnails for a batch of files — rayon parallel, embedded-first, disk-cached.
fn gen_thumbs_bare(paths: &[String], max_edge: u32, cache_dir: Option<&Path>) -> Vec<Option<ThumbOut>> {
    paths
        .par_iter()
        .map(|p| gen_thumb_one_cached(Path::new(p), max_edge, cache_dir))
        .collect()
}

#[tauri::command]
fn gen_thumbs_impl(paths: Vec<String>, max_edge: u32) -> Vec<Option<ThumbOut>> {
    let cache_dir = thumb_cache_dir();
    gen_thumbs_bare(&paths, max_edge, cache_dir.as_deref())
}

#[tauri::command]
async fn read_file_b64(path: String) -> Result<String, String> {
    let data = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

fn main() {
    tauri::Builder::default()
        .manage(PrintDir::default())
        .manage(ArchiveDir::default())
        .invoke_handler(tauri::generate_handler![
            pick_print_folder,
            get_print_folder,
            save_for_print,
            pick_archive_folder,
            scan_folder,
            analyze_files,
            gen_thumbs,
            get_embedded_preview,
            read_file_b64
        ])
        .run(tauri::generate_context!())
        .expect("failed to run photoHistory");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ph_native_test_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn demo_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/demo")
    }

    #[test]
    fn writes_and_renames_on_collision() {
        let dir = temp_dir("collision");
        let written = write_print_file(&dir, "photo.jpg", b"first").unwrap();
        assert_eq!(written, "photo.jpg");
        let written2 = write_print_file(&dir, "photo.jpg", b"second").unwrap();
        assert_eq!(written2, "photo (1).jpg");
        let written3 = write_print_file(&dir, "photo.jpg", b"third").unwrap();
        assert_eq!(written3, "photo (2).jpg");
        assert_eq!(std::fs::read(dir.join("photo.jpg")).unwrap(), b"first");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_missing_dir() {
        let res = write_print_file(Path::new("Z:/definitely/missing/dir"), "a.jpg", b"x");
        assert!(res.is_err());
    }

    #[test]
    fn scans_demo_folder() {
        let demo = demo_dir();
        if !demo.is_dir() {
            return; // demo assets not present in CI without generation
        }
        let mut out = Vec::new();
        collect_media(&demo, "", &mut out, 0);
        assert!(out.len() >= 25, "expected >=25 media files, got {}", out.len());
        assert!(out.iter().all(|e| e.size > 0));
    }

    #[test]
    fn analyzes_demo_exif() {
        let demo = demo_dir();
        let jpg = demo.join("demo_2024_03_09_15.jpg");
        if !jpg.is_file() {
            return;
        }
        let a = analyze_one_real(&jpg, "jpg").expect("analyze should succeed");
        assert_eq!(a.date_taken.as_deref(), Some("2024-03-09T10:10:00"));
        assert!(a.camera.as_deref().unwrap_or("").contains("iPhone"));
    }

    #[test]
    fn generates_thumb_within_bounds() {
        let demo = demo_dir();
        let jpg = demo.join("demo_2024_03_09_15.jpg");
        if !jpg.is_file() {
            return;
        }
        let cache = temp_dir("bounds");
        let t = gen_thumb_one_cached(&jpg, 560, Some(&cache)).expect("thumb should succeed");
        assert!(t.w <= 560 && t.h <= 560);
        assert!(t.full);
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&t.jpeg_b64)
            .unwrap();
        assert!(raw.len() > 500);
        assert_eq!(&raw[..2], &[0xff, 0xd8]); // JPEG magic
        std::fs::remove_dir_all(&cache).unwrap();
    }

    #[test]
    fn thumb_cache_roundtrip_and_invalidation() {
        let demo = demo_dir();
        let jpg = demo.join("demo_2024_03_09_15.jpg");
        if !jpg.is_file() {
            return;
        }
        let cache = temp_dir("roundtrip");
        let key = thumb_cache_key(&jpg, 560).expect("key");
        let cp = thumb_cache_path(&cache, &key);

        let first = gen_thumb_one_cached(&jpg, 560, Some(&cache)).expect("miss → decode");
        assert!(cp.is_file(), "cache file written");
        let raw = std::fs::read(&cp).unwrap();
        assert_eq!(&raw[..2], &[0xff, 0xd8]);

        // hit returns the cached payload with dims from the header, no decode
        let second = gen_thumb_one_cached(&jpg, 560, Some(&cache)).expect("hit");
        assert_eq!(first.jpeg_b64, second.jpeg_b64);
        assert_eq!((first.w, first.h), (second.w, second.h));

        // a different key (mtime/size/max_edge) must map to a different file
        let other = thumb_cache_path(&cache, &format!("{key}x"));
        assert_ne!(cp, other);
        assert!(!other.is_file());
        std::fs::remove_dir_all(&cache).unwrap();
    }

    #[test]
    fn jpeg_dims_parses_own_output() {
        let demo = demo_dir();
        let jpg = demo.join("demo_2024_03_09_15.jpg");
        if !jpg.is_file() {
            return;
        }
        let cache = temp_dir("dims");
        let t = gen_thumb_one_cached(&jpg, 560, Some(&cache)).expect("thumb");
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&t.jpeg_b64)
            .unwrap();
        let (w, h) = jpeg_dims(&raw).expect("dims from SOFn");
        assert_eq!((w, h), (t.w, t.h));
        std::fs::remove_dir_all(&cache).unwrap();
    }

    #[test]
    fn bench_native_pipeline() {
        let demo = demo_dir();
        let jpgs: Vec<PathBuf> = std::fs::read_dir(&demo)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "jpg").unwrap_or(false))
            .collect();
        if jpgs.len() < 5 {
            return;
        }
        let paths: Vec<String> = jpgs.iter().map(|p| p.to_string_lossy().to_string()).collect();
        let t0 = std::time::Instant::now();
        let res = analyze_files_impl(paths.clone());
        let analyze_ms = t0.elapsed().as_millis();
        let dated = res.iter().flatten().filter(|a| a.date_taken.is_some()).count();
        println!("bench analyze_files: {} files, {analyze_ms} ms, {dated} dated", paths.len());

        // decode perf: no cache — otherwise the second run measures hits
        let t1 = std::time::Instant::now();
        let thumbs = gen_thumbs_bare(&paths, 560, None);
        let thumb_ms = t1.elapsed().as_millis();
        let ok = thumbs.iter().flatten().count();
        println!("bench gen_thumbs (decode): {} thumbs, {thumb_ms} ms, {ok} ok", paths.len());

        // cache-hit perf: same batch through a warm cache dir
        let cache = temp_dir("benchcache");
        let _ = gen_thumbs_bare(&paths, 560, Some(&cache)); // warm
        let t2 = std::time::Instant::now();
        let hits = gen_thumbs_bare(&paths, 560, Some(&cache));
        println!(
            "bench gen_thumbs (cache hits): {} thumbs, {} ms",
            hits.iter().flatten().count(),
            t2.elapsed().as_millis()
        );
        std::fs::remove_dir_all(&cache).unwrap();
    }
}

#[cfg(test)]
mod bench2 {
    use super::*;
    use std::path::PathBuf;

    fn demo_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/demo")
    }

    #[test]
    fn bench_warm_and_big() {
        let demo = demo_dir();
        let jpgs: Vec<PathBuf> = std::fs::read_dir(&demo)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "jpg").unwrap_or(false))
            .collect();
        let paths: Vec<String> = jpgs.iter().map(|p| p.to_string_lossy().to_string()).collect();
        // decode perf: no cache — the cache would turn the warm run into hits
        let _ = gen_thumbs_bare(&paths, 560, None);
        let t0 = std::time::Instant::now();
        let thumbs = gen_thumbs_bare(&paths, 560, None);
        println!(
            "WARM gen_thumbs (decode): {} thumbs in {} ms ({:.1} ms/thumb effective, {} cores)",
            thumbs.iter().flatten().count(),
            t0.elapsed().as_millis(),
            t0.elapsed().as_millis() as f64 / thumbs.iter().flatten().count() as f64,
            rayon::current_num_threads()
        );
        // big real photo from the user's archive (read-only)
        let big = PathBuf::from("D:/фотоархив/349.jpg");
        if big.is_file() {
            println!("big file size: {} MB", std::fs::metadata(&big).unwrap().len() / 1024 / 1024);
            let t2 = std::time::Instant::now();
            let _ = gen_thumb_one(&big, 560);
            println!("BIG single thumb (cold): {} ms", t2.elapsed().as_millis());
            let t3 = std::time::Instant::now();
            let _ = gen_thumb_one(&big, 560);
            println!("BIG single thumb (warm): {} ms", t3.elapsed().as_millis());
        }
    }
}
