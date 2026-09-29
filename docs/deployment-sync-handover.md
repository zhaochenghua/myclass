# MyClass 三方同步交接文档

> 维护对象：**本地开发机** ↔ **gitee 仓库** ↔ **生产服务器**
> 最后更新：2026-09-29（对应 `main` = `2812201`）
> 适用读者：接手本项目的开发者 / 运维人员

本文只讲"如何让三方始终一致"。功能说明、部署细节、常见问题见根目录 `README.md`。

---

## 1. 三方拓扑

| 角色 | 位置 | 说明 |
|---|---|---|
| 本地开发机 | `c:\Users\zch\Documents\code\myclass`（Windows / PowerShell） | 唯一写代码的地方 |
| **权威远端** `origin` | `https://gitee.com/nbzch/myclass.git` | 唯一真源，main 分支在此 |
| 生产服务器 | `zch@192.168.50.241` | **只读部署目标**，禁止在其上提交代码 |
| 归档远端 `github` | `https://github.com/zhaochenghua/myclass.git` | 历史备份，长期滞后，非必需 |

服务器上的一切都在这一个目录里：

```text
APP_DIR=/opt/1panel/apps/openresty/openresty/www/sites/10.30.13.1/index/myclass
```

- Node 服务：`node server/server.js`，监听 `0.0.0.0:3000`
- 反向代理：OpenResty 站点 `10.30.13.1` → `proxy/myclass.conf`，把 `/myclass/` 转发到 `http://192.168.50.241:3000/myclass/`（已含 WebSocket 头、`client_max_body_size 2100m`、`proxy_read_timeout/send_timeout 300s`）
- 访问入口：教室用 `http://10.30.13.1/myclass/`；443 上另有一套 TLS 给 iPhone 网页版
- 自启动：`zch` 的 crontab `@reboot …/myclass/scripts/start-server.sh`（脚本检测 3000 端口已被占用就跳过，防重复启动）
- 日志：`/home/zch/myclass-server.log`
- Node 版本：`v22.19.0`
- 目录体积：应用 1.7G（含课件与安装包），其中 `.git` 约 165M

---

## 2. 环境与凭据（先读这一节）

### 2.1 git 身份（已统一，勿再改）

```text
zhaochenghua <37543439+zhaochenghua@users.noreply.github.com>
```

本机 `~/.gitconfig` 与服务器 `~/.gitconfig` 均已设置。**提交前若发现 author 是 `Your Name <you@example.com>`，说明身份被重置了，先修身份再提交。**

### 2.2 代理矩阵（最容易踩的坑）

| 目标 | 规则 | 位置 |
|---|---|---|
| 任意 https（默认） | `http://192.168.50.86:7890` | 仓库 `.git/config` 的 `http.proxy` / `https.proxy` |
| gitee | **空值 = 直连**（上面的局域网代理访问 gitee 会失败） | `~/.gitconfig` → `[http "https://gitee.com"] proxy =` |
| github | `socks5://127.0.0.1:7890`（本机代理软件，**默认未启动**） | `~/.gitconfig` → `[http "https://github.com"] proxy` |

结论：**gitee 随时可用；github 只有在本地代理软件运行起来时才可用**，否则会 `Failed to connect to github.com port 443`（21 秒超时）。需要临时直连 github 时：

```powershell
git -c http.proxy= -c https.proxy= -c "http.https://github.com.proxy=" push github main
```

（本机到 github 443 直连也不通，通常仍需代理。）

### 2.3 凭据保管原则

- 服务器登录密码 **不写入仓库**，由运维人员线下保管。
- 服务器的 `origin` URL 内嵌了 gitee 访问令牌：`https://oauth2:<token>@gitee.com/...`。**不要执行会打印该 URL 的命令**（如 `git remote -v` 后直接截图/贴群），也不要在服务器上执行 `git remote set-url` 覆盖它。
- 令牌文件 `gitee令牌*`、`github令牌*.txt`、`.env*` 均在 `.gitignore` 内，**永远不要 `git add -f` 它们**。

