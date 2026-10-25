"""Draws FalconOath's home-screen icons into falconoath/app/icons/.

    python tools/make_icons.py        (needs Pillow; run again only to change the icon)

A shield (the "oath") with a bold F, on a dark navy tile. Android needs PNGs:
192 and 512, "any" (rounded tile) and "maskable" (full bleed, the shield
inside the middle 80% safe zone) listed separately in the manifest. Also a
32 px favicon and an SVG for the app's header.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "falconoath" / "app" / "icons"
NAVY, BLUE, WHITE, RED = (14, 26, 46), (43, 107, 224), (255, 255, 255), (214, 40, 57)
SS = 4    # supersampling for smooth edges


def shield(d: ImageDraw.ImageDraw, cx: float, cy: float, w: float, fill, outline=None, width=0):
    h = w * 1.18
    top, side = cy - h / 2, w / 2
    pts = [(cx - side, top), (cx + side, top), (cx + side, top + h * 0.48),
           (cx, top + h), (cx - side, top + h * 0.48)]
    # a softer bottom: approximate the curve with extra points
    curve = []
    for i in range(13):
        t = i / 12
        x = (cx + side) * (1 - t) + cx * t
        y = (top + h * 0.48) * (1 - t) ** 2 + 2 * (1 - t) * t * (top + h * 0.82) + t * t * (top + h)
        curve.append((x, y))
    left = [(2 * cx - x, y) for x, y in reversed(curve)]
    poly = [pts[0], pts[1]] + curve + left
    d.polygon(poly, fill=fill, outline=outline, width=width)


def draw(size: int, maskable: bool) -> Image.Image:
    S = size * SS
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:
        d.rectangle([0, 0, S, S], fill=NAVY)
        scale = 0.56
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=NAVY)
        scale = 0.66
    w = S * scale * 0.85
    cx, cy = S / 2, S / 2
    shield(d, cx, cy, w, fill=BLUE)
    shield(d, cx, cy, w * 0.84, fill=None, outline=WHITE, width=max(2, int(S * 0.014)))
    try:
        font = ImageFont.truetype("arialbd.ttf", int(w * 0.72))
    except OSError:
        font = ImageFont.load_default()
    d.text((cx, cy - w * 0.04), "F", fill=WHITE, font=font, anchor="mm")
    # the red stripe under the F: a nod to the XR badge
    bw, bh = w * 0.34, max(2, S * 0.022)
    d.rectangle([cx - bw / 2, cy + w * 0.29, cx + bw / 2, cy + w * 0.29 + bh], fill=RED)
    return im.resize((size, size), Image.LANCZOS)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<path d="M14 8h36v19c0 13-9 22-18 29C23 49 14 40 14 27z" fill="#2b6be0"/>
<path d="M18 12h28v15c0 10-7 17-14 23-7-6-14-13-14-23z" fill="none" stroke="#fff" stroke-width="2"/>
<path d="M26 18h14v5h-9v4h8v5h-8v9h-5z" fill="#fff"/>
<rect x="25" y="44" width="14" height="2.4" fill="#d62839"/>
</svg>
"""

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for n in (192, 512):
        draw(n, False).save(OUT / f"icon-{n}.png", optimize=True)
        draw(n, True).save(OUT / f"maskable-{n}.png", optimize=True)
    draw(64, False).resize((32, 32), Image.LANCZOS).save(OUT / "favicon.png", optimize=True)
    (OUT / "logo.svg").write_text(SVG, encoding="utf-8")
    print("icons written to", OUT)
