"""Build the TIPHYS brand SVGs from the supplied raster logo.

The T mark is re-drawn as clean vector geometry (the raster's perspective grid
is re-created from measured cell boundaries). The TIPHYS wordmark uses the
smooth spline outline stored in docs/brand/wordmark-traced.svg.

Run from the repo root:
    python scripts/brand/build_logo.py
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "brand"


def fmt(value: float) -> str:
    return f"{value:.1f}".rstrip("0").rstrip(".")


def points_path(points: list[tuple[float, float]], close: bool = True) -> str:
    head = f"M {fmt(points[0][0])} {fmt(points[0][1])}"
    rest = " ".join(f"L {fmt(x)} {fmt(y)}" for x, y in points[1:])
    return f"{head} {rest}{' Z' if close else ''}"


# --------------------------------------------------------------- wordmark ---
def trace_wordmark() -> str:
    """Read the smooth vtracer outline (docs/brand/wordmark-traced.svg)."""
    traced = ROOT / "docs" / "brand" / "wordmark-traced.svg"
    if not traced.exists():
        raise SystemExit(f"missing traced wordmark: {traced}")
    source = traced.read_text(encoding="utf-8")
    paths = re.findall(r'<path d="([^"]+)"[^>]*transform="([^"]*)"', source)
    if not paths:
        raise SystemExit("wordmark-traced.svg has no paths")
    return "\n".join(f'<path d="{d}" transform="{t}"/>' for d, t in paths)


def wordmark_svg(path_data: str, color: str) -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 4 2064 270" role="img" aria-label="TIPHYS">
  <g fill="{color}">
{path_data}
  </g>
</svg>
"""


# -------------------------------------------------------------------- mark ---
# Perspective grid of the descending leg, measured from the source raster.
LEG_CLIP = (
    "M 606 203 L 790 203 Q 786 280 778 340 Q 766 420 748 470 "
    "Q 730 520 690 548 L 583 585 L 518 585 Z"
)
GRID_FRACTIONS = [0.0, 0.27, 0.54, 0.8, 1.0]
GRID_ROWS = [203, 267, 331, 395, 459, 523, 585]
# Right edge of the ribbon, sampled from the silhouette curve.
RIGHT_EDGE = [(203, 790), (280, 786), (340, 778), (420, 766), (470, 748), (520, 730), (548, 690), (585, 583)]
CELLS = [
    ["#14B4EC", "#0A5FE8", "#0A2A8C", "#BBD9F2"],
    ["#0B7DE8", "#0B4FE0", "#0B63F2", "#DCEFFF"],
    ["#06BEF5", "#1366F0", "#C9E7FF", "#F4FBFF"],
    ["#0AC8F8", "#2E8DF4", "#D8EFFF", "#FFFFFF"],
    ["#0A5CEB", "#5FB7F7", "#EAF7FF", "#F8FDFF"],
    ["#06C8FA", "#8FD4FA", "#E4F5FF", "#F4FBFF"],
]


def right_edge_x(y: float) -> float:
    for (y0, x0), (y1, x1) in zip(RIGHT_EDGE, RIGHT_EDGE[1:]):
        if y <= y1:
            t = (y - y0) / (y1 - y0)
            return x0 + (x1 - x0) * t
    return RIGHT_EDGE[-1][1]


def column_x(index: int, y: float) -> float:
    t = (y - GRID_ROWS[0]) / (GRID_ROWS[-1] - GRID_ROWS[0])
    left = 606 - 88 * t
    right = right_edge_x(y)
    return left + (right - left) * GRID_FRACTIONS[index]


def leg_cells() -> tuple[str, str]:
    fills: list[str] = []
    lines: list[str] = []
    for row in range(len(GRID_ROWS) - 1):
        y0, y1 = GRID_ROWS[row], GRID_ROWS[row + 1]
        for col in range(4):
            quad = [
                (column_x(col, y0), y0),
                (column_x(col + 1, y0), y0),
                (column_x(col + 1, y1), y1),
                (column_x(col, y1), y1),
            ]
            fills.append(
                f'      <path d="{points_path(quad)}" fill="{CELLS[row][col]}"/>'
            )
    for col in range(1, 4):
        lines.append(
            f'      <path d="M {fmt(column_x(col, GRID_ROWS[0]))} {GRID_ROWS[0]} '
            f'L {fmt(column_x(col, GRID_ROWS[-1]))} {GRID_ROWS[-1]}" '
            f'stroke="#BCE2F8" stroke-opacity=".6" stroke-width="1.6"/>'
        )
    for row in GRID_ROWS[1:-1]:
        lines.append(
            f'      <path d="M {fmt(column_x(0, row))} {row} '
            f'L {fmt(column_x(4, row))} {row}" '
            f'stroke="#BCE2F8" stroke-opacity=".6" stroke-width="1.6"/>'
        )
    return "\n".join(fills), "\n".join(lines)


