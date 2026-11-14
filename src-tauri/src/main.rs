// Фотоархив desktop shell: the same liquid glass web frontend, served from
// the static export embedded into the binary (frontendDist: ../out).
//
// Native commands: print-folder picking (native dialog) and copying photo
// files into it for the "Печать" feature.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
struct PrintDir(Mutex<Option<String>>);

/// Open a native folder dialog; remember and return the chosen path.
#[tauri::command]
fn pick_print_folder(
    state: tauri::State<PrintDir>,
) -> Option<String> {
    let dir = rfd::FileDialog::new()
        .set_title("Папка для печатаемых фотографий")
        .pick_folder()?;
    let path = dir.to_string_lossy().to_string();
    *state.0.lock().unwrap() = Some(path.clone());
    Some(path)
}

#[tauri::command]
fn get_print_folder(state: tauri::State<PrintDir>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

/// Write bytes into the print folder under a non-colliding name; returns the
/// final file name. Core logic is split out for unit testing.
#[tauri::command]
fn save_for_print(
    dir: String,
    name: String,
    data_b64: String,
) -> Result<String, String> {
    use base64::Engine as _;
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

/// "IMG_1.jpg" → "IMG_1.jpg", "IMG_1 (1).jpg", "IMG_1 (2).jpg", …
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
    format!("{stem} ({}){ext}", DateSeed::now_millis())
}

// tiny helper so the fallback path never collides either
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

fn main() {
    tauri::Builder::default()
        .manage(PrintDir::default())
        .invoke_handler(tauri::generate_handler![
            pick_print_folder,
            get_print_folder,
            save_for_print
        ])
        .run(tauri::generate_context!())
        .expect("failed to run photoHistory");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ph_print_test_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
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
        assert_eq!(std::fs::read(dir.join("photo (1).jpg")).unwrap(), b"second");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_missing_dir() {
        let res = write_print_file(Path::new("Z:/definitely/missing/dir"), "a.jpg", b"x");
        assert!(res.is_err());
    }
}
