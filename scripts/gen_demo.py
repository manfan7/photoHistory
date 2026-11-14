# Generates demo assets for photoHistory: abstract "photos" with real EXIF
# dates (DateTimeOriginal in the proper Exif sub-IFD), camera models, a couple
# of EXIF-less PNGs (filesystem-date fallback) and a handcrafted MP4 whose
# mvhd container date is parsed by the Rust core.
#
# Run:  py scripts/gen_demo.py   (from the project root)

import json
import random
import struct
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "demo"
OUT.mkdir(parents=True, exist_ok=True)

random.seed(42)

# (year, month, day, hour, minute, make, model, width, height)
SPECS = [
    (2016, 7, 14, 11, 25, "Canon", "Canon EOS 1200D", 1100, 730),
    (2017, 3, 22, 16, 40, "Nikon", "NIKON D5300", 800, 1150),
    (2018, 6, 8, 9, 5, "Apple", "iPhone 8", 1000, 1000),
    (2018, 11, 30, 18, 15, "Apple", "iPhone 8", 1150, 760),
    (2019, 5, 17, 13, 50, "Samsung", "SM-G970F", 1120, 750),
    (2020, 1, 5, 10, 20, "Xiaomi", "Mi 9T Pro", 760, 1120),
    (2020, 8, 23, 15, 35, "Xiaomi", "Mi 9T Pro", 1150, 770),
    (2021, 2, 26, 12, 45, "Apple", "iPhone 12 Pro", 1150, 760),
    (2021, 9, 10, 17, 55, "Apple", "iPhone 12 Pro", 1080, 1080),
    (2022, 4, 3, 8, 30, "Google", "Pixel 6", 1150, 765),
    (2022, 7, 19, 19, 10, "Google", "Pixel 6", 780, 1140),
    (2023, 1, 7, 14, 0, "Apple", "iPhone 14 Pro", 1150, 760),
    (2023, 6, 18, 12, 30, "Apple", "iPhone 14 Pro", 1140, 780),
    (2023, 12, 31, 21, 45, "Apple", "iPhone 14 Pro", 1150, 770),
    (2024, 3, 9, 10, 10, "Apple", "iPhone 15 Pro", 760, 1150),
    (2024, 5, 25, 13, 25, "Apple", "iPhone 15 Pro", 1150, 760),
    (2024, 10, 12, 16, 5, "Apple", "iPhone 15 Pro", 1150, 765),
    (2025, 2, 14, 11, 40, "Apple", "iPhone 16 Pro", 1150, 770),
    (2025, 8, 2, 18, 20, "Apple", "iPhone 16 Pro", 770, 1150),
    (2026, 1, 10, 9, 15, "Apple", "iPhone 17 Pro", 1150, 760),
    (2026, 3, 28, 12, 50, "Apple", "iPhone 17 Pro", 1145, 770),
    (2026, 6, 6, 20, 30, "Apple", "iPhone 17 Pro", 1150, 775),
]

HUE_BASES = [210, 265, 330, 20, 45, 160, 190, 285]


def hsl_image(w, h, hue, sat=0.55):
    """Vertical pastel gradient."""
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        t = y / max(1, h - 1)
        # hue drifts slightly top→bottom
        hh = (hue + 24 * t) % 360
        r, g, b = hue_to_rgb(hh, sat * (0.55 + 0.45 * (1 - t)), 0.16 + 0.5 * (1 - t))
        row = (int(r * 255), int(g * 255), int(b * 255))
        for x in range(w):
            px[x, y] = row
    return im


def hue_to_rgb(h, s, l):
    c = (1 - abs(2 * l - 1)) * s
    hp = h / 60
    x = c * (1 - abs(hp % 2 - 1))
    r, g, b = (c, x, 0) if hp < 1 else (x, c, 0) if hp < 2 else (0, c, x) if hp < 3 else (
        0, x, c) if hp < 4 else (x, 0, c) if hp < 5 else (c, 0, x)
    m = l - c / 2
    return r + m, g + m, b + m


