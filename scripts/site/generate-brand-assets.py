#!/usr/bin/env python3
"""Generate deterministic Gemmaclaw lobster + diamond brand assets.

The vector source is hand-authored from simple geometric paths, then the raster
favicon, Apple touch, avatar, and social preview derivatives are generated with
Pillow so future workers can reproduce the exact asset set.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]
SITE_DIR = REPO / "site"
ASSET_DIR = SITE_DIR / "assets"
ASSET_DIR.mkdir(parents=True, exist_ok=True)

RED = "#ff4f40"
RED_DARK = "#b4232a"
INK = "#172033"
MUTED = "#57606a"
BLUE = "#4285f4"
BLUE_SOFT = "#dbe8fc"
BLUE_PALE = "#e8f0fe"
WHITE = "#ffffff"
BG = "#f6f8fa"
BORDER = "#d0d7de"

LOGO_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-labelledby="title desc">
  <title id="title">Gemmaclaw lobster diamond logo</title>
  <desc id="desc">A minimalist red lobster and claw silhouette inside a faceted blue diamond.</desc>
  <path d="M256 36 476 256 256 476 36 256Z" fill="{BLUE_SOFT}" stroke="{BLUE}" stroke-width="22" stroke-linejoin="round"/>
  <path d="M256 36 348 256 256 476 164 256Z" fill="{WHITE}" opacity="0.38"/>
  <path d="M36 256h440M256 36 164 256 256 476M256 36l92 220-92 220" fill="none" stroke="{BLUE}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity="0.38"/>
  <g fill="none" stroke="{RED_DARK}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
    <path d="M166 226c-48-7-82-31-96-70 39-13 80-1 107 31"/>
    <path d="M346 226c48-7 82-31 96-70-39-13-80-1-107 31"/>
    <path d="M182 258c-39 13-71 39-92 76"/>
    <path d="M330 258c39 13 71 39 92 76"/>
    <path d="M190 318c-31 9-57 28-76 55"/>
    <path d="M322 318c31 9 57 28 76 55"/>
  </g>
  <path d="M256 140c-61 0-103 45-103 111 0 77 55 126 103 158 48-32 103-81 103-158 0-66-42-111-103-111Z" fill="{RED}" stroke="{RED_DARK}" stroke-width="18" stroke-linejoin="round"/>
  <path d="M197 240h118M201 292h110M217 344h78" fill="none" stroke="{RED_DARK}" stroke-width="14" stroke-linecap="round" opacity="0.38"/>
  <g fill="{INK}"><circle cx="224" cy="199" r="10"/><circle cx="288" cy="199" r="10"/></g>
  <g fill="none" stroke="{INK}" stroke-width="12" stroke-linecap="round"><path d="M228 174 205 142"/><path d="M284 174 307 142"/></g>
</svg>
'''

FAVICON_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-labelledby="title desc">
  <title id="title">Gemmaclaw favicon</title>
  <desc id="desc">A tiny red lobster mark inside a blue diamond.</desc>
  <path d="M32 5 59 32 32 59 5 32Z" fill="{BLUE_SOFT}" stroke="{BLUE}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M32 10 44 32 32 54 20 32Z" fill="{WHITE}" opacity="0.42"/>
  <g fill="none" stroke="{RED_DARK}" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 29c-8-1-13-5-15-12 7-2 14 0 18 6"/>
    <path d="M42 29c8-1 13-5 15-12-7-2-14 0-18 6"/>
    <path d="M23 37 13 45"/>
    <path d="M41 37 51 45"/>
  </g>
  <path d="M32 18c-8 0-13 6-13 15 0 10 7 17 13 22 6-5 13-12 13-22 0-9-5-15-13-15Z" fill="{RED}" stroke="{RED_DARK}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M25 32h14M27 40h10" fill="none" stroke="{RED_DARK}" stroke-width="2.4" stroke-linecap="round" opacity="0.45"/>
  <g fill="{INK}"><circle cx="28" cy="25" r="1.5"/><circle cx="36" cy="25" r="1.5"/></g>
</svg>
'''


def font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = (
        [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        ]
        if bold
        else [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        ]
    )
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_mark(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], *, detailed: bool) -> None:
    x0, y0, x1, y1 = box
    w = x1 - x0
    h = y1 - y0

    def pt(x: float, y: float) -> tuple[float, float]:
        return (x0 + x * w, y0 + y * h)

    # Faceted Gemma-inspired diamond.
    draw.polygon([pt(0.5, 0.05), pt(0.95, 0.5), pt(0.5, 0.95), pt(0.05, 0.5)], fill=BLUE_SOFT)
    stroke = max(3, int(w * 0.052))
    draw.line([pt(0.5, 0.05), pt(0.95, 0.5), pt(0.5, 0.95), pt(0.05, 0.5), pt(0.5, 0.05)], fill=BLUE, width=stroke, joint="curve")
    facet_w = max(1, int(w * 0.018))
    draw.line([pt(0.05, 0.5), pt(0.95, 0.5)], fill=BLUE, width=facet_w)
    draw.polygon([pt(0.5, 0.10), pt(0.72, 0.5), pt(0.5, 0.90), pt(0.28, 0.5)], fill=(255, 255, 255, 100))

    # Lobster and claw silhouette.
    lw = max(3, int(w * 0.042))
    claw_lines = [
        [(0.34, 0.45), (0.18, 0.40), (0.10, 0.28)],
        [(0.18, 0.40), (0.07, 0.34)],
        [(0.66, 0.45), (0.82, 0.40), (0.90, 0.28)],
        [(0.82, 0.40), (0.93, 0.34)],
        [(0.35, 0.56), (0.16, 0.68)],
        [(0.65, 0.56), (0.84, 0.68)],
    ]
    if detailed:
        claw_lines.extend([[(0.38, 0.68), (0.22, 0.82)], [(0.62, 0.68), (0.78, 0.82)]])
    for coords in claw_lines:
        draw.line([pt(*coord) for coord in coords], fill=RED_DARK, width=lw, joint="curve")

    body = [
        pt(0.50, 0.25),
        pt(0.68, 0.33),
        pt(0.73, 0.52),
        pt(0.66, 0.72),
        pt(0.50, 0.88),
        pt(0.34, 0.72),
        pt(0.27, 0.52),
        pt(0.32, 0.33),
    ]
    draw.polygon(body, fill=RED, outline=RED_DARK)
    stripe_w = max(2, int(lw * 0.62))
    draw.line([pt(0.38, 0.48), pt(0.62, 0.48)], fill=RED_DARK, width=stripe_w)
    draw.line([pt(0.40, 0.60), pt(0.60, 0.60)], fill=RED_DARK, width=max(2, int(stripe_w * 0.84)))
    if detailed:
        draw.line([pt(0.43, 0.72), pt(0.57, 0.72)], fill=RED_DARK, width=max(2, int(stripe_w * 0.72)))
        antenna_w = max(2, int(lw * 0.46))
        draw.line([pt(0.45, 0.33), pt(0.39, 0.23)], fill=INK, width=antenna_w)
        draw.line([pt(0.55, 0.33), pt(0.61, 0.23)], fill=INK, width=antenna_w)

    er = max(1, int(w * 0.022))
    cx, cy = pt(0.44, 0.36)
    draw.ellipse([cx - er, cy - er, cx + er, cy + er], fill=INK)
    cx, cy = pt(0.56, 0.36)
    draw.ellipse([cx - er, cy - er, cx + er, cy + er], fill=INK)


def transparent_mark_png(size: int, path: Path, *, detailed: bool = False) -> None:
    scale = 4
    img = Image.new("RGBA", (size * scale, size * scale), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    pad = int(size * scale * 0.06)
    draw_mark(draw, (pad, pad, size * scale - pad, size * scale - pad), detailed=detailed)
    img.resize((size, size), Image.Resampling.LANCZOS).save(path)


def apple_touch(path: Path) -> None:
    size = 180
    scale = 4
    img = Image.new("RGBA", (size * scale, size * scale), (255, 255, 255, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * scale * 0.22)
    draw.rounded_rectangle([0, 0, size * scale - 1, size * scale - 1], radius=radius, fill=WHITE)
    pad = int(size * scale * 0.09)
    draw_mark(draw, (pad, pad, size * scale - pad, size * scale - pad), detailed=True)
    img.resize((size, size), Image.Resampling.LANCZOS).save(path)


def social(path: Path) -> None:
    img = Image.new("RGB", (1200, 630), BG)
    draw = ImageDraw.Draw(img)
    draw.polygon([(1030, 80), (1160, 210), (1030, 340), (900, 210)], fill=BLUE_PALE)
    draw.polygon([(120, 390), (250, 520), (120, 650), (-10, 520)], fill="#ffe8e5")
    draw.rounded_rectangle([56, 56, 1144, 574], radius=44, fill=WHITE, outline=BORDER, width=2)
    draw_mark(draw, (96, 135, 456, 495), detailed=True)
    draw.text((510, 178), "Gemmaclaw", font=font(88, True), fill=INK)
    draw.text((516, 294), "Gemma setup, tuned for your hardware", font=font(38), fill=MUTED)
    draw.text((516, 372), "Minimal lobster + diamond mark", font=font(26), fill=BLUE)
    img.save(path, quality=95)


def write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def main() -> None:
    write_text(ASSET_DIR / "gemmaclaw-logo.svg", LOGO_SVG)
    write_text(ASSET_DIR / "favicon.svg", FAVICON_SVG)
    write_text(SITE_DIR / "favicon.svg", FAVICON_SVG)

    transparent_mark_png(16, SITE_DIR / "favicon-16.png")
    transparent_mark_png(16, ASSET_DIR / "favicon-16x16.png")
    transparent_mark_png(32, SITE_DIR / "favicon-32.png")
    transparent_mark_png(32, ASSET_DIR / "favicon-32x32.png")
    apple_touch(SITE_DIR / "apple-touch-icon.png")
    apple_touch(ASSET_DIR / "apple-touch-icon.png")
    transparent_mark_png(512, ASSET_DIR / "gemmaclaw-logo.png", detailed=True)
    transparent_mark_png(512, ASSET_DIR / "gemmaclaw-avatar.png", detailed=True)
    transparent_mark_png(1024, ASSET_DIR / "gemmaclaw-org-logo.png", detailed=True)
    social(ASSET_DIR / "gemmaclaw-social.png")
    social(ASSET_DIR / "gemmaclaw-github-social.png")

    # ICO fallback: create one high-resolution transparent source and let Pillow
    # encode deterministic 16, 32, and 48px icon entries.
    ico_source_size = 256
    ico_source = Image.new("RGBA", (ico_source_size, ico_source_size), (255, 255, 255, 0))
    draw = ImageDraw.Draw(ico_source)
    pad = int(ico_source_size * 0.06)
    draw_mark(draw, (pad, pad, ico_source_size - pad, ico_source_size - pad), detailed=False)
    ico_source.save(SITE_DIR / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    print(f"Generated Gemmaclaw brand assets in {SITE_DIR}")


if __name__ == "__main__":
    main()
