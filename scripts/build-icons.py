#!/usr/bin/env python3
"""Builds the MTG Enhance icon set into public/.

    python3 scripts/build-icons.py     (needs Pillow)

Kept as a script rather than committing only the binaries so the mark can be
adjusted later without redrawing it by hand.

Optically sized: five bars read well at 32px and up, but at 16px they smear
into a blob, so the small sizes drop to three thicker bars. The .ico is
assembled by hand because Pillow derives every size from a single image and
can't vary the artwork per size.
"""
import struct
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"

BG = (16, 20, 15)      # --bg
GOLD = (227, 167, 59)  # --accent
DIM = (122, 95, 40)    # --accent-dim

FIVE = ([0.34, 0.62, 1.00, 0.62, 0.34], [DIM, GOLD, GOLD, GOLD, DIM], 0.085, 0.20)
THREE = ([0.52, 1.00, 0.52], [GOLD, GOLD, GOLD], 0.30, 0.24)


def draw(size, rounded=True):
    heights, colors, gap_ratio, pad_ratio = THREE if size <= 24 else FIVE
    scale = 8  # supersample, then downscale, for clean edges at small sizes
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)
    else:
        # iOS masks its own corners and composites alpha onto black, so the
        # touch icon is a full opaque square.
        d.rectangle([0, 0, s - 1, s - 1], fill=BG)

    pad = s * pad_ratio
    inner = s - pad * 2
    gap = inner * gap_ratio
    bar_w = (inner - gap * (len(heights) - 1)) / len(heights)
    cy = s / 2
    for i, (h, color) in enumerate(zip(heights, colors)):
        x0 = pad + i * (bar_w + gap)
        bar_h = inner * h
        d.rounded_rectangle(
            [x0, cy - bar_h / 2, x0 + bar_w, cy + bar_h / 2],
            radius=bar_w / 2, fill=color,
        )
    return img.resize((size, size), Image.LANCZOS)


def write_ico(path, sizes):
    pngs = []
    for n in sizes:
        buf = BytesIO()
        draw(n).save(buf, format="PNG")
        pngs.append(buf.getvalue())
    offset = 6 + 16 * len(sizes)
    out = struct.pack("<HHH", 0, 1, len(sizes))
    for n, png in zip(sizes, pngs):
        out += struct.pack("<BBBBHHII", n % 256, n % 256, 0, 0, 1, 32, len(png), offset)
        offset += len(png)
    path.write_bytes(out + b"".join(pngs))


write_ico(OUT / "favicon.ico", [16, 32, 48, 64])
draw(180, rounded=False).convert("RGB").save(OUT / "apple-touch-icon.png")
draw(192).save(OUT / "icon-192.png")
draw(512).save(OUT / "icon-512.png")

(OUT / "favicon.svg").write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
    f'  <rect width="64" height="64" rx="14" fill="rgb{BG}"/>\n'
    f'  <rect x="12.8" y="25.0" width="6.2" height="14.0" rx="3.1" fill="rgb{DIM}"/>\n'
    f'  <rect x="21.9" y="19.2" width="6.2" height="25.6" rx="3.1" fill="rgb{GOLD}"/>\n'
    f'  <rect x="31.0" y="12.8" width="6.2" height="38.4" rx="3.1" fill="rgb{GOLD}"/>\n'
    f'  <rect x="40.1" y="19.2" width="6.2" height="25.6" rx="3.1" fill="rgb{GOLD}"/>\n'
    f'  <rect x="49.2" y="25.0" width="6.2" height="14.0" rx="3.1" fill="rgb{DIM}"/>\n'
    f'</svg>\n'
)

print("icons written to public/:", ", ".join(sorted(
    p.name for p in OUT.iterdir() if p.name.startswith(("favicon", "icon-", "apple-")))))