def decorate(im, rng, hue):
    w, h = im.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(rng.randint(4, 8)):
        r = rng.randint(h // 6, h // 2)
        x, y = rng.randint(-r, w + r), rng.randint(-r, h + r)
        alt = (hue + rng.randint(60, 180)) % 360
        rr, gg, bb = hue_to_rgb(alt, 0.6, 0.6)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(int(rr * 255), int(gg * 255), int(bb * 255), rng.randint(60, 130)))
    # a soft light streak
    for _ in range(2):
        x1, y1 = rng.randint(0, w), rng.randint(0, h)
        x2, y2 = x1 + rng.randint(-w, w), y1 + rng.randint(-h, h)
        d.line([x1, y1, x2, y2], fill=(255, 255, 255, 40), width=rng.randint(6, 22))
    layer = layer.filter(ImageFilter.GaussianBlur(h // 14))
    im = Image.alpha_composite(im.convert("RGBA"), layer).convert("RGB")
    return im


def unix_ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


def main():
    manifest = []
    rng = random.Random(7)

    for i, (yy, mm, dd, hh, mi, make, model, w, h) in enumerate(SPECS):
        hue = HUE_BASES[i % len(HUE_BASES)]
        im = hsl_image(w, h, hue, sat=0.5)
        im = decorate(im, rng, hue)

        dt_str = f"{yy:04d}:{mm:02d}:{dd:02d} {hh:02d}:{mi:02d}:00"
        ex = Image.Exif()
        ex[271] = make          # Make
        ex[272] = model         # Model
        ex[306] = dt_str        # DateTime
        sub = ex.get_ifd(0x8769)
        sub[36867] = dt_str     # DateTimeOriginal (Exif sub-IFD)
        sub[36868] = dt_str     # DateTimeDigitized

        name = f"demo_{yy}_{mm:02d}_{dd:02d}_{i + 1:02d}.jpg"
        im.save(OUT / name, "JPEG", quality=82, exif=ex)
        manifest.append({
            "name": name,
            "mime": "image/jpeg",
            "lastModified": unix_ms(datetime(yy, mm, dd, hh, mi, 0)),
        })

    # two PNGs without any metadata → filesystem-date fallback
    for i, (yy, mm, dd, hh, mi) in enumerate([(2021, 5, 9, 15, 30), (2026, 4, 21, 22, 10)]):
        im = hsl_image(1000, 1000, HUE_BASES[(i + 3) % len(HUE_BASES)], sat=0.35)
        im = decorate(im, rng, HUE_BASES[(i + 3) % len(HUE_BASES)])
        name = f"demo_screenshot_{yy}_{mm:02d}.png"
        im.save(OUT / name, "PNG")
        manifest.append({
            "name": name,
            "mime": "image/png",
            "lastModified": unix_ms(datetime(yy, mm, dd, hh, mi, 0)),
        })

    # handcrafted MP4: ftyp + moov/mvhd + mdat. The Rust core reads the mvhd
    # creation_time (QuickTime epoch, seconds since 1904-01-01).
    def box(typ: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", 8 + len(payload)) + typ + payload

    ts = datetime(2023, 8, 15, 19, 5, 0)
    creation = int(ts.replace(tzinfo=timezone.utc).timestamp()) + 2_082_844_800
    mvhd_payload = (
        struct.pack(">I", 0)                       # version 0 + flags
        + struct.pack(">I", creation) * 2          # creation + modification
        + struct.pack(">I", 1000)                  # timescale
        + struct.pack(">I", 5000)                  # duration
        + struct.pack(">I", 0x10000)               # rate 1.0
        + struct.pack(">H", 0x0100)                # volume
        + b"\0" * 10                               # reserved
        + b"\0" * 36                               # matrix
        + b"\0" * 24                               # predefined
        + struct.pack(">I", 2)                     # next track id
    )
    mp4 = (
        box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isom" + b"mp41")
        + box(b"moov", box(b"mvhd", mvhd_payload))
        + box(b"mdat", b"\0" * 512)
    )
    (OUT / "demo_clip_2023.mp4").write_bytes(mp4)
    manifest.append({
        "name": "demo_clip_2023.mp4",
        "mime": "video/mp4",
        "lastModified": unix_ms(ts),
    })

    # a real HEIC from the user's archive (copied in manually) — exercises the
    # libheif decode path; included only if present on disk
    heic = OUT / "demo_iphone.heic"
    if heic.exists():
        mt = heic.stat().st_mtime
        manifest.append({
            "name": "demo_iphone.heic",
            "mime": "image/heic",
            "lastModified": int(mt * 1000),
        })

    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    total = sum(f.stat().st_size for f in OUT.iterdir())
    print(f"OK: {len(manifest)} files, {total / 1024:.0f} KB total")


if __name__ == "__main__":
    main()
