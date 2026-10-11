# 谱面工具条与菜单（T-5 定稿口径）

> 定稿于 2026-10-11（用户口径），实现于 `adj862`。**这是"工具条上放什么、菜单里放什么"的唯一口径**，
> 后续功能（`范围参数` / `复制为图片` / `z` / 导出 / 诊断）都往这份口径里加，**不要**在渲染端另加项。

## 一、工具条：固定 5 位

| 位 | 槽位 id | 内容 | 说明 |
|---|---|---|---|
| 1 | `play` | `▶ 试听` | 播放/停止（边听边看高亮色块） |
| 2 | `guides` | `☰ 排版` | 排版辅助虚线开关（虚线可拖动改边距/行距，松手写回 `# jps-config`） |
| 3 | `mode` | `谱面·页面` | 显示模式：整页 / 满宽 / 谱面 |
| 4 | `edit` | `✎ 编辑` | 按宿主与平台分派（笔记源码 / 宿主编辑器 / 嵌入版 iJipu） |
| 5 | `more` | `⋯ 更多` | 低频入口的唯一出口（见下） |

**契约位置**：`src/scoreMenu.ts` 的 `SCORE_TOOLBAR_SLOTS`（顺序即渲染顺序）；
`src/scorePane.ts` 里每个槽位按钮都打 `dataset.slot`，顺序必须与契约一致 ——
冒烟 `adj862` 会对**源码计数**核对（工具条按钮恰好 5 个 + 顺序一致 + 负对照）。

## 二、菜单：只定义一次，三处呈现

```ts
buildScoreMenu(ctx)   // src/scoreMenu.ts —— 纯数据，零 obsidian/DOM 依赖
  ├─ 桌面 `⋯ 更多` 按钮  → Menu.showAtPosition(按钮下沿)
  ├─ 桌面预览区**右键**   → Menu.showAtPosition(鼠标位置)   ← 仅桌面（policy.contextMenu）
  └─ 移动端              → 同一个 Menu（Obsidian 在手机上本身就是**底部 Action Sheet**）
```

- 移动端 Action Sheet **不需要自己画**：`obsidian.asar` 的 app.css 有
  `.is-phone .menu { position: absolute; bottom: 0; border-radius: … 0 0 }` 与 `.menu-grabber`
  ⇒ 三处共用一个 `Menu` 即天然满足，**不引入第二套渲染**。
- 「只进菜单、不进工具条」的动作登记在 `MENU_ONLY_ACTIONS`：
  `settings`（设置/页面设置）· `format`（格式化源码）·
  **`copy-image-1/2/4`（图片出口，2× 默认：桌面「复制为图片」/ 手机「保存图片」，同一批 id；`adj873`）·
  `copy-svg`（复制 SVG 文本）· `copy-source`（复制谱面源码）**·
  **`range-view/page/score`（导出范围：跟随视图 / 页面 / 谱面，单选打勾）**·
  `app-open`（在应用中打开，仅桌面）· `embed-link`（打开谱面文件，仅嵌入模式且"编辑"会离开 Obsidian 时）。
  这些按钮由宿主能力决定建不建，**建在游离容器 `menuOnly` 里**（不挂工具条 DOM），
  菜单项只做**路由**：`id → 对应按钮的 .click()` 或插件方法（复用既有实现，零重复实现）。

### 图片出口：桌面「复制为图片」（`adj864`）/ 手机「保存图片」（`adj873`）

- 三条图片项 = `copyScoreImage(source, 1|2|4, paneImage)`（**桌面**）/ `saveScoreImage(source, 1|2|4, paneImage)`
  （**手机**）；面板把**自己手里的**墨迹盒 + 当前显示模式传进去（比插件缓存新鲜）。渲染仍在**嵌入版应用**里做
  （插件没有 canvas，走既有的 `render.png` 通道），范围盒随 `params.crop` 传过去（应用只 `applyRangeToSvg`，
  不重算几何）。
- 写剪贴板前先补 **pHYs（`engine/png.ts`）**：`DPI = 72 × scale`（2× ⇒ 144 DPI，4× ⇒ 288 DPI）——
  否则 Word / 微信 / 飞书按 96 DPI 兜底，把 2× 渲染的 A4 谱插成 12 英寸巨图。**保存图片走同一条路**，
  存下来的字节与粘贴出去的是同一张。
- **为什么两端不同**（`adj873`，用户 2026-10-11）：手机宿主 WebView **写不了剪贴板图片**
  （没有 `ClipboardItem` / `navigator.clipboard.write`）⇒ 手机上改成**保存到谱面同目录**，
  文件名 `<谱名>.png`、重名加 `-2`/`-3`…（`src/imageSave.ts`，**绝不静默覆盖** ✗）。
  动作 **id 不变**（`copy-image-1|2|4`）⇒ 路由表与菜单结构不动，平台差异只在**文案**
  （`scoreMenu.ts` 的 `saveOnMobile`）与**落点**（`scorePane.ts` 的分派 + `main.ts` 的 `saveScoreImage`）。
