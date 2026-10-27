# -*- coding: utf-8 -*-
"""Build the software manual (说明书) docx."""

from pathlib import Path

from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.shared import Cm, Pt

import content1
import content2
import content3
from common import (BODY_FONT, HEAD_FONT, add_bullet, add_heading, add_table,
                    add_text, add_toc, fmt_paragraph, new_document,
                    set_run_font, set_update_fields)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "软著申请材料" / "03_软件说明书_MyClass教师投屏系统V1.0.docx"
ASSETS = ROOT / "tools/copyright/assets"

SOFTWARE = "MyClass教师投屏系统"
VERSION = "V1.0"
HEADER = f"{SOFTWARE} {VERSION}"

BLOCKS = content1.BLOCKS + content2.BLOCKS + content3.BLOCKS


def add_rich(p, text, size=12):
    """Add text supporting **bold** segments."""
    parts = text.split("**")
    for idx, part in enumerate(parts):
        if not part:
            continue
        run = p.add_run(part)
        set_run_font(run, size=size, font=BODY_FONT, bold=(idx % 2 == 1))


def add_body(doc, text, size=12):
    p = add_text(doc, "", size=size)
    add_rich(p, text, size=size)
    return p


def add_code(doc, text):
    lines = text.split("\n")
    for i, line in enumerate(lines):
        p = add_text(doc, "", indent=False, line=13, before=0, after=0)
        fmt_paragraph(p, left=36, line=13,
                      before=(6 if i == 0 else 0), after=(6 if i == len(lines) - 1 else 0))
        run = p.add_run(line if line else " ")
        set_run_font(run, size=9, font="Consolas")


def add_figure(doc, filename, caption, width_cm):
    p = add_text(doc, "", indent=False, align=WD_ALIGN_PARAGRAPH.CENTER,
                 before=6, after=0, line=None)
    p.paragraph_format.line_spacing = 1.0
    p.add_run().add_picture(str(ASSETS / filename), width=Cm(width_cm))
    add_text(doc, caption, size=10.5, indent=False, align=WD_ALIGN_PARAGRAPH.CENTER,
             before=4, after=8, line=16)
    return p


def build():
    doc = new_document(header_text=HEADER, margins=(2.54, 2.54, 3.0, 3.0))
    set_update_fields(doc)
    doc.core_properties.title = f"{HEADER} 软件说明书"
    doc.core_properties.author = ""
    doc.core_properties.subject = "软件著作权登记文档"

    # ---------- title block (no separate cover page) ----------
    add_text(doc, "", indent=False, line=12)
    add_text(doc, SOFTWARE, size=24, bold=True, font=HEAD_FONT, indent=False,
             align=WD_ALIGN_PARAGRAPH.CENTER, line=34)
    add_text(doc, VERSION, size=18, bold=True, font=HEAD_FONT, indent=False,
             align=WD_ALIGN_PARAGRAPH.CENTER, line=28)
    add_text(doc, "软件说明书", size=26, bold=True, font=HEAD_FONT, indent=False,
             align=WD_ALIGN_PARAGRAPH.CENTER, before=6, line=38)
    add_text(doc, "（用户操作手册）", size=14, font=HEAD_FONT, indent=False,
             align=WD_ALIGN_PARAGRAPH.CENTER, line=24)

    add_text(doc, "文档信息", size=12, bold=True, font=HEAD_FONT, indent=False, before=10, line=22)
    add_table(doc,
              ["项目", "内容"],
              [
                  ["软件全称", SOFTWARE],
                  ["软件简称", "MyClass"],
                  ["版本号", VERSION],
                  ["文档名称", "软件说明书（用户操作手册）"],
                  ["文档版本", "1.0"],
                  ["著作权人", "【待填写：著作权人姓名】"],
                  ["编制日期", "2026 年 10 月"],
              ],
              widths=[4.0, 11.0], size=10.5, line=15)

    add_text(doc, "修订记录", size=12, bold=True, font=HEAD_FONT, indent=False, before=4, line=22)
    add_table(doc,
              ["版本", "日期", "修订说明", "编制人"],
              [["1.0", "2026 年 10 月", "首次编制，覆盖 V1.0 全部功能", "【待填写】"]],
              widths=[2.0, 3.4, 7.2, 2.6], size=10, line=14)

    # ---------- table of contents ----------
    add_text(doc, "目  录", size=16, bold=True, font=HEAD_FONT, indent=False,
             align=WD_ALIGN_PARAGRAPH.CENTER, before=8, after=6, line=26)
    add_toc(doc, levels="1-2")

    number = 0
    for block in BLOCKS:
        kind = block[0]
        if kind != "n":
            number = 0
        if kind == "h1":
            add_heading(doc, block[1], 1)
        elif kind == "h2":
            add_heading(doc, block[1], 2)
        elif kind == "h3":
            add_heading(doc, block[1], 3)
        elif kind == "p":
            add_body(doc, block[1])
        elif kind == "small":
            p = add_text(doc, "", indent=False, before=2, line=17)
            add_rich(p, block[1], size=10.5)
        elif kind == "b":
            p = add_bullet(doc, "")
            add_rich(p, block[1], size=12)
        elif kind == "n":
            number += 1
            p = add_text(doc, "", indent=False, line=17.5)
            fmt_paragraph(p, left=36, line=17.5, first_indent=-18)
            run = p.add_run(f"{number}. ")
            set_run_font(run, size=12, font=BODY_FONT)
            add_rich(p, block[1])
        elif kind == "table":
            headers, rows, widths = block[1], block[2], block[3]
            scale = 15.0 / sum(widths)
            widths = [w * scale for w in widths]
            add_table(doc, headers, rows, widths=widths, size=10.5, line=16)
        elif kind == "fig":
            add_figure(doc, block[1], block[2], block[3])
        elif kind == "code":
            add_code(doc, block[1])
        elif kind == "pagebreak":
            p = doc.add_paragraph()
            fmt_paragraph(p, line=1)
            p.add_run().add_break(WD_BREAK.PAGE)
        else:
            raise ValueError(kind)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    print(f"saved {OUT}")


if __name__ == "__main__":
    build()

