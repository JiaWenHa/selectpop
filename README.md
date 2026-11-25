# SelectPop · 划词助手

选中一段文字，弹窗立刻出现在光标旁边：**复制 · 翻译 · 搜索 · 解释 · 总结 · 润色 · 语法检查**。
Windows 与 macOS 同一套代码；AI 相关动作（解释/总结/润色/语法检查，以及「AI 翻译」模式）走 DeepSeek 的 `chat/completions` 流式接口。

```
选中文字 ──► 全局鼠标钩子判定拖拽/双击
          ──► 哨兵值写入剪贴板 + 模拟 Ctrl/Cmd+C
          ──► 读回选区、恢复原剪贴板
          ──► 无边框弹窗贴在光标旁（自动翻边、夹进屏幕）
```

## 目录

- [下载使用](#下载使用)
- [功能](#功能)
- [快速开始](#快速开始)
- [接入 DeepSeek](#接入-deepseek)
- [怎么验证](#怎么验证)
  - [1. 单元测试（不需要界面）](#1-单元测试不需要界面)
  - [2. 冒烟测试（自动截图）](#2-冒烟测试自动截图)
  - [3. 手动验收清单](#3-手动验收清单)
  - [4. 打包验证](#4-打包验证)
- [平台差异与权限](#平台差异与权限)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [隐私](#隐私)

## 下载使用

面向普通用户，不需要装开发环境。GitHub Release 只发布 **Windows 绿色版**（zip）：

1. 到 [Releases](../../releases) 下载最新的 `SelectPop-x.x.x-win.zip`；
2. 解压到一个文件夹（建议路径不含中文与空格，例如 `D:\SelectPop`）；
3. 双击 `Start-SelectPop.cmd` 启动；
4. 程序进入系统托盘，在任意软件里划选文字即弹出操作窗口。

zip 里自带 `README.txt`（使用说明，中文）。要解锁「AI 翻译 / 解释 / 总结 / 润色 / 语法检查」，右键托盘图标 → 打开设置 → **AI**，填 DeepSeek API Key（见[接入 DeepSeek](#接入-deepseek)）。

> 绿色版不支持自动更新；升级时下载新 zip 解压覆盖整个文件夹，保留 `.data` 目录即可保留设置与 API Key。

## 功能

| 动作 | 类型 | 说明 |
| --- | --- | --- |
| 复制 | 本地 | 把选区写回剪贴板（原剪贴板会被恢复，所以这一步其实是「确保可用」） |
| 翻译 | 翻译 | 有 Key 走 DeepSeek；没 Key 或设置成「网页」时打开 Bing / Google / DeepL / 有道 |
| 搜索 | 外链 | 用选区在 Bing / Google / 百度 / DuckDuckGo / 自定义引擎里搜索 |
| 解释 | AI | 说明含义、背景；代码则讲用途与坑 |
| 总结 | AI | 3~6 条要点，保留关键数字与结论 |
| 润色 | AI | 保留原意与原语言，只改表述 |
| 语法检查 | AI | 检查语法、拼写与标点，逐条给出位置、原因与修改建议 |

弹窗里还有一个「更多」区：`Esc` 关闭、`Cmd/Ctrl+Enter` 复制结果、数字键 `1`~`7` 直接触发对应动作。

设置窗口（托盘 → 打开设置，或 `Cmd/Ctrl+,`）包含：通用、触发方式、弹窗外观、AI、翻译、搜索、高级、关于——共 8 个分区。

## 快速开始

需要 Node.js ≥ 22.12（本项目用 pnpm 11 安装依赖）。

```bash
pnpm install          # 安装依赖（含 Electron 与 uiohook-napi 预编译包）
pnpm icons            # 生成应用图标与托盘图标（build/、assets/ 下的 PNG）
pnpm start            # 启动
```

开发时用 `pnpm dev`（会打开控制台日志与设置窗口）。第一次启动后：

1. 托盘出现 SelectPop 图标；
2. 在任意应用里用鼠标**拖选**一段文字（或双击一个词），弹窗出现在光标旁；
3. 也可以直接按 `CommandOrControl+Shift+Space` 抓取当前选区。

> Linux 上也能跑（`xdotool` 模拟复制），但不是主要目标平台，未做验证。

### 划词是怎么取到文字的

Electron 没有「读取其他程序选中文字」的 API，所以流程是：

1. `uiohook-napi` 的全局鼠标钩子在 `mouseup` 时判断这次是不是划词（拖选距离、时长、双击）；
2. 先往剪贴板写一个唯一哨兵值 `<零宽字符>SelectPop-xxxx<零宽字符>`；
3. 向**当前前台窗口**发一次 `Ctrl+C`（macOS 是 `Cmd+C`）；
4. 轮询剪贴板：值变了说明复制成功，取文字；还是哨兵值就是没选中东西；
5. 把原剪贴板内容恢复回去（设置里可关）；
6. 用取到的文字打开弹窗。

第 3 步在 Windows 上最麻烦，踩过的坑：

| 方案 | 结果 |
| --- | --- |
| PowerShell `[System.Windows.Forms.SendKeys]::SendWait('^c')` | **假成功**：返回 OK，按键根本没送到前台窗口。
| PowerShell `Add-Type` 运行时编译 C# 调 `SendInput` | 在 Electron 派生的 PowerShell 里报「客户端没有所需的特权」，编译不出来 |
| `cscript` + `WScript.Shell.SendKeys` | 只对自己进程的窗口有效，Chrome / Edge / Word 收不到 |
| **自带 `sendcopy.exe`（当前方案）** | 直接 `user32!SendInput` 发带扫描码的 Ctrl+C，跨进程有效，单次只花几毫秒 |

`sendcopy.exe` 由 `native/win-sendcopy/SendCopy.cs` 编译而来，源码 60 行：

```bash
pnpm build:helper       # 用系统自带的 .NET Framework csc.exe 重新编译到 assets/bin/
```

它不需要 .NET 运行时之外的依赖（Win10/11 自带），打包时随 `assets/**` 一起放进 `app.asar.unpacked`。找不到它时会自动退回 cscript 方案（对 Electron 自己的窗口仍然有效）。

### Windows 双击启动（绕过 PATH 与 userData 问题）

仓库里带两个批处理，双击即可，不依赖系统 PATH：

| 文件 | 作用 |
| --- | --- |
| `run-dev.cmd` | 启动开发模式（控制台输出完整日志） |
| `run-smoke.cmd` | 跑冒烟测试，自动生成 `artifacts/*.png` 截图 |
| `run-packaged.cmd` | 启动打包版 `dist\win-unpacked\SelectPop.exe`（加 `--smoke` 可出图后自动退出） |

它们会做三件事：把内置 Node 目录前置到 `PATH`、清掉 `ELECTRON_RUN_AS_NODE`、把数据目录与 `TEMP` 都放到项目内的 `.data\` 下（该目录可写，能规避 `0xc0000142`）。数据目录不在系统默认位置时它们还会加 `--no-sandbox`；如果第一次启动仍被沙箱拒绝，脚本会自动带 `--no-sandbox` 重试一次。

## 接入 DeepSeek

1. 到 <https://platform.deepseek.com/api_keys> 申请 API Key（形如 `sk-...`）；
2. 打开设置 → **AI**，粘贴 Key，点「测试连接」（用 `GET /models` 验证，不消耗对话额度）；
3. 保存后，弹窗里的「解释 / 总结 / 润色 / 语法检查」和「翻译」的 AI 模式就能用了。

可调项：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| Base URL | `https://api.deepseek.com` | 也兼容 `.../v1`、`.../chat/completions` 等写法 |
| 模型 | `deepseek-chat` | 也可选 `deepseek-reasoner`（会显示思考过程流） |
| 温度 | 1.3 | 翻译任务用 1.3，解释 0.7，总结 0.5，润色 0.8，语法检查 0.3（由动作自动决定） |
| 最大输出 | 1200 tokens | |
| 最大输入 | 4000 字符 | 超出会截断并在提示词里注明 |
| 超时 | 60 秒 | 以「多久没收到新数据」计算，流式输出会不断重置 |
| 额外系统提示 | 空 | 例如「术语用词请贴近《XXX》的风格」 |
| AI 翻译提示词 | 空 | 在「翻译」分区里，替换默认的翻译指令；`{lang}` 是目标语言、`<selected_text>` 是原文 |

Key 用 Electron `safeStorage`（Windows DPAPI / macOS Keychain）加密后存在 `settings.json` 的 `secrets` 字段；系统加密不可用时退化为 `raw:v1:` + base64，并在日志里警告。

## 怎么验证

### 1. 单元测试（不需要界面）

```bash
pnpm test
```

覆盖 68 个用例，全部是纯逻辑：

- `src/shared/text.js`：文本清洗、码点计数、截断标注、URL 判断、哈希；
- `src/shared/urls.js`：Base URL 规范化、搜索引擎模板、网页翻译兜底（含 Deepl 语言码、有道需要剪贴板）；
- `src/shared/sse.js`：SSE 分块解析（JSON 被网络切断、`[DONE]`、非法 JSON 不崩溃）；
- `src/shared/placement.js`：弹窗定位（右下、右侧翻左、下方翻上、负坐标副屏、夹紧）；
- `src/shared/selection.js`：划词判定（拖拽/双击/太小/太远/太慢/开关关闭）与重复捕获去重；
- `src/shared/settings-schema.js`：默认值补全、非法值修正、动作排序、快捷键校验；
- `src/shared/prompts.js`：提示词、温度、目标语言、截断、用户偏好拼接；
- `src/main/capture.js`：哨兵法抓选区（成功、无选区、快捷键失败、纯符号、并发 busy、恢复剪贴板）；
- `src/main/clipboard-guard.js`：剪贴板适配层（异步 Promise API、只有 `read/write` 的 ClipboardItem 形态、老式同步富文本、按内容判定恢复、读写抛错兜底）；
- `src/main/deepseek.js`：流式拼接（含被切断的 JSON）、非流式、401/402/503 错误映射、无 Key、空响应、网络错误、外部取消、`testConnection`；
- `src/main/settings-store.js`：首次启动、加密不可用时的 Key 存取、变更事件、损坏配置回落；
- `src/main/keystroke.js`：Windows 优先用自带 `sendcopy.exe`、缺失时退回 cscript + VBS（脚本内容与 CRLF）、macOS 不写 VBS、`dispose` 可重复调用；
- `src/main/foreground.js`：用 `wininfo.exe` 解析前台/坐标处窗口（TAB 分隔输出、非数字坐标不调用、无 helper 返回 null）；
- `scripts/gen-icons.js`：PNG 结构、尺寸、透明边、模板图标必须是纯黑 + alpha。

如果只想快速自检，也可以单独跑一个文件：

```bash
node --test --test-isolation=none tests/shared.test.js
```

> `--test-isolation=none` 让测试在同一个进程里跑，不 spawn 子进程，在受限沙箱里也能通过。去掉它也可以，只是会为每个文件开一个子进程。

### 2. 验证 DeepSeek 链路（不需要界面）

弹窗里的 AI 动作和这条命令用的是同一份 `src/main/deepseek.js`，所以它通过就代表密钥、网络、SSE 流式解析、错误映射都是通的：

```powershell
pnpm check-api -- --key sk-xxxx
```

不带参数直接跑，它会先请求 `/models` 测连通，然后流式翻译一句示例英文并打印首字延迟、总耗时与 token 用量：

```
接口  https://api.deepseek.com
模型  deepseek-chat
✓ 连接正常（204ms），可用模型: deepseek-chat, deepseek-reasoner

动作  翻译（temperature 1.3）
原文  The quick brown fox jumps over the lazy dog...
---- 输出 ----
敏捷的棕色狐狸跳过了懒狗。…
---- 结束 ----
首字延迟  412ms
总耗时    1180ms，共 12 字符
用量      prompt 48 / completion 16 / total 64
✓ 链路正常，收到 12 个增量字符
```

退出码：`0` 成功、`1` 参数或密钥缺失、`2` 接口报错（Key 无效、余额不足、网络不通等，会打印对应的中文提示）。想测别的动作或语言：

```powershell
pnpm check-api -- --key sk-xxxx --action summarize --lang zh-CN --text "要总结的段落"
pnpm check-api -- --key sk-xxxx --test          # 只测连接
pnpm check-api -- --key sk-xxxx --no-stream     # 关掉流式
```

### 3. 冒烟测试（自动截图）

```bash
pnpm smoke
```

Windows 上也可以直接双击 `run-smoke.cmd`（不依赖 PATH，数据目录固定在项目内 `.data\`）。打包版同理：`run-packaged.cmd --smoke`。

它不连网络、不需要 Key，直接驱动真实窗口：

1. 用一段示例文字打开弹窗；
2. 三秒内逐字推送一段假的流式结果（模拟 DeepSeek 的 delta / done 事件）；
3. 切到深色主题再截一张；
4. 打开设置窗口截一张；
5. 控制台打印 `SMOKE_RESULT {"ok":true,...}` 并退出。

产物在 `artifacts/`：

| 文件 | 内容 |
| --- | --- |
| `popup-idle.png` | 弹窗刚出现、还没选动作的样子 |
| `popup-result.png` | 流式结果 + 底部按钮（浅色） |
| `popup-result-dark.png` | 同一界面在深色主题下 |
| `settings.png` | 设置窗口（通用分区） |

判断标准：`SMOKE_RESULT` 里 `ok` 为 `true`，弹窗与设置窗口都 `isVisible()`，四张图都不是空白。
打开图片看这几点：卡片圆角与阴影是否完整（透明窗口没对齐会出现黑边）、文字有没有被裁掉、深色主题下对比度是否够。

### 4. 手动验收清单

冒烟测试只能证明「渲染层能显示」，下面这些必须在你自己的桌面上点一遍（它们依赖真实的鼠标钩子与前台窗口）：

**触发**

- [ ] 在浏览器/记事本里拖选一段中文，抬键后弹窗出现在光标右下方；
- [ ] 拖选英文/代码，弹窗同样出现，预览里保留换行与缩进；
- [ ] 双击一个单词就弹出（设置里关掉「双击选词」后不再弹出）；
- [ ] 在空白处拖动、拖窗口、拖滚动条、拖文件时**不**弹出（避免误发 Ctrl+C）；
- [ ] 关掉托盘菜单里的「划词已启用」后不再弹出；
- [ ] 按 `Ctrl+Shift+Space`（mac 为 `Cmd+Shift+Space`）能抓当前选区；没有选区时提示而不是弹空窗（若该组合已被别的软件占用，应用会自动改用 `Ctrl+Shift+X` 并弹系统通知，日志里也有记录）；
- [ ] 把鼠标移到屏幕最右/最下再划词，弹窗翻到左侧/上方且完整可见；多显示器下也正常。

**弹窗**

- [ ] 「复制」后剪贴板是选区内容，弹窗约 0.7 秒后自动消失；
- [ ] 「搜索」在默认浏览器打开对应引擎，URL 里的查询词正确（含中文与空格）；
- [ ] 弹窗里点「设置」能打开设置窗口；`Esc` 立即关闭；
- [ ] 复制结果按钮、重试、停止在流式输出中都能正常工作；
- [ ] 长结果滚动到底部时不卡（流式 delta 有 rAF 节流）。

**剪贴板与焦点**

- [ ] 划词前后，剪贴板里原本的内容没有被改掉（设置里「恢复剪贴板」开启时）；
- [ ] 抓取期间前台应用没有丢失焦点（除了弹窗自己获得焦点）；
- [ ] 连续快速划词不会叠加多个弹窗、不会重复发送 AI 请求（旧请求会被 cancel）。

**设置**

- [ ] 改主题（浅色/深色/跟随系统）立即生效，弹窗与设置窗口都跟着变；
- [ ] 改快捷键后立即生效，重启后仍保留；
- [ ] 改弹窗宽度/字号/显示的动作后重新划词生效；
- [ ] 「测试连接」对正确 Key 返回「连接成功」与模型列表，对错误 Key 返回「API Key 无效」；
- [ ] 设置写盘失败（例如目录只读）时有提示，不会静默丢配置。

**AI**

- [ ] 解释/总结/润色/语法检查能流式逐字显示，结束后底部出现「复制结果」；
- [ ] 没有 Key 时选择 AI 动作，弹窗提示「去填写」并能跳到设置 → AI；
- [ ] 401 / 402 / 网络断开 / 超时 分别给出对应中文提示（不是英文堆栈）；
- [ ] 长文本（超过 4000 字符）会提示已截断。

**托盘与启动**

- [ ] 托盘菜单的「开机自动启动」勾选后重启系统仍然生效（打包版才能测）；
- [ ] 「查看日志」「打开配置目录」能打开正确位置；
- [ ] 退出后没有残留进程（`Ctrl+Shift+Esc` 里看不到 SelectPop）。

### 5. 打包验证

```bash
pnpm dist:dir   # 只解包到 dist/win-unpacked，最快验证打包配置
pnpm dist:win   # Windows：NSIS 安装包 + 免安装版
pnpm dist:mac   # macOS：dmg + zip（arm64 + x64，需在 mac 上执行）
```

> 提示：`dist:win` 的 NSIS 阶段会在系统临时目录创建临时文件；若报 `Error in macro _Switch on macroline 8`，说明临时目录不可写，把 `TEMP`/`TMP` 指到可写目录（如项目内 `.cache`）再跑即可。`dist:dir` 不经过 NSIS，不受影响。

安装包产物在 `dist/`。装完之后要**重新**确认三件事：

1. 托盘图标正常（`assets/tray.png` 已随 asarUnpack 解包到 `resources/app.asar.unpacked/assets/`）；
2. `uiohook-napi` 能加载（它同样是 asarUnpack，`--dir` 版能直接跑说明没问题）；
3. macOS 版重新授予「辅助功能」权限（每次重新签名都要重新授权）。

## 发版

GitHub Release 只发布 **Windows 绿色版**（zip），不含安装版与 macOS 包。发布流程用 GitHub Actions 全自动：

```bash
# 1. 改版本号
#    编辑 package.json 的 "version"，例如 0.1.0 → 0.2.0

# 2. 提交并打 tag（tag 前缀 v 会触发 .github/workflows/release.yml）
git add -A
git commit -m "chore: bump version to 0.2.0"
git tag v0.2.0
git push origin main
git push origin v0.2.0
```

推送 `v*` 标签后，GitHub Actions 在 Windows 上：

1. `pnpm install`（含 uiohook-napi / electron 预编译产物）；
2. `node scripts/gen-icons.js` 生成图标（build/icon.ico 等是生成产物，不入库）；
3. `node scripts/build-helper.js` 编译 sendcopy.exe / wininfo.exe；
4. `electron-builder --win zip --x64 --publish always` 构建绿色版 zip 并上传 Release。

zip 里自动带上 `Start-SelectPop.cmd` 与 `README.txt`（由 `build.win.extraFiles` 复制进 win-unpacked）。绿色版不支持自动更新，用户升级 = 下载新 zip 覆盖整个文件夹、保留 `.data` 目录。

代码里仍保留 electron-updater（`src/main/updater.js`），但绿色版没有安装器，点「检查更新」会直接提示「便携版不支持自动更新」；如需恢复自动更新能力，需重新发布 NSIS 安装版（`electron-builder --win nsis`）并让用户改用安装版。**注意**：发版前务必确认 `package.json` 的 `build.publish` 里 `owner`/`repo` 与你的仓库一致（当前为 `JiaWenHa/selectpop`）。

## 平台差异与权限

| | Windows | macOS |
| --- | --- | --- |
| 触发 | `uiohook-napi` 全局钩子 + 自带 `sendcopy.exe`（SendInput 发 `Ctrl+C`） | `uiohook-napi` + `osascript` 发 `Cmd+C` |
| 权限 | 以管理员身份运行能覆盖更多应用（非必须） | 必须授予「辅助功能」（系统设置 → 隐私与安全性 → 辅助功能） |
| 剪贴板 | 直接读写 | 直接读写 |
| 自动启动 | 写入 `HKCU\...\Run` | `app.setLoginItemSettings` |
| 托盘 | 单击打开设置 | 菜单栏模板图标（自动反色） |
| 窗口行为 | 无边框置顶，不抢任务栏 | `LSUIElement`，无 Dock 图标 |

macOS 首次启动会弹对话框直接跳到「辅助功能」设置页；改完权限需要重启 App（系统不会热生效）。

## 项目结构

```
selectpop/
├─ src/
│  ├─ main/                 主进程（Node 环境）
│  │  ├─ index.js           入口：启动、单实例、设置联动、冒烟测试
│  │  ├─ selection-monitor.js  uiohook 全局鼠标钩子
│  │  ├─ capture.js         哨兵法抓选区
│  │  ├─ keystroke.js       模拟 Ctrl+C / Cmd+C（Windows 走 sendcopy.exe）
│  │  ├─ clipboard-guard.js 快照 / 恢复剪贴板
│  │  ├─ foreground.js      wininfo.exe 输出解析（诊断前台窗口）
│  │  ├─ popup-controller.js 弹窗业务：动作分发、AI 流式、错误处理
│  │  ├─ popup-window.js    无边框透明置顶窗口
│  │  ├─ settings-window.js 设置窗口
│  │  ├─ settings-store.js  配置 + API Key 持久化（safeStorage）
│  │  ├─ deepseek.js        chat/completions 流式客户端
│  │  ├─ updater.js         electron-updater 自动更新
│  │  ├─ ipc.js             IPC 白名单与参数校验
│  │  ├─ tray.js            托盘菜单
│  │  └─ logger.js          写日志（1MB 轮转）
│  ├─ preload/              contextBridge 安全桥
│  ├─ renderer/             弹窗与设置窗口（原生 HTML/CSS/JS，无构建步骤）
│  └─ shared/               纯函数：文本、URL、SSE、定位、设置 schema、提示词
├─ scripts/gen-icons.js     纯 Node 生成 PNG / ICO 图标（无图形库）
├─ scripts/build-helper.js  用系统 csc.exe 编译 Windows 的 Ctrl+C / 诊断小工具
├─ scripts/check-api.js     命令行直接验证 DeepSeek 链路（不需要界面）
├─ native/win-sendcopy/      sendcopy.exe 的 C# 源码（SendInput 发 Ctrl+C）
├─ native/win-foreground/    wininfo.exe 的 C# 源码（前台窗口诊断）
├─ tests/                   node:test 单元测试
├─ build/                   打包资源（entitlements.mac.plist；图标为生成产物）
├─ assets/                  运行时图标 + bin/sendcopy.exe、bin/wininfo.exe（生成产物）
└─ .github/workflows/       GitHub Actions 发版（tag 触发）
```

所有代码是 CommonJS、零构建步骤：改完 `src/` 直接重启即可，渲染层只依赖 `contextBridge` 暴露的 `window.selectpop`。

## 常见问题

**划词不弹**

按这个顺序排查：

1. 托盘菜单里「划词已启用」是否勾上；
2. 拖选距离是否太小（默认 6px 起）——可以调小，但太小会误触发；双击选词需要「双击选词」开关打开；
3. 以管理员身份运行的程序（任务管理器、部分游戏）里，普通权限的全局钩子收不到鼠标事件；
4. macOS 是否给了「辅助功能」权限（改完要重启 App）；
5. **看日志**（托盘 →「查看日志」，`logs/selectpop.log`），按关键字定位：
   - 没有 `鼠标钩子已收到事件` → 钩子没收到鼠标事件：权限问题（macOS 辅助功能）或者程序以管理员运行；
   - 有 `判定为划词` 但没有 `捕获到选区` → 复制快捷键没把选区送进剪贴板，看下一条；
   - 有 `未获取到选区 {"reason":"no-selection"}` → 前台窗口没有可复制的选区，或复制快捷键被拦截；同一条日志附近会有 `未抓到选区时的目标窗口 {"process":...,"title":...}`，用它确认 Ctrl+C 到底发到了哪个窗口（是不是被别的窗口抢了焦点）；
   - 有 `捕获到选区 {"chars":N}` → 取词成功，问题在弹窗（看 `注册快捷键失败`、显卡黑边等）。

**Windows 上 Ctrl+C 取不到词（`no-selection`）**

确认 `assets\bin\sendcopy.exe` 与 `assets\bin\wininfo.exe` 都存在（安装包里在 `resources\app.asar.unpacked\assets\bin\`）。`sendcopy.exe` 负责向别的程序发 Ctrl+C，`wininfo.exe` 负责解析「鼠标停在哪个窗口」。缺了前者只能退回 cscript 方案（对 Chrome / Word 这类其它进程无效）；缺了后者就失去「焦点被抢后重新聚焦补发」的诊断与兜底。日志里出现 `复制快捷键通道不可用，改用单次调用` 或 `sendcopy.exe 退出` 就是在说这件事，重新跑 `pnpm build:helper` 或重装即可。

浏览器里的选区在「窗口失去焦点」时会被清掉，所以如果日志显示 `未抓到选区时的目标窗口` 指向的目标窗口不是你在拖选的那个，多半是弹窗/托盘抢了焦点导致选区丢失；这种情况把「复制前延迟」调小一点、或先点一下要划词的页面再拖选，通常就能稳定复现。

**能弹窗但内容是旧的**

说明 `Ctrl+C` 没生效：某些终端（Windows Terminal 的 vim、远程桌面）会拦截。可以在设置里调大「复制前延迟」。用哨兵法时，如果没复制成功，弹窗不会出现（因为剪贴板还是哨兵值），所以旧内容不会被误当成选区。

**弹窗有黑边 / 闪烁**

透明窗口在部分显卡驱动上会这样。设置里或者环境变量 `SELECTPOP_DISABLE_GPU=1` 可以关掉 GPU 加速再试。

**快捷键没反应**

`CommandOrControl+Shift+Space` 可能被其他软件占用。设置 → 触发方式 → 快捷键，点进去重新按一组组合键（必须带修饰键，功能键 F1~F24 可以单独使用）。

**AI 报错**

- `API Key 无效`：Key 错了或已被删除；
- `账户余额不足`：DeepSeek 账户没充值；
- `接口地址不存在`：Base URL 写错了（默认 `https://api.deepseek.com`，别漏 `https`）；
- `请求太频繁`：等一下再试，或换个模型；
- `无法连接`：公司网络/代理拦截，或需要给系统配代理。

**连续划词要求重新点**

这是设计：同一段文字 1.5 秒内不重复弹，AI 请求会取消上一个，避免叠加计费。

**启动后立刻退出，没有任何输出**

先看退出码：

```powershell
electron . --dev; $LASTEXITCODE
```

- `-2147483645`（即 `0x80000003` STATUS_BREAKPOINT）= Chromium 还没进入 JS 就崩了，属于环境问题，不是代码问题。常见于：远程会话/服务窗口站（非交互式桌面）、被安全软件拦截、在 CI 或无桌面环境里跑。换到正常的桌面会话（本地登录或 RDP）再试。
- 退出码 `0` 且托盘没有图标：看 `%APPDATA%\SelectPop\logs\selectpop.log`，通常是被单实例锁挡住——已经有一个实例在跑（包括看不见的托盘实例）。
- 退出码 `1` 且弹出错误框：里面会有具体的栈，多半是端口/权限/依赖缺失。

**双击后提示「应用程序无法正常启动（0xc0000142）」或进程直接消失**

`0xc0000142` 是 Windows 加载器在 DLL 初始化阶段失败的报错，Electron 在这种情况下最常见的两个原因是：

1. **Electron 的 `userData` / `TEMP` 目录不可写**。Chromium 启动前必须在该目录建缓存、共享内存文件，写不进去就直接死在初始化。把应用数据重定向到有写权限的盘即可：

   ```cmd
   set "TEMP=D:\temp"
   set "TMP=%TEMP%"
   SelectPop.exe --user-data-dir=D:\SelectPopData
   ```

2. **当前会话不是交互式桌面**（服务账户、计划任务、某些远程/沙箱环境），或安全软件拦截了 Chromium 的沙箱。可以先用 `--no-sandbox` 排除沙箱因素：

   ```cmd
   SelectPop.exe --no-sandbox --user-data-dir=D:\SelectPopData
   ```

正式安装版启动时会自动做一次可写性探测（`ensureWritableUserData()`）：默认数据目录写不进就依次尝试 `%LOCALAPPDATA%\SelectPop-Data`、临时目录、exe 同级目录，并在控制台打印切换结果。仓库里的 `run-dev.cmd` / `run-smoke.cmd` / `run-packaged.cmd` 已经把数据目录固定在项目内 `.data\`，直接双击即可。

**关于 Electron 45 的剪贴板 API**

Electron 45 起主进程的 `clipboard` 换成了异步的 Web Clipboard 风格接口：`readText()` / `writeText()` 返回 Promise，`read()` / `write()` 收发 `ClipboardItem`，并且**不再提供 `readHTML` / `readRTF` / `readImage`**。`src/main/clipboard-guard.js` 做了兼容层：异步接口优先，`readHTML`/`readRTF` 只在老版本存在时才读；所以划词时纯文本完全没问题，但在这类版本上「恢复剪贴板」只能恢复文字，原有的图片/富文本无法还原（划词本身只用到文字）。

**在远程会话里验证**

划词本身依赖前台窗口与全局鼠标钩子，所以必须在真正有桌面的会话里验证；纯 SSH/服务里只能跑 `pnpm test` 与 `pnpm check-api`。

## 隐私

- 划词内容只在本地内存里处理；只有你主动点击「解释/总结/润色/AI 翻译」时，才把文本（截断后的）发给 DeepSeek；
- 「搜索」「网页翻译」只是拼 URL 交给系统浏览器，不经过本应用；
- API Key 用系统加密存储，日志里不会出现明文 Key；
- 日志只记录事件与错误原因，不记录选中文本的正文。

## License

MIT
