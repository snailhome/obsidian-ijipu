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
  **`copy-image-1/2/4`（图片出口，2× 默认：「复制为图片」；**只有桌面端生成**，`adj874`）·
  `copy-svg`（复制 SVG 文本）· `copy-source`（复制谱面源码）**·
  **`range-view/page/score`（导出范围：跟随视图 / 页面 / 谱面，单选打勾）**·
  `app-open`（在应用中打开，仅桌面）· `embed-link`（打开谱面文件，仅嵌入模式且"编辑"会离开 Obsidian 时）。
  这些按钮由宿主能力决定建不建，**建在游离容器 `menuOnly` 里**（不挂工具条 DOM），
  菜单项只做**路由**：`id → 对应按钮的 .click()` 或插件方法（复用既有实现，零重复实现）。

### 图片出口：**仅桌面**「复制为图片」（`adj864`；`adj874` 收口为手机端不出现）

> **口径（用户 2026-10-11 定稿）**：**图片类出口（复制为图片 / 导出 PNG）依赖嵌入版应用，而嵌入版
> 只在桌面注册 ⇒ 手机端不出现**。手机端可用的出口是「复制 SVG 文本 / 复制谱面源码 / 导出 SVG」，
> 理由是它们**走插件自己的引擎**（`api.renderSvg` / 纯文本），不经过嵌入版通道。

- 三条图片项 = `copyScoreImage(source, 1|2|4, paneRange)`；面板把**自己手里的**墨迹盒 + 当前显示模式
  传进去（比插件缓存新鲜）。渲染在**嵌入版应用**里做（插件没有 canvas，走既有的 `render.png` 通道），
  范围盒随 `params.crop` 传过去（应用只 `applyRangeToSvg`，不重算几何）。
- 写剪贴板前先补 **pHYs（`engine/png.ts`）**：`DPI = 72 × scale`（2× ⇒ 144 DPI，4× ⇒ 288 DPI）——
  否则 Word / 微信 / 飞书按 96 DPI 兜底，把 2× 渲染的 A4 谱插成 12 英寸巨图。
- **为什么手机端整组不生成**：取图这一步必须走**嵌入版 iJipu 应用**，而嵌入版**只在桌面注册**
  （`src/main.ts` 里 `if (Platform.isDesktopApp) this.registerView(...)`；`embed.ts` 的 `getEmbedUrl`
  在手机直接 `return null`）⇒ 手机上点图片项**必然失败**，`copyScoreImage` 也只会报"嵌入版通道不可用"。
  `adj873` 曾试图在手机端改成"保存到谱面同目录"，但取图同样要走嵌入版 ⇒ 真机上一样存不下来，
  该实现（`saveScoreImage` + `src/imageSave.ts`）已**整条删除**（项目规矩：不留死代码）。
  ⇒ 手机端菜单里**根本不出现**图片项（也不出现"保存图片"字样），而不是让用户点了才知道不行；
  要出图请用**桌面端**，或走「导出 PNG」命令（同样需要嵌入版通道）。
- **动作 id 仍是 `copy-image-1|2|4`**（`scorePane.ts` 的 `switch` 与 `MENU_ONLY_ACTIONS` 都不动）——
  变的只是"手机端不生成这三项"。
- 多页谱**只复制第 1 页**并如实说明（剪贴板只能放一张图）；剪贴板能力缺失时**如实报错**，
  并指向「导出 PNG」命令（会写进 vault）。
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
   图片链路的 pHYs 与剪贴板降级）会自动覆盖；**平台差异**（手机端不生成图片出口）另有 `adj874`
   （正/负对照 + 死代码扫描 + 文档同口径）；新动作记得同时进 `MENU_ONLY_ACTIONS`（负对照会核对它不在工具条里）。

## 三、移动分支（不是"缩小版桌面"）

策略一处给出：`toolbarPolicy(isMobile)`（`src/scoreMenu.ts`），渲染端与样式端只**消费**。