### 2.4 SSH 免密（已配置）

本机 `~/.ssh/id_ed25519`（注释 `nbzch@126.com`，指纹 `SHA256:TpN7yKaXp14WA95VvtMgWV56ZmT00K4O+p+oGAp+NV8`）已写入服务器 `zch@192.168.50.241` 的 `~/.ssh/authorized_keys`，与原有的 `zch@mysever` 并存，目录权限 `700`、文件权限 `600`。

因此第 4、5、7 节里的 `ssh zch@192.168.50.241 ...` 命令**都不再需要输入密码**，可整段粘贴执行。

换机器或换密钥时，用下面两条命令重新授权并验证（密码由运维人员线下提供）：

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh zch@192.168.50.241 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
ssh -o BatchMode=yes zch@192.168.50.241 "echo KEY_AUTH_OK"
```

> 服务器目前**仍允许密码登录**（`PasswordAuthentication` 未关闭）。若以后要关闭它来加固，务必先用上面第二条命令确认密钥登录可用，避免把自己锁在门外。

### 2.5 编辑器 / 工具目录

`.codebuddy/`、`AGENTS.md`、`.vscode/`、`.claude/` 均在 `.gitignore` 内，属于本地数据，**不要删除 `.codebuddy/`**（里面存着 Android 自测流程等技能文件）。

---

## 3. 什么算"三方统一"

三条同时成立才算：

1. 本地 `main` 与 `origin/main` 完全一致（`git status -sb` 不显示 `ahead/behind`）
2. 服务器 `HEAD` == `origin/main`，且服务器 `git status --porcelain` 为空
3. 三处工作区都不含未提交改动

```powershell
# 本地
cd c:\Users\zch\Documents\code\myclass
git fetch origin --prune
git rev-list --left-right --count main...origin/main   # 期望输出：0	0
git status -sb                                          # 期望：## main...origin/main
```

```bash
# 服务器
cd /opt/1panel/apps/openresty/openresty/www/sites/10.30.13.1/index/myclass
git fetch origin --prune
git status -sb && git status --porcelain && git rev-parse HEAD
```

> **注意"引用一致"与"内容一致"的区别**：服务器曾出现 `HEAD` 指向旧提交、但工作区内容与新版本完全相同的情况（因为中间提交只改了 iOS 静态文件）。这种情况下服务是正常的，但规范仍要求把引用也对齐，避免下次判断失真。

---

## 4. 日常改动 SOP（六步，照做即可）

```powershell
cd c:\Users\zch\Documents\code\myclass

# 0. 先对齐本地，避免在有分叉的状态下动手
git fetch origin --prune
git status -sb
git pull --ff-only                 # 非快进会直接失败，这是有意的保护

# 1. 改代码并自测
cd server; node --test; cd ..      # 服务端测试：37 个用例，期望 36 通过 / 1 跳过 / 0 失败
# Android 改动必须在模拟器上自测：见 .codebuddy/skills/android-emulator-test/SKILL.md
# Windows 客户端：cd windows; npm run check

# 2. 提交
git add -A
git commit -m "type(scope): 说明"   # 提交前确认身份是 zhaochenghua

# 3. 推送 gitee（唯一真源）
git push origin main

# 4. 服务器同步（只允许快进）
ssh zch@192.168.50.241 "cd /opt/1panel/apps/openresty/openresty/www/sites/10.30.13.1/index/myclass && git pull --ff-only && git log --oneline -1"

# 5. 需要重启时再重启（判定见第 5 节）

