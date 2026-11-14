// Date hints from file and folder names. Messengers and editors often strip
// EXIF, but archives encode dates in names like "2013-08-21-1651.jpg",
// folders like "26.12.2020/", "21.03.2022+женя" or file names like
// "22 марта 2018 г. (1).mp4" — worth parsing before falling back to mtime.

const RU_MONTHS: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function valid(y: number, m: number, d: number): boolean {
  return y >= 1970 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function iso(y: number, m: number, d: number, hh = 0, mi = 0): string {
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mi)}:00`;
}

/** Date encoded in the file name itself. */
export function dateFromName(name: string): string | null {
  // 2024-03-05 / 2024_03_05 / 2024.03.05, optional _HHMM tail
  let m = name.match(/(?:^|\D)(19\d{2}|20\d{2})[-_.](\d{2})[-_.](\d{2})(?:[-_.T ]?(\d{2})(\d{2}))?/);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (valid(y, mo, d)) return iso(y, mo, d, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  }
  // 2024_0305_1545 — year, separator, glued MMDD, optional glued HHMM
  m = name.match(/(?:^|[^\d])(19\d{2}|20\d{2})[-_.](\d{2})(\d{2})(?:[-_.](\d{2})(\d{2}))?/);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (valid(y, mo, d)) return iso(y, mo, d, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  }
  // IMG20230708155116 / IMG_20170122_164939 — glued YYYYMMDD + optional
  // (separated or glued) HHMM[SS]
  m = name.match(/(?:^|[^\d])(19\d{2}|20\d{2})(\d{2})(\d{2})(?:[-_.T ]?(\d{2})(\d{2})(\d{2})?)?(?!\d)/);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (valid(y, mo, d)) return iso(y, mo, d, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  }
  // "22 марта 2018" — Russian month names
  m = name.match(/(\d{1,2})\s+([а-яё]+)\s+((?:19|20)\d{2})/i);
  if (m) {
    const mo = RU_MONTHS[m[2].toLowerCase()];
    const y = +m[3];
    const d = +m[1];
    if (mo && valid(y, mo, d)) return iso(y, mo, d);
  }
  // 26.12.2020 — day-first (RU convention), swap if month > 12
  m = name.match(/(?:^|\D)(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})/);
  if (m) {
    let d = +m[1];
    let mo = +m[2];
    const y = +m[3];
    if (mo > 12 && d <= 12) {
      const t = d;
      d = mo;
      mo = t;
    }
    if (valid(y, mo, d)) return iso(y, mo, d);
  }
  return null;
}

/** Date encoded in a parent folder name; deepest (closest) folder wins. */
export function dateFromPath(relPath: string): string | null {
  const segs = relPath.split('/').slice(0, -1);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    let m = s.match(/(?:^|\D)(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})/);
    if (m) {
      let d = +m[1];
      let mo = +m[2];
      const y = +m[3];
      if (mo > 12 && d <= 12) {
        const t = d;
        d = mo;
        mo = t;
      }
      if (valid(y, mo, d)) return iso(y, mo, d);
    }
    m = s.match(/(?:^|\D)(19\d{2}|20\d{2})[-_.](\d{2})[-_.](\d{2})/);
    if (m) {
      const y = +m[1];
      const mo = +m[2];
      const d = +m[3];
      if (valid(y, mo, d)) return iso(y, mo, d);
    }
    // a folder that is exactly a year ("2025", "2016")
    m = s.match(/^(19\d{2}|20\d{2})$/);
    if (m) return iso(+m[1], 1, 1);
  }
  return null;
}
