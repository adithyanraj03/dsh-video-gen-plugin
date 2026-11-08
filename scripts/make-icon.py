"""Render the plugin icon deterministically (no network, no image service).

Run with the bundled Python, then pass the result through ``make_icon`` so the
rounded-square mask and the 256 KiB cap match what dsh renders:

    python scripts/make-icon.py
    make_icon(source=assets/icon-source.png, output=assets/icon.png, fit=False)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersample factor; downsample at the end for clean edges
W = SIZE * SS

NAVY = (12, 15, 32)
INDIGO = (58, 66, 158)
TEAL = (18, 134, 124)
BOARD = (245, 247, 252, 255)
BAND = (223, 230, 244, 255)
INK = (16, 19, 38, 255)


def gradient() -> Image.Image:
    """Diagonal indigo-to-teal wash over a dark base, with a soft top-left glow."""
    yy, xx = np.mgrid[0:W, 0:W]
    t = np.clip((xx / W) * 0.6 + (yy / W) * 0.4, 0.0, 1.0)[..., None]
    start = np.array(INDIGO, dtype=np.float64)[None, None, :]
    end = np.array(TEAL, dtype=np.float64)[None, None, :]
    wash = start * (1.0 - t) + end * t
    glow = np.clip(1.0 - np.hypot(xx - W * 0.32, yy - W * 0.28) / (W * 0.62), 0.0, 1.0)[..., None]
    rgb = np.array(NAVY, dtype=np.float64)[None, None, :] * 0.55 + wash * (0.30 + 0.55 * glow)
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), mode="RGB").convert("RGBA")


def build() -> Image.Image:
    image = gradient()
    s = SS
    left, right = 232 * s, 792 * s
    top, bottom = 296 * s, 566 * s

    # Soft halo behind the board so the silhouette survives at 36 px.
    halo = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(halo).rounded_rectangle(
        (left - 26 * s, top - 26 * s, right + 26 * s, bottom + 26 * s),
        radius=70 * s, fill=(186, 216, 255, 60),
    )
    image = Image.alpha_composite(image, halo.filter(ImageFilter.GaussianBlur(26 * s)))

    draw = ImageDraw.Draw(image)
    # Board body, then the hinge band on its top edge.
    draw.rounded_rectangle((left, top, right, bottom), radius=40 * s, fill=BOARD)
    draw.rounded_rectangle((left, top, right, top + 74 * s), radius=36 * s, fill=BAND)
    draw.rectangle((left, top + 34 * s, right, top + 74 * s), fill=BAND)
    draw.rectangle((left, top + 34 * s, left + 40 * s, top + 74 * s), fill=BOARD)
    draw.rectangle((right - 40 * s, top + 34 * s, right, top + 74 * s), fill=BOARD)

    # Diagonal slashes on the hinge: the clapperboard tell.
    x = left + 26 * s
    while x < right - 20 * s:
        draw.polygon(
            [(x, top + 74 * s), (x + 34 * s, top), (x + 62 * s, top), (x + 28 * s, top + 74 * s)],
            fill=INK,
        )
        x += 98 * s

    # Play triangle in the board's lower half.
    cx, cy = 512 * s, 462 * s
    draw.polygon(
        [(cx - 52 * s, cy - 66 * s), (cx - 52 * s, cy + 66 * s), (cx + 74 * s, cy)],
        fill=INK,
    )

    # Timeline strip: three frames of shrinking weight.
    y0, y1 = 636 * s, 660 * s
    for box, alpha in (((300, 470), 150), ((494, 650), 110), ((674, 764), 70)):
        draw.rounded_rectangle(
            (box[0] * s, y0, box[1] * s, y1),
            radius=12 * s, fill=(255, 255, 255, alpha),
        )

    return image.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "assets" / "icon-source.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    image = build()
    image.save(out, "PNG")
    print(f"wrote {out} ({out.stat().st_size} bytes, {image.width}x{image.height})")


if __name__ == "__main__":
    main()