# 6. 验证服务
curl.exe -s http://10.30.13.1/myclass/api/config
```

**服务器只读部署**：服务器上只执行 `git pull --ff-only`，**永远不要**在服务器上 `git commit` / `git push`。历史上正是因为有人在服务器上直接提交并推送，才导致本地 `main` 落后 3 个提交、author 变成 `Your Name <you@example.com>`。

---

## 5. 改完要不要重启服务

| 改动位置 | 是否重启 | 原因 |
|---|---|---|
| `server/*.js`（含 `server.js`、`coursewareStore.js`、`expandAnimations.js`） | **必须重启** | Node 进程已把旧代码加载进内存 |
| `web/**`（含 `web/ios/**`） | 不需要 | 静态文件由 OpenResty/Express 按请求读盘 |
| `windows/**`（源码） | 不需要 | 只有重新构建安装包才影响客户端 |
| `server/data/versions.json` | 不需要 | 服务端按 mtime 缓存，改完即生效 |
| `android/**` | 不需要 | 需重新出 APK 并单独部署 |

重启步骤（**务必按端口定位进程**）：

```bash
# 1) 确认监听 3000 的就是本项目
ss -ltnp | grep ':3000'

# 2) 停止（按端口取 PID）
kill "$(ss -ltnp | grep ':3000' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"

# 3) 启动（脚本自带端口占用检测与日志）
bash /opt/1panel/apps/openresty/openresty/www/sites/10.30.13.1/index/myclass/scripts/start-server.sh

# 4) 确认
ss -ltnp | grep ':3000'; tail -5 /home/zch/myclass-server.log
```

> ⚠ **不要**用 `pkill -f "node server/server.js"`。这台服务器上还有其它项目存在同名进程（root 用户在 Sep 3 启动过 `node server/server.js`），会误杀别人的服务。

---

## 6. 版本号与安装包

### 6.1 三个版本字段

`server/data/versions.json`：

```json
{
  "appVersion": "1.8.3-2026092101",
  "windowsVersion": "0.1.23",
  "iosVersion": "1.4.1-2026092001"
}
```

- `appVersion`：Android APK 版本，由构建脚本自动写入
- `windowsVersion`：Windows 安装包版本，**手工维护**，替换安装包时同步修改
- `iosVersion`：iPhone 网页版缓存刷新参数与二维码参数

改这个文件即时生效，**不要**为了改版本号去重启服务，也**不要**在 `server.js` 里硬编码默认版本。

### 6.2 Android 版本递增（每次构建必做）

构建前递增 `android/AndroidStudioProject/app/build.gradle.kts`：

- `versionCode`：`YYYYMMDDNN`（当天第 NN 次构建）
- `versionName`：`X.Y.Z-YYYYMMDDNN`（日期段与 versionCode 相同）

当前版本：`1.8.3-2026092101` / `versionCode 2026092101`。

`build_apk.bat` 成功后，`android/AndroidStudioProject/update-apk-version.js` 会自动把 `versionName` 写入 `versions.json` 的 `appVersion`（勿手工改 `server.js`）。

### 6.3 安装包不入库（重要）

`.gitignore` 已排除 `web/public/*.exe`、`*.apk`、`*.msi`、`*.dmg`、`*.ipa` 与 `web/public/courseware/`。安装包与课件是**独立部署产物**，只存在于本地与服务器的 `web/public/`，不进 git。

部署方式（不重启服务）：

```powershell
# Android：构建产物复制为分发文件名
Copy-Item android\AndroidStudioProject\app\build\outputs\apk\release\app-release.apk web\public\myclass.apk -Force
# Windows：electron-builder 输出到 windows\dist\MyClass-Setup-<version>.exe
Copy-Item windows\dist\MyClass-Setup-*.exe web\public\myclass-windows.exe -Force
```

然后同步 `versions.json` 中对应版本字段，并把这两个文件传到服务器的同名路径。

下载地址（服务端按 Range 支持断点续传）：

```text
http://10.30.13.1/myclass/myclass.apk
http://10.30.13.1/myclass/myclass-windows.exe
```

> 现状记录：80.9MB 的 `myclass-windows.exe` 历史上曾被提交进 git，如今只残留在一个已删除的旧分支的对象里（见第 10 节）。**今后任何安装包都不要再入库。**

---

## 7. 一致性自检清单

本机到服务器的 SSH 免密已配置（见 2.4），因此下面这段可以整段粘贴运行，自动输出三方同步状态与服务健康码，**无需任何交互输入**。

```powershell
$APP_DIR = '/opt/1panel/apps/openresty/openresty/www/sites/10.30.13.1/index/myclass'
cd c:\Users\zch\Documents\code\myclass
git fetch origin --prune

"本地     : " + (git rev-parse --short main) + " / 与远端差异 " + (git rev-list --left-right --count main...origin/main)
"远端     : " + (git ls-remote origin refs/heads/main).Split("`t")[0].Substring(0,7)

$remote = ssh zch@192.168.50.241 "cd $APP_DIR && echo `$(git rev-parse --short HEAD) && git status --porcelain && git status -sb"
"服务器   : " + ($remote -join ' | ')

"服务     : " + (curl.exe -s -o NUL -w '%{http_code}' http://10.30.13.1/myclass/api/config)
```

期望：本地 / 远端 / 服务器三行是**同一个短 SHA**，服务器无任何输出行（工作区干净），服务返回 `200`。

---

## 8. 已知陷阱（务必先读）

1. **不要在服务器上提交代码**（第 4 节）。这是三方不一致的头号成因。
2. **不要在服务器上执行 `git clean -fdx`**：会删掉课件目录、安装包、`server/data/` 下的用户数据（这些都是 ignored 的部署产物）。
3. **不要 `git reset --hard` 了事**：若 `git status` 非空，先 `git stash` 或人工比对，确认没有课件/配置改动被顺手丢弃。
4. **行尾假差异**：仓库使用 `.gitattributes`（`* text=auto eol=lf`）。没有这个文件的克隆里，Windows 工作区会把几十个文件显示成"已修改"却 diff 为空。看到这种情况先确认 `.gitattributes` 是否存在。
5. **代理**：gitee 必须直连（`~/.gitconfig` 里已置空代理）；github 需要本地代理软件运行。见 2.2。
6. **分叉判定**：`git pull` 报非快进时，先用 `git merge-base` 判断是否还有共同祖先。本项目曾出现一条与 `main` **完全没有共同祖先**的旧历史线（见第 10 节），一旦遇到，**不要**强行 merge，先沟通确认。
7. **令牌文件不入库**：见 2.3。
8. **`.codebuddy/` 不能删**：它承载 Android 模拟器自测流程等技能文件。
9. **Android 改动必须模拟器自测**：`.codebuddy/skills/android-emulator-test/SKILL.md`；纪律是禁止 `clean` 全量构建、禁止猜坐标、禁止用 `>` 重定向截图。

---

## 9. 故障处置与恢复

### 9.1 服务器 `git pull` 报非快进

```bash
cd /opt/1panel/apps/openresty/openresty/www/sites/10.30.13.1/index/myclass
git status -sb
git log --oneline -3            # 看是否存在服务器上的本地提交
```

- 若是服务器本地提交：**先把它导出**（`git format-patch`）带回本地评估，再在本地决定是否合入；然后服务器 `git reset --hard origin/main`（先确认工作区无课件/数据改动）。
- 若是本地/远端分叉：回到本地解决，服务器保持不动。

### 9.2 代码回滚

```powershell
git revert <commit>          # 推荐：保留历史
git push origin main
# 服务器
ssh zch@192.168.50.241 "cd $APP_DIR && git pull --ff-only"
# 若改的是 server/*.js，记得按第 5 节重启
```

### 9.3 分支/历史丢失的恢复

- **从 bundle 恢复**（离线、不依赖网络）：

```powershell
git fetch "C:\Users\zch\Documents\code\myclass-backup\codex-windows-single-app-20260929.bundle" `
  codex/windows-single-app:refs/heads/codex/windows-single-app
```

- **从 github 取回**（需本地代理可用）：`git fetch github <分支名>`
- **从 gitee 取回已删除的分支**：只要 gitee 尚未 GC，可用已知 SHA 重新建引用：
  `git push origin <SHA>:refs/heads/<分支名>`

### 9.4 数据备份（与代码同步同等重要）

课件目录（含 `index.json` 与隐藏的 `.objects`）+ `server/data/` 是**不可再生数据**，备份时用保留硬链接的方式（`rsync -aH`），建议停服后备份或使用文件系统快照。详见 `README.md` 的"课件存储与备份"。

---

## 10. 本次交接快照（2026-09-29）

| 项目 | 状态 |
|---|---|
| 交接当时的 `main` | `2812201`（合并提交，**内容与 `a2415d7` 完全一致**，`git diff` 为空） |
| 为什么不再写当前 SHA | 每次提交都会推进 `main`，写死会立刻过期。**判断是否同步请用第 3、7 节的自检命令**，本表只记录不会随时间变化的事实 |
| 本地 / gitee / 服务器 | 交接当时三处同为 `2812201`，工作区干净 |
| 本文件引入的提交 | `8cf4a04 docs: add three-way sync handover guide`（初版；之后对本文档的修订各自追加提交） |
| 服务器运行进程 | PID 1072390，启动于 09-21 22:32；因 `server.js` 自那次启动后未变更，**无需重启** |
| 服务器 git 身份 | 已由 `Your Name <you@example.com>` 修正为 `zhaochenghua` |
| SSH 免密 | 已配置：本机 `id_ed25519`（`nbzch@126.com`）→ 服务器 `authorized_keys`，`BatchMode` 校验通过 |
| `github/main` | 仍停在 `c82eac0`（落后，代理不通未同步） |
| 已合并并删除的分支 | `codex/ppt-appear-disappear`（内容等价于 main，历史已并入 main） |
| 已归档并删除的分支 | `codex/windows-single-app`（`14975b9`，146 个提交，与 main **无共同祖先**的旧历史线；已导出 bundle 备份后删除本地与 gitee 引用） |
| 离线备份 | `C:\Users\zch\Documents\code\myclass-backup\codex-windows-single-app-20260929.bundle`（155.5MB，`git bundle verify` 通过） |
| github 上的旧分支 | 仍保留 `codex/windows-single-app`，那条旧历史的又一份副本 |

### 遗留事项（未处理，需人工决策）

1. `441d2d7`、`5ec2b94`、`f0fba24` 三个提交的 author 仍是 `Your Name <you@example.com>`。改写需重写已公开历史 + 服务器 `reset --hard`，收益仅为显示层面，**当前决定：不动**。
2. `github` remote 落后；待本地代理可用时执行 `git push github main`（本次因代理未运行失败）。
3. 备份 bundle 是仓库外的独立文件，确认 github 上的副本可用后可自行删除。
4. gitee 上那个 80.9MB 的历史对象，引用已不可达，但**空间释放取决于 gitee 自身 GC**，短期内克隆体积可能不变。
5. 服务器仍开放密码登录（免密是"新增公钥"，不是"取代密码"）。若要加固，见 2.4 的注意事项。

---

## 11. 相关文档

| 文档 | 内容 |
|---|---|
| `README.md` | 功能说明、服务端部署、iOS 与 Android 构建、常见问题 |
| `docs/ppt-animation-expansion.md` | PPT 动画展开（LibreOffice）的原理、边界与部署要求 |
| `windows/README.md` | Windows 客户端构建（`npm run dist` → `windows/dist/`） |
| `AGENTS.md` | Agent 协作规则入口（Android 改动必须模拟器自测） |
| `.codebuddy/skills/android-emulator-test/SKILL.md` | Android 模拟器自测完整流程 |
| `.codebuddy/skills/myclass-dev/SKILL.md` | 本项目开发技能（构建、服务端、WebRTC/PDF.js） |
