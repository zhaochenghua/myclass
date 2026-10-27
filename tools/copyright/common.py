# -*- coding: utf-8 -*-
"""Shared python-docx helpers for the software copyright documents."""

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BODY_FONT = "宋体"
HEAD_FONT = "黑体"
CODE_FONT = "Consolas"


def set_run_font(run, size=12, font=BODY_FONT, bold=False, color=None, italic=False):
    run.font.name = font
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.append(rFonts)
    rFonts.set(qn("w:eastAsia"), BODY_FONT if font == CODE_FONT else font)
    rFonts.set(qn("w:ascii"), font)
    rFonts.set(qn("w:hAnsi"), font)
    rFonts.set(qn("w:cs"), font)


def fmt_paragraph(p, align=None, first_indent=0, left=0, right=0,
                  before=0, after=0, line=None, keep_next=False, keep_lines=False):
    pf = p.paragraph_format
    if align is not None:
        pf.alignment = align
    pf.first_line_indent = Pt(first_indent)
    pf.left_indent = Pt(left)
    pf.right_indent = Pt(right)
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    if line is not None:
        pf.line_spacing = Pt(line)
        pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    pf.keep_with_next = keep_next
    pf.keep_together = keep_lines
    pf.widow_control = False


def add_text(doc, text="", size=12, bold=False, font=BODY_FONT, align=WD_ALIGN_PARAGRAPH.JUSTIFY,
             indent=True, before=0, after=0, line=17.5, color=None, keep_next=False, style=None):
    p = doc.add_paragraph(style=style)
    fmt_paragraph(p, align=align, first_indent=(size * 2 if indent else 0),
                  before=before, after=after, line=line, keep_next=keep_next)
    run = p.add_run(text)
    set_run_font(run, size=size, font=font, bold=bold, color=color)
    return p


def add_heading(doc, text, level=1):
    sizes = {1: 16, 2: 14, 3: 12}
    before = {1: 14, 2: 10, 3: 8}[level]
    after = {1: 8, 2: 6, 3: 4}[level]
    p = doc.add_paragraph(style=f"Heading {level}")
    fmt_paragraph(p, align=WD_ALIGN_PARAGRAPH.LEFT, before=before, after=after,
                  line=28 if level == 1 else 24, keep_next=True, keep_lines=True)
    run = p.add_run(text)
    set_run_font(run, size=sizes[level], font=HEAD_FONT, bold=True, color="000000")
    return p


def add_bullet(doc, text, size=12, line=17.5, level=0):
    p = doc.add_paragraph()
    fmt_paragraph(p, align=WD_ALIGN_PARAGRAPH.JUSTIFY, left=24 + 24 * level, first_indent=-12,
                  line=line)
    run = p.add_run("· " if level == 0 else "– ")
    set_run_font(run, size=size, font=BODY_FONT)
    run2 = p.add_run(text)
    set_run_font(run2, size=size, font=BODY_FONT)
    return p


def add_numbered(doc, number, text, size=12, line=20):
    p = doc.add_paragraph()
    fmt_paragraph(p, align=WD_ALIGN_PARAGRAPH.JUSTIFY, left=36, first_indent=-18, line=line)
    run = p.add_run(f"{number}. ")
    set_run_font(run, size=size, font=BODY_FONT)
    run2 = p.add_run(text)
    set_run_font(run2, size=size, font=BODY_FONT)
    return p


def shade_cell(cell, color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color)
    tcPr.append(shd)


def set_cell_margins(table, top=40, bottom=40, left=80, right=80):
    tblPr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for name, value in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        node = OxmlElement(f"w:{name}")
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")
        mar.append(node)
    tblPr.append(mar)


def set_repeat_header(row):
    trPr = row._tr.get_or_add_trPr()
    tblHeader = OxmlElement("w:tblHeader")
    tblHeader.set(qn("w:val"), "true")
    trPr.append(tblHeader)


