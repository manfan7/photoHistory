//! photoHistory — Rust core compiled to WebAssembly.
//!
//! Parses photo/video metadata in the browser: EXIF dates (JPEG, TIFF,
//! most RAW formats), QuickTime/MP4 container dates (mov/mp4/m4v/3gp),
//! camera model and embedded preview thumbnails.

pub mod mp4;

use exif::{In, Tag, Value};
use serde::Serialize;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    /// "YYYY-MM-DDTHH:MM:SS" — the moment the photo was taken
    pub date_taken: Option<String>,
    /// Camera make + model, e.g. "Apple iPhone 14 Pro"
    pub camera: Option<String>,
    /// Byte length of the embedded JPEG preview (EXIF thumbnail), if any
    pub thumb_len: usize,
    /// EXIF orientation (1–8), applied by native thumbnail generation
    pub orientation: u32,
}

#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// Parse metadata from raw file bytes (a head/tail slice or the whole file).
/// Tries EXIF first, then the QuickTime/MP4 container date.
#[wasm_bindgen]
pub fn parse_media(data: &[u8]) -> Option<JsValue> {
    let mut meta = exif_meta(data).unwrap_or_default();
    if meta.date_taken.is_none() {
        meta.date_taken = mp4::mp4_creation_date(data);
    }
    if meta.date_taken.is_none() && meta.camera.is_none() && meta.thumb_len == 0 {
        return None;
    }
    serde_wasm_bindgen::to_value(&meta).ok()
}

/// Extract the embedded JPEG preview (EXIF thumbnail, IFD1) as raw JPEG bytes.
/// Used to preview formats the browser cannot decode natively (RAW, TIFF, HEIC).
#[wasm_bindgen]
pub fn extract_thumbnail(data: &[u8]) -> Option<Vec<u8>> {
    let exif = exif::Reader::new()
        .read_from_container(&mut Cursor::new(data))
        .ok()?;
    let tiff = exif.buf();
    let off = uint_field(&exif, Tag::JPEGInterchangeFormat, In::THUMBNAIL)?;
    let len = uint_field(&exif, Tag::JPEGInterchangeFormatLength, In::THUMBNAIL)?;
    let (off, len) = (off as usize, len as usize);
    if len < 128 || off.checked_add(len)? > tiff.len() {
        return None;
    }
    Some(tiff[off..off + len].to_vec())
}

fn uint_field(exif: &exif::Exif, tag: Tag, place: In) -> Option<u32> {
    exif.get_field(tag, place)?.value.get_uint(0)
}

pub fn exif_meta(data: &[u8]) -> Option<MediaMeta> {
    let exif = exif::Reader::new()
        .read_from_container(&mut Cursor::new(data))
        .ok()?;

    let mut meta = MediaMeta::default();

    // Date priority: when the shutter fired > digitized > file modified.
    for tag in [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime] {
        if meta.date_taken.is_some() {
            break;
        }
        if let Some(field) = exif.get_field(tag, In::PRIMARY) {
            if let Some(raw) = ascii_of(field) {
                if let Some(norm) = normalize_date_time(&raw) {
                    meta.date_taken = Some(norm);
                }
            }
        }
    }

    let make = exif.get_field(Tag::Make, In::PRIMARY).and_then(ascii_of);
    let model = exif.get_field(Tag::Model, In::PRIMARY).and_then(ascii_of);
    meta.camera = match (make, model) {
        (Some(make), Some(model)) => {
            if model.to_lowercase().starts_with(&make.to_lowercase()) {
                Some(model)
            } else {
                Some(format!("{make} {model}"))
            }
        }
        (None, Some(model)) => Some(model),
        (Some(make), None) => Some(make),
        (None, None) => None,
    };

    // IFD1 thumbnail presence (offset + length tags)
    if let (Some(off), Some(len)) = (
        uint_field(&exif, Tag::JPEGInterchangeFormat, In::THUMBNAIL),
        uint_field(&exif, Tag::JPEGInterchangeFormatLength, In::THUMBNAIL),
    ) {
        if len >= 128 && off as usize + len as usize <= exif.buf().len() {
            meta.thumb_len = len as usize;
        }
    }

    // display orientation (portrait photos need rotation in native thumbs)
    if let Some(o) = uint_field(&exif, Tag::Orientation, In::PRIMARY) {
        if (1..=8).contains(&o) {
            meta.orientation = o;
        }
    }

    if meta.date_taken.is_none() && meta.camera.is_none() && meta.thumb_len == 0 {
        None
    } else {
        Some(meta)
    }
}

/// Extract the embedded JPEG preview from raw bytes (plain function — usable
/// from both the WASM bindings and the native Tauri build).
pub fn embedded_preview_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let exif = exif::Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok()?;
    let tiff = exif.buf();
    let off = uint_field(&exif, Tag::JPEGInterchangeFormat, In::THUMBNAIL)?;
    let len = uint_field(&exif, Tag::JPEGInterchangeFormatLength, In::THUMBNAIL)?;
    let (off, len) = (off as usize, len as usize);
    if len < 128 || off.checked_add(len)? > tiff.len() {
        return None;
    }
    Some(tiff[off..off + len].to_vec())
}

fn ascii_of(field: &exif::Field) -> Option<String> {
    match &field.value {
        Value::Ascii(vals) => {
            let raw = vals.first()?;
            let s = String::from_utf8_lossy(raw);
            let s = s.trim().trim_end_matches('\u{0}').trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        }
        _ => None,
    }
}

/// EXIF dates look like "2024:03:05 13:22:10". Validate and convert to
/// "2024-03-05T13:22:10" so ISO-style sorting works lexicographically.
fn normalize_date_time(s: &str) -> Option<String> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let year: u32 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    if !(1970..=2100).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || s.as_bytes().get(4) != Some(&b':')
        || s.as_bytes().get(7) != Some(&b':')
    {
        return None;
    }
    // Reject all-zero placeholder dates some devices write.
    let hhmmss = &s[11..19];
    if hhmmss == "00:00:00" && (month, day) == (1, 1) && year == 1970 {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02}T{hhmmss}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_exif_dates() {
        assert_eq!(
            normalize_date_time("2024:03:05 13:22:10"),
            Some("2024-03-05T13:22:10".to_string())
        );
        assert_eq!(normalize_date_time("0000:00:00 00:00:00"), None);
        assert_eq!(normalize_date_time("999:01:01 00:00:00"), None);
    }
}