def speed_lines() -> str:
    return """
    <g>
      <path d="M 285 82 L 420 66 L 420 72 L 295 90 Z" fill="url(#fade-white)"/>
      <path d="M 265 100 L 415 82 L 415 90 L 276 110 Z" fill="url(#fade-ice)"/>
      <path d="M 100 155 L 400 108 L 400 142 L 122 180 Z" fill="url(#fade-cyan)"/>
      <path d="M 85 300 L 435 235 L 435 275 L 110 325 Z" fill="url(#fade-blue)"/>
      <path d="M 90 312 L 435 262 L 435 280 L 105 330 Z" fill="#21D4FF" fill-opacity=".78"/>
      <path d="M 150 330 L 435 285 L 435 310 L 175 355 Z" fill="#0A2C8C" fill-opacity=".55"/>
      <path d="M 0 355 L 425 318 L 425 338 L 18 372 Z" fill="url(#fade-white)"/>
      <path d="M 200 458 L 435 425 L 435 445 L 220 478 Z" fill="url(#fade-blue)"/>
      <path d="M 350 510 L 490 495 L 490 512 L 365 527 Z" fill="url(#fade-deep)"/>
      <path d="M 330 558 L 490 545 L 490 557 L 340 570 Z" fill="#0A2C8C" fill-opacity=".85"/>
    </g>"""


def chips() -> str:
    quads = [
        ((240, 190), (282, 183), (282, 220), (240, 228), "#16C8F8"),
        ((330, 228), (375, 220), (375, 255), (330, 263), "#0B4FE0"),
        ((458, 200), (498, 193), (498, 228), (458, 236), "#1FCDFC"),
        ((500, 205), (535, 199), (535, 232), (500, 239), "#0A2C8C"),
        ((178, 372), (220, 364), (220, 400), (178, 408), "#12C9FF"),
        ((330, 365), (370, 358), (370, 395), (330, 402), "#0A4DE0"),
        ((392, 365), (432, 358), (432, 395), (392, 402), "#23C6F4"),
        ((435, 372), (475, 365), (475, 402), (435, 409), "#69B8F5"),
        ((280, 490), (320, 483), (320, 518), (280, 525), "#12C9FF"),
        ((425, 440), (465, 432), (465, 470), (425, 478), "#0A4DE0"),
    ]
    return "\n".join(
        f'      <path d="{points_path(list(pts))}" fill="{color}"/>'
        for *pts, color in quads
    )


