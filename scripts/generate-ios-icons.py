#!/usr/bin/env python3
"""生成 iPhone 网页版（web/ios）所需的 PWA 图标。

依赖 Pillow：pip install pillow
用法：python3 scripts/generate-ios-icons.py
"""

import os
from PIL import Image, ImageDraw, ImageFilter

BASE = 1024
BG_TOP = (12, 22, 27)
BG_BOTTOM = (6, 15, 18)
ACCENT = (101, 240, 200)
PANEL = (16, 38, 44)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, '..', 'web', 'ios', 'icons')


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def draw_background(draw, size, radius_ratio=0.0):
    """垂直渐变背景（可选圆角，圆角外为透明）"""
    for y in range(size):
        color = lerp(BG_TOP, BG_BOTTOM, y / max(1, size - 1))
        draw.line([(0, y), (size, y)], fill=color)


def safe_radius(radius, width, height):
    """PIL 在圆角接近短边一半时会越界，这里留出 1px 余量"""
    return max(1, min(int(radius), int(min(width, height) / 2) - 1))


def draw_glyph(draw, size, scale=1.0, center=0.5):
    """投屏图标：一块大屏 + 向上的箭头"""
    w = size
    s = w * scale
    cx = w * center
    cy = w * 0.5
    line = max(2, int(w * 0.045 * scale))

    # 大屏外框
    screen_w = s * 0.60
    screen_h = s * 0.34
    left = cx - screen_w / 2
    top = cy - s * 0.30
    right = left + screen_w
    bottom = top + screen_h
    corner = int(s * 0.05)
    draw.rounded_rectangle(
        [left, top, right, bottom],
        radius=safe_radius(corner, screen_w, screen_h),
        fill=PANEL,
        outline=ACCENT,
        width=line,
    )

    # 屏幕内的"画面"：远山折线
    inset = s * 0.07
    draw.line(
        [
            (left + inset, bottom - inset - s * 0.02),
            (left + screen_w * 0.38, top + inset + s * 0.10),
            (left + screen_w * 0.58, bottom - inset - s * 0.02),
            (right - inset, top + inset + s * 0.04),
        ],
        fill=ACCENT,
        width=max(2, int(line * 0.8)),
        joint='curve',
    )

    # 向上的箭头（投屏方向）
    arrow_top = bottom + s * 0.06
    arrow_bottom = arrow_top + s * 0.17
    arrow_half = s * 0.085
    draw.polygon(
        [
            (cx, arrow_top),
            (cx - arrow_half, arrow_top + s * 0.11),
            (cx + arrow_half, arrow_top + s * 0.11),
        ],
        fill=ACCENT,
    )
    stem_w = s * 0.07
    stem_h = arrow_bottom - (arrow_top + s * 0.09)
    draw.rounded_rectangle(
        [cx - s * 0.035, arrow_top + s * 0.09, cx + s * 0.035, arrow_bottom],
        radius=safe_radius(s * 0.02, stem_w, stem_h),
        fill=ACCENT,
    )

    # 底部手机横条
    bar_w = s * 0.32
    bar_h = s * 0.06
    draw.rounded_rectangle(
        [cx - s * 0.16, arrow_bottom + s * 0.04, cx + s * 0.16, arrow_bottom + s * 0.10],
        radius=safe_radius(s * 0.03, bar_w, bar_h),
        fill=ACCENT,
    )


def make_icon(size, maskable=False):
    scale = BASE // max(size, 1) if size < BASE else 1
    canvas = BASE
    image = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if maskable:
        draw_background(draw, canvas)
        draw_glyph(draw, canvas, scale=0.68)
    else:
        # 圆角背景（iOS 会再加遮罩，Android/manifest 用这个版本）
        radius = int(canvas * 0.22)
        mask = Image.new('L', (canvas, canvas), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, canvas, canvas], radius=radius, fill=255)
        bg = Image.new('RGBA', (canvas, canvas))
        draw_background(ImageDraw.Draw(bg), canvas)
        image.paste(bg, (0, 0), mask)
        draw = ImageDraw.Draw(image)
        draw_glyph(draw, canvas, scale=0.72)

    if size < canvas:
        image = image.resize((size, size), Image.LANCZOS)
    return image


def make_svg():
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c161b"/>
      <stop offset="1" stop-color="#060f12"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="225" ry="225" fill="url(#bg)"/>
  <g stroke="#65f0c8" fill="none" stroke-width="34" stroke-linejoin="round" stroke-linecap="round">
    <rect x="230" y="195" width="564" height="320" rx="32" fill="#10262c"/>
    <polyline points="278,470 423,300 520,455 745,320" stroke-width="26"/>
  </g>
  <g fill="#65f0c8">
    <polygon points="512,555 425,668 599,668"/>
    <rect x="477" y="640" width="70" height="130" rx="24"/>
    <rect x="357" y="800" width="310" height="58" rx="29"/>
  </g>
</svg>
'''


def main():
    out_dir = os.path.abspath(OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)

    targets = [
        ('icon-180.png', 180, False),
        ('icon-192.png', 192, False),
        ('icon-512.png', 512, False),
        ('icon-512-maskable.png', 512, True),
    ]

    for name, size, maskable in targets:
        icon = make_icon(size, maskable)
        path = os.path.join(out_dir, name)
        icon.save(path, 'PNG', optimize=True)
        print(f'生成 {path} ({size}x{size})')

    svg_path = os.path.join(out_dir, 'icon.svg')
    with open(svg_path, 'w', encoding='utf-8') as handle:
        handle.write(make_svg())
    print(f'生成 {svg_path}')


if __name__ == '__main__':
    main()
