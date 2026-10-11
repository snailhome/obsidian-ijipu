# 爱记谱 iJipu 0.35.1

> **本版是修复 + 内嵌产物更新版**（PATCH）：把**含 Obsidian IPC 桥**的应用产物（v0.52.0）重新内嵌，
> 并修掉两个你在真机上抓到的 bug。0.35.0 → **0.35.1**。**既有谱面与 `.jps` 语法零改动**。

## 修：导出 PNG / MIDI 提示「嵌入版无响应」

**根因**（你实测抓到的正是项目 AGENTS §五.8.1 那条**顺序铁律** ✗）：
插件的**嵌入版产物**（`src/gen/webappAssets.ts`）此前是**应用 0.51.2** 构建的 ✓，
而应用侧的**入站 RPC 桥**（`src/ipc/obsidianBridge.ts`）是**之后**才写的 ⇒
**内嵌的那份应用里根本没有桥** ✗ ⇒ 插件发 `render.png` / `export.midi` 后**永远等不到应答** ⇒ 10 秒超时 ⇒ 提示"无响应" ✓。

**修法**：按铁律走完整顺序 —— 应用升 **0.52.0** 并发布 ✓ → `npm run build:embed && node scripts/embed-emit.mjs` ✓
→ 本版插件内嵌产物更新为 **0.52.0（含桥）** ✓ ⇒ 「导出 PNG / MIDI」现在应能真正走通 ✓。

## 修：墨迹裁剪退化

**现象**（你的诊断）：`按墨迹裁剪 489×27（整页 595×842，高度只剩 3%）` ✗ ——
原来只要求"盒比整页小" ⇒ **又扁又窄的退化盒能溜过去** ⇒ 谱面会被裁成一条 27px 横带，
而「导出谱面」（墨迹 ± 2px）更会直接报废 ✗。
**修法**：加 **`MIN_INK = 40`** 闸 —— 量到的盒小于 40px 即视为**量取不可靠** ⇒ **退回按边距裁剪** ✓
并把原因写进诊断 ✓（比裁成条带好得多 ✗）。

## 修：「嵌入版未打开」误报

**根因**：定位 iframe 用了 `src.includes('token=')` ✗ —— 而 `embed/frame.ts` 建的 URL **不含 token**
（token 是加载后经 `bridge.setToken()` 传的 ✓）⇒ 判据**永远不成立** ✗ ⇒ 即使嵌入版开着也报"未打开" ✓。
**修法**：改按**本机服务地址**识别（`127.0.0.1` / `localhost` ✓）并保留 token 兜底 ✓。

## 新增（诊断）

- **源码态事件序列记录器**：记录 `window.focus/blur`、`visibilitychange`、`active-leaf-change`，
  并**逐块**报出「预览 n／源码 m（共 k）」（判据 = 该块含不含 `.ijipu-score` ✓）；
  结果进「生成完整诊断报告」✓。
  > 用途：排查"代码块闪回预览"这类问题 ✓。经你实测判定：**该现象属 Obsidian 焦点行为、非插件问题** ⇒ 不改 ✓。

## 未完成（如实说明）

- **`playback.play/stop` 未接线**：应用侧「播放无头化」第一步（`src/playback/headless.ts` ✓）已完成，
  第②③步见应用仓库 `docs/HANDOVER-CLI-AND-COMMAND-API.md` ✓；此前 `capabilities.audio = false` ✓、**不谎报** ✓。
- **A·P3 桌面端隐藏窗口渲染**（CLI 导出 PNG/PDF/WAV）待实现 ✓（需桌面构建 + 图形环境 ✓，
  8 项验证清单见应用仓库 `docs/CLI.md` §七之二 ✓）。

## 验证

- `npx tsc -noEmit -skipLibCheck` 0 错；`npm run smoke` **387 passed, 0 failed**
  （含 `adj733`：**嵌入版产物版本 == 应用 `APP_VERSION`** ✓ —— 本版正是靠它确认"重新 embed"确实生效 ✓）；
- 发布后终验：CI 产物与本地同提交重建**逐字节比对** → 装进用户库 → `gh attestation verify` ✓。