def add_table(doc, headers, rows, widths=None, size=10.5, header_fill="E8EEF7",
              line=16, align_center=False, first_col_bold=False):
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_cell_margins(table)
    hdr = table.rows[0]
    set_repeat_header(hdr)
    for i, text in enumerate(headers):
        cell = hdr.cells[i]
        shade_cell(cell, header_fill)
        cell.text = ""
        p = cell.paragraphs[0]
        fmt_paragraph(p, align=WD_ALIGN_PARAGRAPH.CENTER, line=line)
        run = p.add_run(text)
        set_run_font(run, size=size, font=HEAD_FONT, bold=True)
    for row_data in rows:
        row = table.add_row()
        trPr = row._tr.get_or_add_trPr()
        cant = OxmlElement("w:cantSplit")
        cant.set(qn("w:val"), "true")
        trPr.append(cant)
        for i, text in enumerate(row_data):
            cell = row.cells[i]
            cell.text = ""
            p = cell.paragraphs[0]
            fmt_paragraph(p, align=(WD_ALIGN_PARAGRAPH.CENTER if align_center else WD_ALIGN_PARAGRAPH.LEFT),
                          line=line)
            run = p.add_run(str(text))
            set_run_font(run, size=size, font=BODY_FONT,
                         bold=(first_col_bold and i == 0))
    if widths:
        table.autofit = False
        tblPr = table._tbl.tblPr
        tblW = OxmlElement("w:tblW")
        tblW.set(qn("w:w"), str(int(sum(widths) * 567)))
        tblW.set(qn("w:type"), "dxa")
        tblPr.append(tblW)
        layout = OxmlElement("w:tblLayout")
        layout.set(qn("w:type"), "fixed")
        tblPr.append(layout)
        for i, width in enumerate(widths):
            table.columns[i].width = Cm(width)
        for row in table.rows:
            for i, width in enumerate(widths):
                row.cells[i].width = Cm(width)
    # small space after table
    p = doc.add_paragraph()
    fmt_paragraph(p, line=6, after=0, before=0)
    return table


def add_field(paragraph, instr, placeholder="1", size=10.5, font=BODY_FONT, bold=False):
    run = paragraph.add_run()
    set_run_font(run, size=size, font=font, bold=bold)
    r = run._r
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = f" {instr} "
    fld_sep = OxmlElement("w:fldChar")
    fld_sep.set(qn("w:fldCharType"), "separate")
    text_el = OxmlElement("w:t")
    text_el.text = placeholder
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    r.append(fld_begin)
    r.append(instr_el)
    r.append(fld_sep)
    r.append(text_el)
    r.append(fld_end)
    return run


def add_toc(doc, levels="1-2"):
    p = doc.add_paragraph()
    fmt_paragraph(p, line=22)
    add_field(p, f'TOC \\o "{levels}" \\h \\z \\u', placeholder="右键“更新域”生成目录", size=12)
    return p


def set_update_fields(doc):
    settings = doc.settings.element
    update = settings.find(qn("w:updateFields"))
    if update is None:
        update = OxmlElement("w:updateFields")
        settings.append(update)
    update.set(qn("w:val"), "true")


def add_page_border(paragraph, color="808080", sz="6"):
    pPr = paragraph._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), sz)
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), color)
    pBdr.append(bottom)
    pPr.append(pBdr)


def setup_section(doc, top=2.2, bottom=2.0, left=2.1, right=2.1,
                  header_text=None, header_size=9, page_number=True):
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(top)
    section.bottom_margin = Cm(bottom)
    section.left_margin = Cm(left)
    section.right_margin = Cm(right)
    section.header_distance = Cm(1.1)
    section.footer_distance = Cm(1.0)
    if header_text:
        header = section.header
        header.is_linked_to_previous = False
        p = header.paragraphs[0]
        fmt_paragraph(p, line=14, before=0, after=0)
        usable = 21.0 - left - right
        p.paragraph_format.tab_stops.add_tab_stop(Cm(usable), WD_TAB_ALIGNMENT.RIGHT)
        run = p.add_run(header_text)
        set_run_font(run, size=header_size, font=BODY_FONT)
        if page_number:
            run2 = p.add_run("\t第 ")
            set_run_font(run2, size=header_size, font=BODY_FONT)
            add_field(p, "PAGE", "1", size=header_size)
            run3 = p.add_run(" 页 / 共 ")
            set_run_font(run3, size=header_size, font=BODY_FONT)
            add_field(p, "NUMPAGES", "60", size=header_size)
            run4 = p.add_run(" 页")
            set_run_font(run4, size=header_size, font=BODY_FONT)
        add_page_border(p)
    return section


def new_document(header_text=None, margins=(2.2, 2.0, 2.1, 2.1)):
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = BODY_FONT
    style.font.size = Pt(12)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    style.paragraph_format.space_before = Pt(0)
    style.paragraph_format.space_after = Pt(0)
    setup_section(doc, top=margins[0], bottom=margins[1], left=margins[2], right=margins[3],
                  header_text=header_text)
    return doc


