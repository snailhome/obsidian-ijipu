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
  `settings`（设置/页面设置）· `format`（格式化源码）· `app-open`（在应用中打开，仅桌面）·
  `embed-link`（打开谱面文件，仅嵌入模式且"编辑"会离开 Obsidian 时）。
  这些按钮由宿主能力决定建不建，**建在游离容器 `menuOnly` 里**（不挂工具条 DOM），
  菜单项只做**路由**：`id → 对应按钮的 .click()`（复用既有处理器，零重复实现）。

**加一个新菜单项的正确姿势**：
1. 在 `src/scoreMenu.ts` 的 `MENU_ONLY_ACTIONS` 与 `buildScoreMenu` 里加 id + 文案（含 `title`）；
2. 在 `src/scorePane.ts` 里把对应按钮建到 `menuOnly`（或在已有按钮上加处理器），
   并在 `runScoreMenuAction` 的 `switch` 里加 `case`（**少一个 case 就是"点了没反应"**，冒烟会红灯）；
3. 需要的能力标志加进 `ScoreMenuContext`（不要直接传 `ScorePaneHost`：模型不认识宿主类型）；
4. 冒烟 `adj862` 会自动覆盖（id 路由齐全、菜单项都带标题、游离容器计数）。

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