def mark_svg(icon: bool = False, badge: bool = False) -> str:
    fills, grid = leg_cells()
    if icon:
        view_box = "0 0 512 512"
        transform = "translate(-190 62) scale(0.622)" if badge else "translate(-234 43) scale(0.684)"
        bg = """
  <rect width="512" height="512" rx="116" fill="url(#badge-bg)"/>
  <rect x="1.5" y="1.5" width="509" height="509" rx="115" fill="none" stroke="#FFFFFF" stroke-opacity=".09"/>
  <ellipse cx="316" cy="250" rx="196" ry="158" fill="url(#badge-glow)"/>""" if badge else ""
        body = f"""{bg}
  <g transform="{transform}">
    <path d="M 395 40 L 1038 24 L 910 182 L 836 150 L 395 150 Z" fill="url(#bar-white)"/>
    <path d="M 395 150 L 836 150 L 814 203 L 395 203 Z" fill="url(#bar-blue)"/>
    <path d="M 735 150 L 836 150 L 814 203 L 660 203 Z" fill="url(#fold-navy)"/>
    <g clip-path="url(#leg-clip)">
      <path d="{LEG_CLIP}" fill="url(#leg-base)"/>
      <g opacity=".55">
        <path d="M 515 337 L 814 337" stroke="#F4FDFF" stroke-width="3"/>
        <path d="M 515 470 L 814 470" stroke="#F4FDFF" stroke-width="3"/>
        <path d="M 590 203 L 558 600" stroke="#F4FDFF" stroke-width="3"/>
        <path d="M 740 203 L 645 600" stroke="#F4FDFF" stroke-width="3"/>
      </g>
    </g>
    <path d="{LEG_CLIP}" fill="none" stroke="#F4FDFF" stroke-opacity=".55" stroke-width="2.5"/>
  </g>"""
    else:
        view_box = "0 0 1070 610"
        transform = ""
        bg = ""
        body = f"""
  <g>
    {speed_lines()}
    <g>
{chips()}
    </g>
    <path d="M 395 40 L 1038 24 L 910 182 L 836 150 L 395 150 Z" fill="url(#bar-white)"/>
    <path d="M 395 150 L 836 150 L 814 203 L 395 203 Z" fill="url(#bar-blue)"/>
    <path d="M 735 150 L 836 150 L 814 203 L 660 203 Z" fill="url(#fold-navy)"/>
    <path d="M 790 150 L 836 150 L 814 203 L 770 203 Z" fill="#8BD8FF" fill-opacity=".8"/>
    <g clip-path="url(#leg-clip)">
      <path d="{LEG_CLIP}" fill="url(#leg-base)"/>
{fills}
{grid}
    </g>
    <path d="{LEG_CLIP}" fill="none" stroke="#F4FDFF" stroke-opacity=".5" stroke-width="1.6"/>
  </g>"""

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" role="img" aria-label="TIPHYS">
  <defs>
    <linearGradient id="bar-white" x1="395" y1="0" x2="1038" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset=".62" stop-color="#F6F9FE"/>
      <stop offset="1" stop-color="#C9D8EC"/>
    </linearGradient>
    <linearGradient id="bar-blue" x1="395" y1="0" x2="836" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#16D2FF"/>
      <stop offset=".42" stop-color="#0A9BFE"/>
      <stop offset="1" stop-color="#0B4FE0"/>
    </linearGradient>
    <linearGradient id="badge-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0A0F1C"/>
      <stop offset=".58" stop-color="#081A36"/>
      <stop offset="1" stop-color="#0B2A55"/>
    </linearGradient>
    <radialGradient id="badge-glow" cx="0" cy="0" r="1" gradientTransform="translate(316 250) rotate(90) scale(158 196)" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0A6BFF" stop-opacity=".38"/>
      <stop offset="1" stop-color="#0A6BFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fold-navy" x1="660" y1="150" x2="836" y2="203" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0A2A8C"/>
      <stop offset="1" stop-color="#06123D"/>
    </linearGradient>
    <linearGradient id="leg-base" x1="515" y1="203" x2="814" y2="600" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0A6BFF"/>
      <stop offset=".5" stop-color="#14B8F0"/>
      <stop offset="1" stop-color="#06C8FA"/>
    </linearGradient>
    <linearGradient id="fade-white" x1="0" y1="0" x2="425" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset=".55" stop-color="#FFFFFF" stop-opacity=".55"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity=".95"/>
    </linearGradient>
    <linearGradient id="fade-ice" x1="0" y1="0" x2="415" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#BFE2FF" stop-opacity="0"/>
      <stop offset="1" stop-color="#E8F6FF" stop-opacity=".95"/>
    </linearGradient>
    <linearGradient id="fade-cyan" x1="100" y1="0" x2="400" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#12C9FF" stop-opacity="0"/>
      <stop offset=".5" stop-color="#12C9FF" stop-opacity=".65"/>
      <stop offset="1" stop-color="#0A8BFF" stop-opacity="1"/>
    </linearGradient>
    <linearGradient id="fade-blue" x1="85" y1="0" x2="435" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0A6BFF" stop-opacity="0"/>
      <stop offset=".45" stop-color="#0B8DFF" stop-opacity=".8"/>
      <stop offset="1" stop-color="#0A5FE8" stop-opacity="1"/>
    </linearGradient>
    <linearGradient id="fade-deep" x1="350" y1="0" x2="490" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0A2C8C" stop-opacity="0"/>
      <stop offset="1" stop-color="#0A2C8C" stop-opacity="1"/>
    </linearGradient>
    <clipPath id="leg-clip"><path d="{LEG_CLIP}"/></clipPath>
  </defs>{body}
</svg>
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    word = trace_wordmark()
    (OUT / "logo-wordmark.svg").write_text(wordmark_svg(word, "#0B1220"), encoding="utf-8")
    (OUT / "logo-wordmark-white.svg").write_text(wordmark_svg(word, "#FFFFFF"), encoding="utf-8")
    (OUT / "logo-mark.svg").write_text(mark_svg(icon=False), encoding="utf-8")
    (OUT / "logo-icon.svg").write_text(mark_svg(icon=True), encoding="utf-8")
    (OUT / "logo-badge.svg").write_text(mark_svg(icon=True, badge=True), encoding="utf-8")
    print("wrote", ", ".join(p.name for p in sorted(OUT.glob("*.svg"))))


if __name__ == "__main__":
    main()
