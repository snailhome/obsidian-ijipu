# 爱记谱 iJipu 0.51.2

> **修复版**（PATCH）：把新的品牌 logo 带进内嵌应用，顶栏和「关于」里的 logo 不再显示成破图。

## 修复

- 嵌入版资产白名单 `USED_ICONS` 里只有旧版 `Jianpu.png`，而顶栏 `TopBar.tsx` 和「关于」`AboutDialog.tsx` 早已改用 `icons/logo-jp.png`；请求查不到时 `server.ts` 回 204，界面就显示成破图。
- 白名单补上 `logo-jp.png`。
- `build:embed` 新增 `assertStaticIconsCovered()`：扫描 `src/**/*.ts|tsx` 里真正渲染的 `src="...icons/..."` 引用，漏一个就构建失败；以后换品牌图不会再静默漏带。
- 重建内嵌应用资产：51 个资产（49 个图标）/ 166.0 KB；单文件 HTML 1,862.9 KB（1,773,030 字符）。内嵌应用仍为 `0.84.0`，`vendor/engine` 未改。

## 验证

- `npm run build` 通过（`tsc -noEmit -skipLibCheck` 0 错误）。
- 按插件 `embed/server.ts` 同口径（剥 token + `decodeURIComponent` + `WEBAPP_ASSETS`）请求全部资产：**51/51 返回 200，0 失败**。
- 深色 1280×900 下顶栏 logo 与「关于」大 logo 的请求均 200，`naturalWidth 1713`；`icons/logo-jp.png` 键在 `webappAssets.ts` 与 `main.js` 中都存在。
- `npm run smoke`：**839 passed, 1 failed**；唯一失败仍是 `adj770` 跨仓 vendor 比对（本机应用引擎比插件 vendor 新），与本轮 logo 修复无关。
- 未在真实 Obsidian 里重载本版验证，需用户装上 0.51.2 后看一眼顶栏与「关于」。

# 爱记谱 iJipu 0.51.1

> **修复版**（PATCH）：修复内嵌应用里部分图标按钮显示空白的问题。深色、浅色主题都有，深色背景上更显眼。

## 修复

- 嵌入版资产白名单 `USED_ICONS` 漏了 11 个工具图标（`重排`、`右侧边栏`、`窄栏`、`宽栏`、`浮动`、`粘贴`、`取消`、`乐谱包`、`恢复默认`、`保存`、`打开目录`）。这些图标请求回 204，按钮只剩下边框：顶栏「重排」、右侧栏开关，右栏的「窄栏 / 宽栏」「浮动 / 插入」等。
- 现在补齐全部 43 个工具图标；`build:embed` 增加构建期校验 `assertToolIconsCovered()`，以后 `toolIcons.ts` 新增图标而白名单没同步时会直接构建失败。
- 重建内嵌应用资产：50 个资产（48 个图标）/ 98.6 KB；单文件 HTML 1,862.9 KB（1,907,566 B）。内嵌应用仍为 `0.84.0`，`vendor/engine` 未改。

## 验证

- `npm run build` 通过（`tsc -noEmit -skipLibCheck` 0 错误）。
- 按插件 `embed/server.ts` 同口径（剥 token + `decodeURIComponent` + `WEBAPP_ASSETS`）请求全部资产：**50/50 返回 200，0 失败**。
- 深色 1280×900 下右栏三个按钮与顶栏右侧栏开关的图标请求全部 200；用户已在真实 Obsidian 里重载插件确认显示正常。
- `npm run smoke`：**839 passed, 1 failed**；唯一失败是 `adj770` 跨仓 vendor 比对（本机应用引擎有 5 个文件比插件 vendor 新），与本轮图标修复无关；图标相关检查全过。

# 爱记谱 iJipu 0.51.0

> **跟随版（内嵌应用 0.84.0）**（MINOR）：内嵌应用重新生成，把 0.84.0 的重排、行首隐式小节线、末行小节线对齐和临时拍号/转调显示带进 Obsidian；`vendor/engine` 同步到 0.84.0 的引擎快照。

## 内嵌应用 0.83.0 → 0.84.0

