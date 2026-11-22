"""Rasterize the Tarmac logo to PNG (the window icon needs a bitmap on Linux).

Geometry mirrors apps/desktop/assets/tarmac.svg (viewBox 64); keep both in sync.
The window icon is 128 px: X servers without BIG-REQUESTS (e.g. xrdp) cap a request at
65535 words, so a 256 px _NET_WM_ICON (65538 words) is silently dropped. Verified
2026-11-16: 128 set, 256/512 empty. GNOME Shell's dock does not use this property at all;
it needs the desktop entry from scripts/desktop-entry.mjs.
An output ending in .ico is the Windows exe icon: rendered at SIZE (use 256) and stored at the
sizes Explorer, the taskbar and Task Manager pick from.
Usage: python3 scripts/render-icon.py [size] [output]
  python3 scripts/render-icon.py 256 apps/desktop/assets/tarmac.ico
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 128
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "apps/desktop/assets/tarmac.png"
SCALE = 4  # supersample, then downscale for anti-aliasing


def main() -> None:
    k = SIZE * SCALE / 64
    image = Image.new("RGBA", (SIZE * SCALE,) * 2, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    p = lambda v: v * k  # noqa: E731 - viewBox units to pixels

    # Tile: 62x62 at (1,1), radius 14, 2-unit border centered on the edge (outer 0..64, inner 2..62).
    draw.rounded_rectangle([p(0), p(0), p(64), p(64)], radius=p(15), fill="#292f35")
    draw.rounded_rectangle([p(2), p(2), p(62), p(62)], radius=p(13), fill="#121417")
    # Lanes.
    for x, y, w, color in ((11, 18, 16, "#f0a54a"), (11, 29.5, 11, "#5fd787"), (11, 41, 14, "#ff7474")):
        draw.rounded_rectangle([p(x), p(y), p(x + w), p(y + 5)], radius=p(2.5), fill=color)
    # Chevron with round caps and join.
    points = [(p(34), p(17)), (p(49), p(32)), (p(34), p(47))]
    width = p(7)
    draw.line(points, fill="#4fd1c5", width=round(width), joint="curve")
    r = width / 2
    for x, y in points:
        draw.ellipse([x - r, y - r, x + r, y + r], fill="#4fd1c5")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    icon = image.resize((SIZE, SIZE), Image.LANCZOS)
    if OUT.suffix == ".ico":
        icon.save(OUT, sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256) if s <= SIZE])
    else:
        icon.save(OUT)
    print(f"wrote {OUT} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
