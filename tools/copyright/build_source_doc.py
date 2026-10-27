# -*- coding: utf-8 -*-
"""Build the 60-page source-code sample (30 leading + 30 trailing pages).

Rules implemented:
  * A4 portrait, 50 source lines per page, page break after every 50 lines.
  * Header carries the full software name + version on the left and the page
    number on the right (name/version must match the application form).
  * Every logical source line is hard-wrapped to <= 100 display columns so the
    rendered page really contains 50 lines instead of relying on Word wrapping.
"""

import unicodedata
from pathlib import Path

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt

from common import (CODE_FONT, add_page_border, new_document, set_run_font,
                    set_update_fields)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "软著申请材料" / "02_源程序_MyClass教师投屏系统V1.0.docx"

SOFTWARE_NAME = "MyClass教师投屏系统"
VERSION = "V1.0"
HEADER_TEXT = f"{SOFTWARE_NAME} {VERSION}"
PAGES = 60
LINES_PER_PAGE = 50
TOTAL_LINES = PAGES * LINES_PER_PAGE
MAX_UNITS = 100
FONT_SIZE = 8
LINE_HEIGHT = 12.2

FRONT_FILE = ROOT / "android/AndroidStudioProject/app/src/main/java/cn/edu/nb3/myclass/MainActivity.kt"
BACK_FILE = ROOT / "web/app.js"


def display_units(text: str) -> int:
    units = 0
    for ch in text:
        units += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return units


def wrap_line(line: str, limit: int = MAX_UNITS):
    line = line.expandtabs(4).rstrip()
    if not line:
        return [""]
    if display_units(line) <= limit:
        return [line]
    indent = len(line) - len(line.lstrip(" "))
    continuation = " " * min(indent + 4, 40)
    pieces = []
    rest = line
    first = True
    while rest:
        width = 0
        cut = len(rest)
        last_space = -1
        for idx, ch in enumerate(rest):
            w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
            if width + w > limit:
                cut = idx
                break
            width += w
            if ch in " ,;)]}":
                last_space = idx + 1
        else:
            cut = len(rest)
        if cut <= 0:
            cut = 1
        if cut < len(rest) and last_space > limit // 2:
            cut = last_space
        piece = rest[:cut].rstrip()
        pieces.append((continuation if not first else "") + piece)
        rest = rest[cut:].lstrip()
        first = False
    return pieces


def wrapped_lines(path: Path):
    raw = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    out = []
    for line in raw:
        out.extend(wrap_line(line))
    return out


def take_front(path: Path, count: int, label: str):
    lines = wrapped_lines(path)
    body = lines[: count - 1]
    return [f"// 源文件：{label}"] + body


def take_back(path: Path, count: int, label: str):
    lines = wrapped_lines(path)
    body = lines[-(count - 1):]
    return [f"// 源文件：{label}（文件末尾节选）"] + body


def build():
    front = take_front(FRONT_FILE, TOTAL_LINES // 2,
                       "android/AndroidStudioProject/app/src/main/java/cn/edu/nb3/myclass/MainActivity.kt")
    back = take_back(BACK_FILE, TOTAL_LINES // 2, "web/app.js")
    lines = front + back
    assert len(lines) == TOTAL_LINES, len(lines)

    doc = new_document(header_text=HEADER_TEXT, margins=(2.0, 1.8, 2.0, 2.0))
    set_update_fields(doc)
    doc.core_properties.title = f"{HEADER_TEXT} 源程序"
    doc.core_properties.author = ""

    body = doc  # paragraphs go straight into the document body
    first = body.add_paragraph()
    for index, line in enumerate(lines):
        if index % LINES_PER_PAGE == 0:
            p = body.add_paragraph() if index else first
            p.paragraph_format.page_break_before = index != 0
        else:
            p = body.add_paragraph()
        pf = p.paragraph_format
        pf.alignment = WD_ALIGN_PARAGRAPH.LEFT
        pf.space_before = 0
        pf.space_after = 0
        pf.line_spacing = Pt(LINE_HEIGHT)
        pf.widow_control = False
        pf.keep_together = False
        pf.keep_with_next = False
        run = p.add_run(line if line else " ")
        set_run_font(run, size=FONT_SIZE, font=CODE_FONT)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    print(f"saved {OUT} ({len(lines)} lines, {PAGES} pages)")


if __name__ == "__main__":
    build()
