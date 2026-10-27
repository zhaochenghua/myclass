# -*- coding: utf-8 -*-
"""Build the application-form worksheet and the filing guide."""

from pathlib import Path

from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

from common import (BODY_FONT, HEAD_FONT, add_bullet, add_heading, add_table,
                    add_text, fmt_paragraph, new_document, set_run_font, set_update_fields)

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "软著申请材料"
HEADER = "MyClass教师投屏系统 V1.0"
SOFTWARE = "MyClass教师投屏系统"
VERSION = "V1.0"

FEATURE_TEXT = (
    "本软件面向中小学课堂教学场景，解决教师用手机摄像头把试卷、讲义、实验器材等实时投到教室大屏并同步讲解的问题。"
    "软件由 Android 手机端、Web 教师端、Node.js 服务端、Windows 投屏端和 Android TV 接收端组成。"
    "主要功能：4 位连接码快速配对；WebRTC 低延迟摄像头直播，支持前后摄像头切换、补光灯、双指缩放、点击对焦、画面锁定与锁定帧平移；"
    "大屏画笔标注、板擦、撤销、清空，标注按画面内容坐标绑定并随缩放平移同步；PDF、PPT、PPTX、Word 课件上传、转换、逐页渲染、动画拆页、翻页与逐屏滚动、按页保存笔迹；"
    "图片和视频展示；电子黑板；Android 屏幕共享；任教班级与学生名单管理，按姓名或学号随机抽取且一轮不重复；触屏五点校准；断线重连与课堂状态恢复。"
    "技术特点：采用 WebRTC 点对点传输，WebSocket 仅承载信令和状态同步，音视频不经过服务器；服务端基于 Node.js、Express 和 ws，课件转换调用 LibreOffice headless；"
    "前端使用原生 JavaScript、HTML5 Canvas 和 PDF.js，标注采用归一化内容坐标；Android 端使用 Kotlin、CameraX、WebRTC SDK 和 MediaProjection；"
    "支持局域网内 HTTP/HTTPS 混合访问，多端共用同一套连接码和信令协议。"
)


def rich(doc, text, size=11, indent=True, bold=False, align=WD_ALIGN_PARAGRAPH.JUSTIFY, line=18):
    p = add_text(doc, "", size=size, indent=indent, align=align, line=line)
    run = p.add_run(text)
    set_run_font(run, size=size, font=BODY_FONT, bold=bold)
    return p


def label_para(doc, text):
    p = add_text(doc, "", indent=False, before=6, after=2, line=18)
    run = p.add_run(text)
    set_run_font(run, size=11, font=HEAD_FONT, bold=True)
    return p