| 维度 | 桌面 | 移动端 | 落地 |
|---|---|---|---|
| 触控目标 | 24px（样式基线） | **≥44px** | `styles.css`：`.is-mobile .ijipu-score-toolbar`、`.ijipu-score-toolbar.ijipu-ported-mobile`（含 `--ijipu-ctl-w: 44px` 与 `min-width: 44px`） |
| **按钮文字标签** | **按容器宽度**：`.ijipu-score` 窄于 400px 时隐藏（`@container`） | **一律只图标**（用户 2026-10-12 口径：「手机端统一使用只图标」） | 结论来自 `toolbarPolicy().labelMode`（`hidden` / `byWidth`），渲染端打成 `.ijipu-icons-only` 类；样式在 `styles.css`（与那条 `@container` **同一套视觉口径，必须一起改**） |
| 自动收起 | 3s（`DESKTOP_AUTO_HIDE_MS`） | **常驻**（`autoHideMs = 0`） | `scorePane.ts` 的 `startAutoHide` 首行消费 policy |
| hover 依赖 | 无（`adj785` 起改为点击切换） | 无 | `hoverHide: false`（两端一致） |
| 右键菜单 | 有 | **无**（长按被宿主占用） | `contextMenu` 只在桌面注册 `contextmenu` |
| 「在应用中打开」 | 有 | **菜单里不出现** | `buildScoreMenu` 里按 `isMobile` 过滤 |
| **图片出口**（复制为图片 / 导出 PNG 同源） | 有 | **菜单里不出现** | `buildScoreMenu` 里按 `isMobile` 整组不生成。**原因**：取图必须走**嵌入版 iJipu 应用**，而嵌入版**只在桌面注册**（`main.ts` 的 `Platform.isDesktopApp` + `embed.ts` 的 `getEmbedUrl` 在手机 `return null`）⇒ 手机上必失败（`adj874`）。手机端可用的是「复制 SVG 文本 / 复制谱面源码 / 导出 SVG」——它们走插件自己的引擎 |

### 两条"动作即收"的硬规则（`adj905y`，用户实测）

1. **点「✎ 编辑」先收工具条、再派发**（`scorePane.ts` 的编辑处理器首两行）。
   为什么：显示态下工具条被搬到 `document.body`（`adj793c`，为摆脱祖先裁剪/层叠），而"切到源码视图 /
   打开 `.jps`"是**换掉页签内容** —— 既不保证走 `destroy()`（`adj794e` 已记：嵌入面板常走不到），
   也不会有下一次挂载 ⇒ 孤儿清理（`sweepOrphanBodyToolbars`）没机会跑 ⇒ 那条工具条就浮在源码视图上 ✗。
   `revealToolbar(false)` 会把它**挂回容器**（随旧页签一起丢弃）；手机端再补 `is-user-hidden`
   （`.is-mobile` 那条"常显"会压过默认隐藏）。
   **再加一道兜底（`adj905z` 之二，用户口径：「可以在打开 jps 文件做一个检查，如果有工具条残留，
   关闭就行，这样简单又有效」）**：两条"打开 `.jps`"的路径
   （`openJpsForSourceEdit` / `openEmbedLeaf`）在**导航落定之后**都调
   `sweepToolbarsAfterNavigation()` —— 现在清一次 + **下一帧再清一次**。
   这条比"点的那一刻记账"实在：打开 `.jps` **必然**把承载嵌入块的页签换掉 ⇒ 残留工具条的容器
   那时**一定已经不在文档里** ⇒ `sweepOrphanBodyToolbars()` 的判据直接成立 ✓
   （下一帧再清是因为 leaf 内容替换与 DOM 断连不一定在同一拍完成）。
2. **文字标签的结论要随元素走**（`.ijipu-icons-only` 类，而不是只靠容器查询）——
   同一条工具条不能在"收起时只图标、点开却带文字"。新增按钮时**文字与图标都要建**（`ijipu-btn-label`
   仍照常创建），由上面那套策略决定看不看得见。
3. **「编辑」跳过去的那一次导航要能"返回"**（`adj905z`，用户实测：「这个操作没有进操作历史 ⇒
   无法通过回退返回到刚刚的笔记中」）。这是**两条通往同一个坑的路**，都要按下面写：
   - **手机端**（嵌入块「编辑」⇒ 打开 `.jps` 并进源码）：必须在**当前页签**打开
     （`openJpsForSourceEdit` 用 `getMostRecentLeaf(rootSplit) ?? getLeaf(false)`，**不要** `getLeaf('tab')`）——
     这就是"点 `[[x.jps]]` 链接"的语义：**同一页签替换视图 + 导航历史记下刚才那份笔记** ⇒ 返回能回去。
     ⚠ **新页签的历史是空的**：开在新页签里，用户就没有"上一篇"可回（这正是用户报的现象）。
   - **桌面端**（「打开 `.jps` 的方式 = 当前页签」，或从嵌入块点「编辑」时的落点）：`setViewState`
     **只换视图、不进导航历史**（官方 API 里"要不要进历史"由**视图**在 `View.setState(state, result)` 里
     声明，`ViewStateResult.history`；插件里 `revealSource()` 用的 `{ history: false }` 就是同一个旋钮）。
     所以换视图**之前**先走一次**真·打开文件**（`await target.openFile(file)`）——那一趟是标准文件导航，
     会把"刚才那份视图"记进该 leaf 的历史。只在来源页签不是本 leaf 时才需要（从 `.jps` 文件视图路由过来时，
     用户点开那份 `.jps` 本身已经进过一次历史）。

## 四、图标同源

工具条第 5 位用**应用的**「更多」PNG：`vendor/icons/更多.png` ← 逐字节同步自
`ijipu/public/icons/更多.png`（与 `Jianpu.png` 同一手法），冒烟 `adj862` 有跨仓逐字节比对。