- **重排**：短 Q 行先整体合并，再按“每行最多 N 小节 / 固定占宽 / 目标行数”重新断行；多声部按同一小节切，歌词一起拆，一步撤销。
- **行首隐式小节线**：行首写出的普通 barline 并到上一行末；行首 `[` 不再需要 `|/`。
- **末行小节线**：按上一行真正计入的小节逐根对齐；压到增时线/附点时，让到前后音完整墨迹中间。
- **临时拍号/转调**：`p:`/`d:` 放行首时不写 `|/`；与跳房子同现时写在 `[` 前；`d:` 标在第一个可发声元素上方。
- **连音线**：反复跳回时，多个前半段共用一个后半段只画一次；同行的普通连音线已覆盖后半段时不再补长横线。
- 应用版本 `0.84.0`（`WEBAPP_META.appVersion`）。单文件 HTML 1,835.8 KB（1,746,121 字符），精简资产 39 个 / 90.9 KB，生成文件合计 1.92 MB。

## 引擎

- `vendor/engine` 同步 `0.84.0` 快照：81 个文件，哈希 `dbb12446a9c3ed652c242d4d3833774196b151a1663ea6f3fee91e60809c162b`。
- 新增/固化 `buildLinearStrip` 的 `mode:'play-order'` 与 `barlineAnchor:'gap'`；小节线锚在前后音完整墨迹的中间（含倚音/滑音/右括号）。

## 插件自身

- 无插件专属功能改动；内嵌应用资产和 `vendor/engine` 重新生成。
- 版本 `0.51.0`；同步 `vendor/icons/Jianpu.png` 到应用 0.84.0 的品牌图标。

## 验证

- `npm run build` 通过（`tsc -noEmit -skipLibCheck` 0 错误）。
- `npm run smoke`：**840 passed, 0 failed**。
- `npm run smoke:embed` 通过：单文件产物启动成功、无运行时报错，桥端到端通过（应用 hello→ready、19 次桥调用），宿主推 `openFile` 能真的打开，设置持久化走宿主。

# 爱记谱 iJipu 0.50.0

> **跟随版（内嵌应用 0.83.0）**（MINOR）：内嵌应用**重新生成**，把 0.83.0 的试听小播放条、底栏小条、空格播放/暂停、导出标记段带进 Obsidian 内嵌界面。引擎号不变（仍 `0.48.0`），`vendor/engine` 未改动；插件自身无功能改动。

## 内嵌应用 0.82.0 → 0.83.0

- **顶栏「试听」改成试听小播放条的开关键**；小条的「设置」才打开试听页签；双击 / Ctrl+单击音符改为打开小条并播放；页签隐藏时小条仍显示。
- **底栏模式也支持小条**（关而不卸 + 隐藏会话宿主），不再退回「打开试听页签」的旧行为；关掉小条会停播。
- **空格 = 播放 / 暂停**：只在已有播放会话、且焦点不在编辑区 / 右栏 / 底栏 / 原生控件时接管。
- **导出标记段**：导出页签新增「标记段」下拉，音频导出可选整曲 / 当前标记段。
- 应用版本 `0.83.0`（`WEBAPP_META.appVersion`）。单文件 HTML 1,800.5 KB（1,713,497 字符），精简资产 39 个 / 90.9 KB，生成文件合计 1.89 MB。

## 引擎

- 版本不变（`0.48.0`）；`vendor/engine` 未改动。

## 插件自身

- 无功能改动；内嵌应用资产重新生成。
- 同步 `vendor/icons/Jianpu.png` 到应用 0.83.0 的品牌图标（插件 smoke 的 `adj739` 要求与 `ijipu/public/icons/Jianpu.png` 逐字节一致）。

## 验证

- `npm run build` 通过（`tsc -noEmit -skipLibCheck` 0 错误）。
- `npm run smoke`：**840 passed, 0 failed**。
- `npm run smoke:embed` 通过：单文件产物启动成功、无运行时报错，桥端到端通过（应用 hello→ready、19 次桥调用），宿主推 `openFile` 能真的打开，设置持久化走宿主。