def build_form():
    doc = new_document(header_text=HEADER, margins=(2.4, 2.2, 2.6, 2.6))
    set_update_fields(doc)
    doc.core_properties.title = "计算机软件著作权登记申请表（填写稿）"
    doc.core_properties.author = ""

    add_text(doc, "计算机软件著作权登记申请表", size=20, bold=True, font=HEAD_FONT,
             indent=False, align=WD_ALIGN_PARAGRAPH.CENTER, line=32)
    add_text(doc, "（填写稿 / 网上填报对照）", size=12, indent=False,
             align=WD_ALIGN_PARAGRAPH.CENTER, line=22)

    p = rich(doc, "说明：正式申请请在中国版权保护中心“软件著作权登记系统”中在线填报，"
                   "本文件用于提前准备各栏内容并核对一致性。带【】的项目为待补充的个人信息，"
                   "提交前请替换为真实内容；身份证号、手机号等敏感信息请勿通过聊天工具传输。",
             size=10.5, indent=False)
    p.paragraph_format.left_indent = Pt(0)

    add_heading(doc, "一、软件基本信息", 2)
    add_table(doc,
              ["栏目", "填写内容", "备注"],
              [
                  ["软件全称", SOFTWARE, "申请表、说明书、源程序页眉必须完全一致"],
                  ["软件简称", "MyClass", "不要与全称完全相同"],
                  ["版本号", VERSION, "带“V”，全部材料保持一致"],
                  ["软件作品说明", "原创软件", "非修改他人软件"],
                  ["开发完成日期", "2026 年 10 月 24 日", "软件全部固定在载体上的日期"],
                  ["发表状态", "未发表", "如已公开下载或对外提供，应改为已发表"],
                  ["开发方式", "单独开发", "个人独立完成"],
                  ["权利取得方式", "原始取得", "独立开发，非受让、继承"],
                  ["权利范围", "全部权利", "《计算机软件保护条例》第八条全部权利"],
              ],
              widths=[3.2, 5.8, 6.8], size=10, line=15)

    add_heading(doc, "二、著作权人信息", 2)
    add_text(doc, "著作权人为自然人，证件类型为居民身份证。下列信息需与身份证完全一致。",
             size=11, line=18)
    add_table(doc,
              ["栏目", "填写内容", "备注"],
              [
                  ["姓名", "【姓名】", "与身份证一致"],
                  ["类别", "自然人", "—"],
                  ["证件类型", "居民身份证", "—"],
                  ["证件号码", "【18 位身份证号】", "提交身份证正反面扫描件"],
                  ["国籍", "中国", "—"],
                  ["省份 / 城市", "浙江省 / 宁波市", "按实际经常居住地填写"],
                  ["联系地址", "【详细通讯地址】", "用于接收纸质材料（如需）"],
                  ["邮政编码", "【邮政编码】", "—"],
                  ["手机号码", "【手机号码】", "保持畅通，便于审查员联系"],
                  ["电子邮箱", "【电子邮箱】", "用于接收受理和补正通知"],
              ],
              widths=[3.2, 5.8, 6.8], size=10, line=15)

    add_heading(doc, "三、软件开发与运行环境", 2)
    add_table(doc,
              ["栏目", "填写内容"],
              [
                  ["开发硬件环境",
                   "x86_64 计算机（4 核以上 CPU、16 GB 内存、512 GB 硬盘）；Android 手机（含前后摄像头、补光灯）；"
                   "Android 电视或电视盒子；局域网交换机与无线 AP。"],
                  ["运行硬件环境",
                   "服务器：4 核 CPU、8 GB 内存、100 GB 可用硬盘；教师电脑：1920×1080 显示；"
                   "Android 手机：Android 8.0 以上；iPhone/iPad：iOS 15 以上；"
                   "Android TV：Android 5.0 以上；Windows 客户端：Windows 10/11 64 位。"],
                  ["开发软件环境",
                   "Windows 11 64 位、Android Studio、JDK 17、Gradle 8.9、Node.js 20、Visual Studio Code、Git、Chrome/Edge。"],
                  ["运行软件环境",
                   "服务器：Windows Server 2019 或 Ubuntu 22.04、Node.js 20、LibreOffice（课件转换，可选）、"
                   "Nginx/OpenResty（反向代理，可选）；客户端：Chrome/Edge/Safari 浏览器、Windows 10/11、"
                   "Android 8.0 以上、iOS 15 以上、Android 5.0 以上。"],
                  ["编程语言", "Kotlin、Java、JavaScript、HTML、CSS、Shell"],
                  ["源程序量", "50,851 行（含各端源代码、测试与构建脚本，不含第三方库）"],
              ],
              widths=[3.6, 12.2], size=10, line=15)

    add_heading(doc, "四、软件功能和技术特点", 2)
    add_text(doc, "以下文字可直接粘贴到登记系统的“主要功能和技术特点”栏；如系统限制字数，可保留前两段。",
             size=10.5, line=17)
    p = add_text(doc, "", size=10.5, indent=False, line=17)
    p.paragraph_format.first_line_indent = Pt(21)
    run = p.add_run(FEATURE_TEXT)
    set_run_font(run, size=10.5, font=BODY_FONT)

    add_heading(doc, "五、软件鉴别材料交存方式", 2)
    add_table(doc,
              ["项目", "填写 / 提交内容"],
              [
                  ["交存方式", "一般交存"],
                  ["源程序", "前 30 页 + 后 30 页，共 60 页，每页 50 行；页眉标注软件全称、版本号和页码"],
                  ["文档", "《软件说明书（用户操作手册）》全部 30 页（不足 60 页，全部提交）"],
                  ["页眉要求", "MyClass教师投屏系统 V1.0 + 第 X 页 / 共 Y 页"],
              ],
              widths=[3.6, 12.2], size=10, line=15)

    add_heading(doc, "六、申请办理方式与代理人", 2)
    add_table(doc,
              ["栏目", "填写内容"],
              [
                  ["申请办理方式", "申请人自行办理"],
                  ["代理人", "无"],
                  ["代理权限", "不适用"],
                  ["证书领取方式", "登录中国版权保护中心用户中心下载电子证书"],
              ],
              widths=[4.2, 11.6], size=10, line=15)

    add_heading(doc, "七、申请人签章", 2)
    add_text(doc, "申请人（签字）：____________________", size=11, indent=False, before=10, line=28)
    add_text(doc, "日期：________ 年 ______ 月 ______ 日", size=11, indent=False, line=28)
    add_text(doc, "注：申请人为自然人的，应由本人手写签名或加盖人名章；签章页须使用登记系统生成的原版，"
                  "不得修改内容、格式和打印比例，签字后扫描为 PDF 上传。", size=10, indent=False, before=6, line=16)

    add_heading(doc, "八、填报前核对清单", 2)
    for item in [
        "软件全称、简称、版本号在申请表、说明书、源程序页眉中完全一致（V1.0 的“V”也要一致）。",
        "开发完成日期不晚于提交日期；未发表时不要填写首次发表日期和地点。",
        "身份证在有效期内，正反面清晰完整，证件号码与申请表一致。",
        "源程序为前 30 页和后 30 页，每页不少于 50 行，页眉有软件名称、版本号和页码。",
        "说明书为完整文档，每页不少于 30 行（插图页除外），页眉与申请表一致。",
        "主要功能和技术特点描述与本说明书内容一致，不夸大、不包含他人软件。",
        "确认软件为个人独立开发、非职务作品；如使用了学校设备或承担学校任务，应先取得学校书面确认。",
    ]:
        p = add_bullet(doc, "")
        run = p.add_run(item)
        set_run_font(run, size=10.5, font=BODY_FONT)

    doc.save(OUT_DIR / "01_软件著作权登记申请表（填写稿）.docx")
    print("saved form")


