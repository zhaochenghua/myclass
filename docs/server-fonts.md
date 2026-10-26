# 服务器字体管理

管理员和普通教师登录 `/myclass/admin.html` 后，均可在“字体管理”上传字体、搜索已安装字体。字体安装到转换服务所在账号，供后续所有教师的课件转换使用，不提供教师删除共享字体的入口。

上传课件后，如果 PPTX/DOCX 引用了服务器尚未安装的字体，“字体管理”顶部会列出缺少的字体、受影响的课件数量和名称，并在标签页上显示“缺 N 种”。上传对应字体后，系统会自动重新生成这些课件，无需教师重新上传课件。

## 安装要求

- Linux 服务器安装 `fontconfig`，确保 `fc-list`、`fc-scan`、`fc-cache` 可执行。
- 上传支持 TTF、OTF、TTC，单个文件不超过 64MB；页面支持选择多个文件逐个安装并显示各自结果。
- 字体存放在 `${XDG_DATA_HOME:-$HOME/.local/share}/fonts/myclass-uploaded/`，不进入 Git，也不对外提供下载。文件名采用内容 SHA-256，原文件名不作为路径。
- 上传先校验字体签名并通过 `fc-scan` 解析，再安装和刷新字体缓存。内容重复不会新增文件；缓存刷新失败时回滚新文件并返回错误。
- 非 Linux 环境显示暂不支持安装；缺少 fontconfig 时显示安装依赖错误。

只上传有权在服务器使用的字体。系统中的思源黑体、思源宋体、霞鹜文楷等公开授权字体由运维安装；方正及其他专有字体应使用具有相应授权的文件。不同字体名称不自动互相替代。

## 缺少字体提示

- 新上传的 `.pptx` 会读取主题（`theme*.xml`）、幻灯片、版式、母版中的 `typeface` 属性；`.docx` 还会读取 `w:rFonts` 的 `ascii/hAnsi/eastAsia/cs` 以及 `fontTable.xml` 的 `w:font w:name`。
- 字体名称与 `fc-list` 的字体系列（含逗号分隔的本地化别名、`@` 开头的竖排变体）按大小写、全半角和连续空白归一化后比较。主题占位符（如 `+mn-lt`）不算字体。
- `.ppt`、`.doc` 是二进制 OLE 格式，当前不解析其中的字体名称，因此不会产生缺少字体提示；可先另存为 `.pptx`/`.docx` 后重新上传。
- 普通教师只看到自己可见课件（含共享课件）的提示；管理员看到全部课件。安装字体是服务器级操作，所以重新生成会处理所有教师受影响的课件。
- 旧课件没有字体记录时，打开字体页会分批补扫（默认每次 10 个，可用 `FONT_SCAN_LIMIT` 调整，设为 0 关闭）。补扫按“当前已安装字体”计算；如果字体是在旧课件转换之后、首次补扫之前安装的，该课件不会被自动重排，必要时重新上传原课件即可。

## 课件生效范围

安装字体会更新 Office 转换缓存版本，相同 PPT/PPTX/DOC/DOCX 再次上传时生成新预览，不会命中补字体前的旧缓存。

字体页在批量上传完成后自动调用 `POST /api/fonts/regenerate`：

- 只重新生成“记录了缺少字体、且其中至少一种字体现已安装”的课件。服务器从内容池中的原始 Office 文件重新转换到新的缓存对象，保持课件 ID、公开 URL、播放进度和手写笔记不变，替换 `<id>.pdf` 后删除不再被引用的旧对象。
- 单次请求默认最多处理 10 个课件（`FONT_REGENERATE_LIMIT`），页面会自动继续请求剩余部分。转换失败会记录在课件记录中，自动流程不重复尝试，教师可点“重新生成待更新课件”显式重试（`?force=1`）。
- 转换使用与上传相同的 LibreOffice/动画展开流程，耗时取决于课件大小和动画数量；动画展开超时等配置沿用现有环境变量。

`GET /api/fonts` 在原有字体列表之外返回 `missingFonts`（字体、受影响课件数与示例标题）、`missingCourseware`、`pendingRegeneration`，以及尚未检查字体的旧课件数量 `scanPending`。这些字段在非 Linux 或缺少 fontconfig 时为空，页面不会显示误导性的缺少字体提示。

## 验证

```sh
cd server
node --test fontStore.test.js fontHttp.test.js documentFonts.test.js missingFonts.test.js fontRegeneration.test.js coursewareStore.test.js
```

部署后使用普通教师账号上传公开授权字体，核对安装结果、字体搜索、重复上传提示和缺少字体面板；再上传使用该字体的 PPTX，确认面板出现提示，上传字体后课件自动重新生成，并用 `pdffonts` 核对实际嵌入字体。

浏览器回归（需 Playwright，默认使用 Edge）：

```sh
node scripts/test-admin-fonts.cjs
node scripts/test-admin-font-missing.cjs
```

## 部署

更新 `server/` 与 `web/admin.html`、`web/admin.js`、`web/admin.css` 后重启 Node 服务并刷新后台页面。课件索引、班级数据和已安装字体无需迁移；首次打开字体页会补扫旧课件的字体信息。
