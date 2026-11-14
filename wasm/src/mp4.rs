//! Minimal QuickTime/MP4 container date reader.
//!
//! Locates the `mvhd` (movie header) box and reads `creation_time`,
//! stored as seconds since 1904-01-01 UTC. Works on head/tail slices,
//! so it does not need the whole file in memory.

const QT_EPOCH_OFFSET: i64 = 2_082_844_800; // 1904-01-01 → 1970-01-01
const MIN_UNIX: i64 = 631_152_000; // 1990-01-01 — reject cameras with unset clocks
const MAX_UNIX: i64 = 4_102_444_800; // 2100-01-01

pub fn mp4_creation_date(data: &[u8]) -> Option<String> {
    let mut search_from = 0usize;
    while search_from + 4 <= data.len() {
        let pos = find_bytes(data, search_from, b"mvhd")?;
        let payload = pos + 4; // skip the box type itself
        if payload + 4 > data.len() {
            return None;
        }
        let version = data[payload];
        let raw: u64 = if version == 1 {
            if payload + 12 > data.len() {
                return None;
            }
            read_u64(data, payload + 4)
        } else {
            if payload + 8 > data.len() {
                return None;
            }
            u64::from(read_u32(data, payload + 4))
        };

        if let Some(iso) = quicktime_to_iso(raw) {
            return Some(iso);
        }
        search_from = pos + 4;
    }
    None
}

fn quicktime_to_iso(secs: u64) -> Option<String> {
    // Pre-1904 dates wrap around to huge u64 values — ignore them.
    if secs > i64::MAX as u64 {
        return None;
    }
    // QuickTime counts seconds since 1904-01-01, Unix since 1970-01-01,
    // so the QuickTime value is the larger one.
    let unix = secs as i64 - QT_EPOCH_OFFSET;
    if !(MIN_UNIX..=MAX_UNIX).contains(&unix) {
        return None;
    }
    let days = unix.div_euclid(86_400);
    let second_of_day = unix.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    Some(format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}",
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60
    ))
}

fn read_u32(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

fn read_u64(data: &[u8], at: usize) -> u64 {
    u64::from_be_bytes([
        data[at],
        data[at + 1],
        data[at + 2],
        data[at + 3],
        data[at + 4],
        data[at + 5],
        data[at + 6],
        data[at + 7],
    ])
}

fn find_bytes(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// Howard Hinnant's civil_from_days: days since 1970-01-01 → (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_bytes(creation_secs: u32) -> Vec<u8> {
        let mut v = Vec::new();
        // fake wrapper box so the pattern sits in realistic surroundings
        v.extend_from_slice(&4u32.to_be_bytes());
        v.extend_from_slice(b"free");
        // mvhd box: size (108) + type + version/flags + creation(u32) ...
        let mut mvhd = Vec::new();
        mvhd.extend_from_slice(&108u32.to_be_bytes());
        mvhd.extend_from_slice(b"mvhd");
        mvhd.extend_from_slice(&[0, 0, 0, 0]); // version 0 + flags
        mvhd.extend_from_slice(&creation_secs.to_be_bytes());
        mvhd.resize(108, 0);
        v.extend_from_slice(&mvhd);
        v
    }

    #[test]
    fn reads_quicktime_date() {
        // 2021-06-15 12:00:00 UTC = 1_623_758_400 unix → qt = unix + 2082844800
        let qt = 1_623_758_400i64 + 2_082_844_800;
        let data = box_bytes(qt as u32);
        assert_eq!(
            mp4_creation_date(&data),
            Some("2021-06-15T12:00:00".to_string())
        );
    }

    #[test]
    fn rejects_unset_clocks() {
        let data = box_bytes(0);
        assert_eq!(mp4_creation_date(&data), None);
    }

    #[test]
    fn rejects_pre_1990() {
        let data = box_bytes((631_152_000i64 + 2_082_844_800 - 1) as u32);
        assert_eq!(mp4_creation_date(&data), None);
    }
}