def build_guide():
    doc = new_document(header_text=HEADER, margins=(2.4, 2.2, 2.6, 2.6))
    set_update_fields(doc)
    doc.core_properties.title = "软件著作权登记办理指南与材料清单"
    doc.core_properties.author = ""

    add_text(doc, "软件著作权登记办理指南与材料清单", size=19, bold=True, font=HEAD_FONT,
             indent=False, align=WD_ALIGN_PARAGRAPH.CENTER, line=32)
    add_text(doc, SOFTWARE + " " + VERSION, size=12, indent=False,
             align=WD_ALIGN_PARAGRAPH.CENTER, line=22)

    rich(doc, "本文档说明本次软件著作权登记的申请信息、需要准备的材料、线上办理步骤和常见退回原因。"
              "所有材料应保持软件名称、版本号和著作权人信息一致。", size=11)

    add_heading(doc, "一、本次登记信息摘要", 2)
    add_table(doc,
              ["项目", "内容"],
              [
                  ["软件全称", SOFTWARE],
                  ["软件简称", "MyClass"],
                  ["版本号", VERSION],
                  ["著作权人", "【姓名】（自然人）"],
                  ["开发完成日期", "2026 年 10 月 24 日"],
                  ["发表状态", "未发表"],
                  ["开发方式", "单独开发"],
                  ["权利取得方式", "原始取得，全部权利"],
                  ["登记机构", "中国版权保护中心"],
                  ["办理方式", "申请人自行在线办理"],
              ],
              widths=[4.0, 11.8], size=10.5, line=16)

    add_heading(doc, "二、材料清单", 2)
    add_table(doc,
              ["序号", "材料", "形式与要求", "份数", "状态"],
              [
                  ["1", "软件著作权登记申请表", "登记系统在线填写，生成申请确认签章页后本人签字并扫描为 PDF", "1", "待在线生成"],
                  ["2", "源程序鉴别材料", "前 30 页 + 后 30 页，共 60 页；每页 50 行；页眉含软件名称、版本号、页码", "1", "已生成"],
                  ["3", "文档鉴别材料", "《软件说明书》全部 30 页；每页不少于 30 行（插图页除外）", "1", "已生成"],
                  ["4", "身份证明", "居民身份证正反面照片或扫描件，清晰完整、在有效期内", "1", "待准备"],
                  ["5", "代理委托书", "自行办理时不需要", "0", "不需要"],
                  ["6", "权利归属证明", "个人独立开发、非职务作品时不需要；如为委托/合作开发需提交合同", "0", "不需要"],
              ],
              widths=[1.4, 3.8, 7.6, 1.4, 1.6], size=9.5, line=14)

    add_heading(doc, "三、线上办理步骤", 2)
    steps = [
        ("注册账号", "打开中国版权保护中心登记系统 https://register.ccopyright.com.cn/，选择“注册”，"
                     "按提示完成手机号、邮箱验证，选择“自然人”身份。"),
        ("实名认证", "上传身份证正反面，完成人脸识别或人工审核。实名认证通过后才能提交软件登记申请。"),
        ("在线填报", "进入“软件登记”，按本材料《01_软件著作权登记申请表（填写稿）》逐项填写软件名称、版本号、"
                     "开发完成日期、发表状态、权利说明、开发运行环境、编程语言、源程序量和主要功能。"),
        ("生成并签署签章页", "填写完成后由系统生成“申请确认签章页”，在线打印，本人用黑色签字笔手写签名，"
                             "再扫描为 PDF。不得修改签章页内容、格式或打印比例。"),
        ("上传附件", "上传签章页 PDF、身份证正反面、源程序文档和软件说明书。文件按系统要求命名，"
                     "单个文件不要超过系统限制。"),
        ("提交并等待受理", "确认信息无误后提交。登记机构受理后进入审查，法定审查时限为受理之日起 60 日；"
                           "如需补正，按通知在期限内修改并重新提交。"),
        ("下载电子证书", "审查通过后，登录用户中心下载《计算机软件著作权登记证书》PDF，自行保存并备份。"),
    ]
    for i, (title, text) in enumerate(steps, 1):
        p = add_text(doc, "", indent=False, before=4, line=18)
        fmt_paragraph(p, left=24, first_indent=-18, line=18)
        run = p.add_run(f"{i}. {title}：")
        set_run_font(run, size=11, font=HEAD_FONT, bold=True)
        run2 = p.add_run(text)
        set_run_font(run2, size=11, font=BODY_FONT)

    add_heading(doc, "四、关键注意事项", 2)
    notes = [
        ("名称和版本必须一致", "软件全称“MyClass教师投屏系统”、版本号“V1.0”要在申请表、说明书封面与页眉、"
                               "源程序页眉中完全一致。登记证书以申请表填报为准，有无“V”也以申请表为准。"),
        ("页眉和行数", "源程序每页页眉写软件名称、版本号和页码，每页不少于 50 行；说明书每页不少于 30 行（插图页除外）。"
                       "本套材料已按 50 行/页和 30 页说明书生成，可直接使用。"),
        ("未发表的风险", "如果软件已经对外提供安装包、公开下载或在校外使用，应如实选择“已发表”并填写首次发表日期和地点。"
                         "以“未发表”申报但实际已公开，可能被认定为申请信息不实。"),
        ("职务作品风险", "如果软件是执行学校工作任务、主要利用学校物质技术条件开发，著作权可能归学校所有。"
                         "以个人名义申请前，应确认不属于职务开发；必要时由学校出具非职务开发证明或改为单位申请。"),
        ("第三方代码", "源程序中不得包含他人专有代码。本软件使用的 Electron、Chromium、WebRTC、Express、ws、PDF.js、"
                       "LibreOffice 等开源组件应按其许可证使用，说明书已作声明。"),
        ("软件名称规范", "名称应简短明确，不得含有违反法律法规或公序良俗的内容。以个人名义申请时，"
                         "不建议在软件名称中使用学校全称，以免与单位作品混淆。"),
        ("身份证明", "身份证须在有效期内，正反面完整、清晰、无遮挡；证件号码与申请表逐位一致。"),
        ("签章页", "必须使用系统生成的原版签章页，本人手写签名，不得使用电子签名图片或修改格式。"),
    ]
    for title, text in notes:
        p = add_text(doc, "", indent=False, before=3, line=18)
        fmt_paragraph(p, left=24, first_indent=-12, line=18)
        run = p.add_run("· " + title + "：")
        set_run_font(run, size=11, font=HEAD_FONT, bold=True)
        run2 = p.add_run(text)
        set_run_font(run2, size=11, font=BODY_FONT)

    add_heading(doc, "五、费用与时限", 2)
    rich(doc, "自 2017 年 4 月 1 日起，计算机软件著作权登记费已停征，通过中国版权保护中心官方渠道自行办理不收取登记费；"
              "如委托代理机构，代理服务费由双方另行约定。法定审查时限为受理之日起 60 日，实际时间受申请量、"
              "材料完整度和补正情况影响，以登记系统显示的状态为准。")
    rich(doc, "电子证书与纸质证书具有同等效力。证书下载后应备份，并在需要时通过中国版权保护中心官网的证书验签功能核验。")

    add_heading(doc, "六、提交前自检清单", 2)
    checks = [
        "申请表、说明书、源程序页眉的软件名称和版本号完全一致。",
        "源程序为前 30 页 + 后 30 页，共 60 页，每页 50 行，页码连续。",
        "说明书为完整文档（30 页），目录页码与正文一致，每页不少于 30 行。",
        "身份证正反面清晰、在有效期内，姓名和号码与申请表一致。",
        "签章页为系统原版，本人手写签名，扫描为 PDF。",
        "开发完成日期、发表状态、开发方式与实际情况一致。",
        "已确认非职务作品，或已取得学校书面确认。",
        "已备份申请表、鉴别材料和电子证书。",
    ]
    for item in checks:
        p = add_text(doc, "", indent=False, line=18)
        fmt_paragraph(p, left=24, first_indent=-12, line=18)
        run = p.add_run("□  " + item)
        set_run_font(run, size=11, font=BODY_FONT)

    add_heading(doc, "七、常见退回原因", 2)
    add_table(doc,
              ["退回原因", "处理办法"],
              [
                  ["软件名称或版本号前后不一致", "以申请表为准，统一修改说明书封面、页眉和源程序页眉后重新生成"],
                  ["源程序页数或每页行数不足", "补足前 30 页和后 30 页，每页至少 50 行，页眉加页码"],
                  ["说明书页数不足或每页行数不足", "补充功能说明和操作步骤，保证每页至少 30 行"],
                  ["签章页被修改或使用电子签名", "重新从系统打印原版签章页，本人手写签名后扫描"],
                  ["身份证模糊、过期或缺反面", "重新拍摄或扫描，确保四角完整、文字清晰"],
                  ["发表状态与实际不符", "已公开的改为“已发表”，填写首次发表日期和地点"],
                  ["权属不清（职务作品）", "补充学校非职务开发证明，或改以学校名义申请"],
              ],
              widths=[5.6, 10.2], size=10, line=15)

    doc.save(OUT_DIR / "00_软件著作权登记办理指南与材料清单.docx")
    print("saved guide")


if __name__ == "__main__":
    build_form()
    build_guide()

