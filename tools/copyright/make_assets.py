# -*- coding: utf-8 -*-
"""Generate the architecture figure used by the manual."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools/copyright/assets/architecture.png"
FONT_PATH = r"C:\Windows\Fonts\simhei.ttf"
FONT_BOLD = r"C:\Windows\Fonts\simhei.ttf"

W, H = 1800, 980
SENDER = ("#E8F1FB", "#2F6FB2")
SERVER = ("#EAF6EC", "#2E7D32")
RECEIVER = ("#FFF4E5", "#C77700")
INK = "#1F2328"
MUTED = "#5A6B7B"


def font(size):
    return ImageFont.truetype(FONT_PATH, size)


def center_text(draw, box, text, fnt, fill=INK):
    x0, y0, x1, y1 = box
    bbox = draw.multiline_textbbox((0, 0), text, font=fnt, spacing=8, align="center")
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.multiline_text(((x0 + x1 - tw) / 2, (y0 + y1 - th) / 2 - bbox[1]),
                        text, font=fnt, fill=fill, spacing=8, align="center")


def box(draw, rect, title, sub, colors, title_size=30, sub_size=22):
    draw.rounded_rectangle(rect, radius=18, fill=colors[0], outline=colors[1], width=3)
    x0, y0, x1, y1 = rect
    draw.text(((x0 + x1) / 2, y0 + 26), title, font=font(title_size), fill=INK, anchor="ma")
    draw.multiline_text(((x0 + x1) / 2, y0 + 78), sub, font=font(sub_size), fill=MUTED,
                        anchor="ma", spacing=6, align="center")


def arrow(draw, start, end, color=MUTED, width=3, dashed=False, head=14):
    import math
    x0, y0 = start
    x1, y1 = end
    if dashed:
        total = math.hypot(x1 - x0, y1 - y0)
        step = 14
        drawn = 0
        while drawn < total - head:
            t0 = drawn / total
            t1 = min((drawn + 8) / total, 1)
            draw.line([(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0),
                       (x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)], fill=color, width=width)
            drawn += step
    else:
        draw.line([(x0, y0), (x1, y1)], fill=color, width=width)
    angle = math.atan2(y1 - y0, x1 - x0)
    for sign in (-1, 1) if not dashed else (1,):
        a = angle + sign * 0.45
        draw.line([(x1, y1), (x1 - head * math.cos(a), y1 - head * math.sin(a))],
                  fill=color, width=width)


def main():
    image = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(image)

    left = [(50, 110, 500, 260), (50, 330, 500, 480), (50, 550, 500, 700)]
    box(d, left[0], "Android 手机端", "Kotlin · CameraX · WebRTC\n摄像头 / 屏幕共享", SENDER)
    box(d, left[1], "iPhone / iPad 网页版", "Safari · PWA · Canvas\n摄像头直播 / 课件", SENDER)
    box(d, left[2], "Windows 投屏端", "Electron · Chromium\n屏幕 / 窗口 / 系统声音", SENDER)

    box(d, (680, 110, 1120, 700), "Node.js 服务端",
        "连接码与房间管理\nWebSocket 信令\n教师账号 / 班级名单\n课件转换与存储\n笔迹与笔记存储",
        SERVER, title_size=34, sub_size=24)

    box(d, (1300, 150, 1750, 380), "教师网页端（教室大屏）",
        "Chrome / Edge / Safari\n视频显示 · Canvas 标注\n课件 · 黑板 · 抽学生", RECEIVER, sub_size=22)
    box(d, (1300, 440, 1750, 670), "Android TV 接收端",
        "原生 WebRTC（VP8）\n课件 · 图片 · 视频\n遥控器操作", RECEIVER, sub_size=22)

    for y in (185, 405, 625):
        arrow(d, (505, y), (672, y), dashed=False)
        d.text((588, y - 30), "信令", font=font(20), fill=MUTED, anchor="ma")

    arrow(d, (1126, 265), (1292, 265), dashed=False)
    arrow(d, (1126, 555), (1292, 555), dashed=False)
    d.text((1209, 225), "信令", font=font(20), fill=MUTED, anchor="ma")
    d.text((1209, 515), "信令", font=font(20), fill=MUTED, anchor="ma")

    # point-to-point media path
    d.rounded_rectangle((150, 790, 1650, 900), radius=16, fill="#F4F7FA", outline="#B9C6D2", width=2)
    arrow(d, (230, 845), (1570, 845), color="#2F6FB2", width=4, dashed=True)
    d.text((900, 812), "WebRTC 音视频：发送端与接收端点对点直连（不经过服务端）",
           font=font(24), fill="#2F6FB2", anchor="ma")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT)
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
