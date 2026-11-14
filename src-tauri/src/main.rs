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
fn save_for_print(dir: String, name: String, data_b64: String) -> Result<String, String> {
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
fn pick_archive_folder(state: State<ArchiveDir>) -> Option<String> {
    let dir = rfd::FileDialog::new()
        .set_title("Папка с фотографиями")
        .pick_folder()?;
    let path = dir.to_string_lossy().to_string();
    *state.0.lock().unwrap() = Some(path.clone());
    Some(path)
}

#[tauri::command]
fn scan_folder(dir: String) -> Result<Vec<DirEntryOut>, String> {
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
}

/// EXIF + QuickTime container dating for one file, mirroring the JS
/// escalation order (head 2 MB → full ≤64 MB → tail).
fn analyze_one_real(path: &Path, ext: &str) -> Option<Analyzed> {
    const HEAD: u64 = 2 * 1024 * 1024;
    const MAX_FULL: u64 = 64 * 1024 * 1024;
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

    let mut parsed = |bytes: &[u8]| -> Option<photo_history_wasm::MediaMeta> {
        match photo_history_wasm::exif_meta(bytes) {
            Some(m) => Some(m),
            None => photo_history_wasm::mp4::mp4_creation_date(bytes).map(|d| {
                photo_history_wasm::MediaMeta {
                    date_taken: Some(d),
                    camera: None,
                    thumb_len: 0,
                }
            }),
        }
    };

    if let Some(bytes) = read_slice(0, HEAD) {
        if let Some(m) = parsed(&bytes) {
            date = m.date_taken;
            camera = m.camera;
            thumb_len = m.thumb_len;
        }
    }
    if date.is_none() && size > HEAD {
        if size <= MAX_FULL {
            if let Ok(full) = std::fs::read(path) {
                if let Some(m) = parsed(&full) {
                    date = m.date_taken;
                    camera = m.camera.or(camera);
                    thumb_len = if m.thumb_len > 0 { m.thumb_len } else { thumb_len };
                }
            }
        } else if let Some(bytes) = read_slice(size.saturating_sub(HEAD), HEAD) {
            if let Some(m) = parsed(&bytes) {
                date = m.date_taken;
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
    })
}

#[tauri::command]
fn analyze_files(paths: Vec<String>) -> Vec<Option<Analyzed>> {
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
}

fn gen_thumb_one(path: &Path, max_edge: u32) -> Option<ThumbOut> {
    let img = image::open(path).ok()?;
    let (w0, h0) = (img.width(), img.height());
    let scale = 1.0f64.min(max_edge as f64 / w0.max(h0) as f64);
    let w = ((w0 as f64 * scale).round() as u32).max(1);
    let h = ((h0 as f64 * scale).round() as u32).max(1);
    let thumb = if w == w0 && h == h0 {
        img
    } else {
        img.thumbnail(w, h)
    };
    let mut jpeg = Vec::with_capacity(48 * 1024);
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 78);
    thumb
        .to_rgb8()
        .write_with_encoder(enc)
        .ok()?;
    Some(ThumbOut {
        jpeg_b64: base64::engine::general_purpose::STANDARD.encode(jpeg),
        w,
        h,
    })
}

/// Thumbnails for a batch of files — rayon parallel decode+resize.
#[tauri::command]
fn gen_thumbs(paths: Vec<String>, max_edge: u32) -> Vec<Option<ThumbOut>> {
    paths
        .par_iter()
        .map(|p| gen_thumb_one(Path::new(p), max_edge))
        .collect()
}

#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
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
        let t = gen_thumb_one(&jpg, 560).expect("thumb should succeed");
        assert!(t.w <= 560 && t.h <= 560);
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&t.jpeg_b64)
            .unwrap();
        assert!(raw.len() > 500);
        assert_eq!(&raw[..2], &[0xff, 0xd8]); // JPEG magic
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
        let res = analyze_files(paths.clone());
        let analyze_ms = t0.elapsed().as_millis();
        let dated = res.iter().flatten().filter(|a| a.date_taken.is_some()).count();
        println!("bench analyze_files: {} files, {analyze_ms} ms, {dated} dated", paths.len());

        let t1 = std::time::Instant::now();
        let thumbs = gen_thumbs(paths.clone(), 560);
        let thumb_ms = t1.elapsed().as_millis();
        let ok = thumbs.iter().flatten().count();
        println!("bench gen_thumbs: {} thumbs, {thumb_ms} ms, {ok} ok", paths.len());
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
        // warm-up
        let _ = gen_thumbs(paths.clone(), 560);
        let t0 = std::time::Instant::now();
        let thumbs = gen_thumbs(paths.clone(), 560);
        println!(
            "WARM gen_thumbs: {} thumbs in {} ms ({:.1} ms/thumb effective, {} cores)",
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