- **保存到哪个目录**（`paneImage.targetPath = host.filePath ?? host.notePath`）：
  `.jps` 文件视图 / `![[x.jps]]` 嵌入 ⇒ 该文件所在目录；```jps 代码块 ⇒ **宿主笔记所在目录**；
  取不到 ⇒ 库根。写完的 `Notice` 里给出**完整库内路径**，多页谱说明"**只保存第 1 页**"。
- 多页谱在桌面**只复制第 1 页**并如实说明（剪贴板只能放一张图）；剪贴板能力缺失（移动端 WebView 等）
  **如实报错**，并指向「导出 PNG」命令（会写进 vault）。
- 图片渲染在应用里做 ⇒ 两边**页面尺寸必须一致**：`resolveRangeBox` 先比对"预览实测的页面尺寸"与
  "嵌入版渲染出的页面尺寸"，不一致就**明确拒绝**（否则墨迹盒落在另一套坐标系、裁出来必错位）。

### 导出范围（`adj863` / `adj864` / `adj873`）

`settings.exportRange`（L1）= **`view`（跟随视图，默认）** · `page`（整页 + 留白）· `score`（墨迹 + 每边 2px）。
设置页与菜单「导出范围」组改的是**同一个值**，缺省值只在一处定义（`src/types.ts` 的 `DEFAULT_EXPORT_RANGE`）。

默认值变迁（两次都有用户口径）：`adj863`/`adj864` 时刻意选 `page`（面板初始模式就是「谱面」，
若默认跟随视图，老用户升级后导出尺寸会**静默变化**）；**用户 2026-10-11 明确改成 `view`**（`adj873`）——
导出/复制默认就与**看到的**一致，代价由"菜单/设置页都把当前值打勾"兜住（一眼能看出按哪种口径，也能就地改回）。
几何一律走引擎（见应用仓库 `docs/HANDOVER-CLI-AND-COMMAND-API.md` 二之二）。

**加一个新菜单项的正确姿势**：
1. 在 `src/scoreMenu.ts` 的 `MENU_ONLY_ACTIONS` 与 `buildScoreMenu` 里加 id + 文案（含 `title`）；
2. 在 `src/scorePane.ts` 里把对应按钮建到 `menuOnly`（或在已有按钮上加处理器），
   并在 `runScoreMenuAction` 的 `switch` 里加 `case`（**少一个 case 就是"点了没反应"**，冒烟会红灯）；
3. 需要的能力标志加进 `ScoreMenuContext`（不要直接传 `ScorePaneHost`：模型不认识宿主类型）；
4. 冒烟 `adj862`（id 路由齐全、菜单项都带标题、游离容器计数）与 `adj864`（复制/范围两组、单选打勾、
   图片链路的 pHYs 与剪贴板降级）会自动覆盖；**手机/桌面文案不同**或**写库**的项另有 `adj873`
   （平台分派 + 落点 + 重名递增，均有负对照）；新动作记得同时进 `MENU_ONLY_ACTIONS`（负对照会核对它不在工具条里）。

## 三、移动分支（不是"缩小版桌面"）

策略一处给出：`toolbarPolicy(isMobile)`（`src/scoreMenu.ts`），渲染端与样式端只**消费**。

| 维度 | 桌面 | 移动端 | 落地 |
|---|---|---|---|
| 触控目标 | 24px（样式基线） | **≥44px** | `styles.css`：`.is-mobile .ijipu-score-toolbar`、`.ijipu-score-toolbar.ijipu-ported-mobile`（含 `--ijipu-ctl-w: 44px` 与 `min-width: 44px`） |
| 自动收起 | 3s（`DESKTOP_AUTO_HIDE_MS`） | **常驻**（`autoHideMs = 0`） | `scorePane.ts` 的 `startAutoHide` 首行消费 policy |
| hover 依赖 | 无（`adj785` 起改为点击切换） | 无 | `hoverHide: false`（两端一致） |
| 右键菜单 | 有 | **无**（长按被宿主占用） | `contextMenu` 只在桌面注册 `contextmenu` |
| 「在应用中打开」 | 有 | **菜单里不出现** | `buildScoreMenu` 里按 `isMobile` 过滤 |

## 四、图标同源

工具条第 5 位用**应用的**「更多」PNG：`vendor/icons/更多.png` ← 逐字节同步自
`ijipu/public/icons/更多.png`（与 `Jianpu.png` 同一手法），冒烟 `adj862` 有跨仓逐字节比对。
