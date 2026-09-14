<!-- 本文件只保留**当前版本**的更新记录；历史版本见 docs/RELEASE-NOTES-ARCHIVE.md。
     GitHub Release 正文由 scripts/release-body.mjs 从本文件截取当前版本。

     发版流程（每次）：
     1) 写本节（H1 必须形如 `# 爱记谱 iJipu <manifest.json 的 version>`，脚本按版本号定位）；
     2) 把**上一版**的内容整段移到 docs/RELEASE-NOTES-ARCHIVE.md（本文件只留当前版本）；
     3) 同步 manifest.json / package.json / versions.json（+ package-lock.json）的版本号；
     4) 提交 → 打 tag → 推送；CI 会用 release-body.md（只含当前版本）作为 Release 正文。 -->

# 爱记谱 iJipu 0.7.2

> 本版修移动端「**点「✎ 源码」后，源码框下方空出一大截（约一个键盘的高度）**」——
> 输入法弹出后源码框没有填满可视区，看起来像"被多缩了一次"。
> 真凶**不在键盘高度上**，而在宿主的两处样式：
> ① `.workspace-leaf-content .view-content { padding-bottom: max(var(--safe-area-inset-bottom), …) }`
> —— 真机上该变量等于**键盘高**（实测 319 = `--keyboard-height`），于是容器内容盒子正好矮一个键盘高；
> ② `textarea { height: 100%; min-height: 50vh; max-height: 20vh|80vh }` —— 会盖掉"撑满"的高度赋值。
> 现在对这两处逐条用 inline + `!important` 反制，并按**实测位置**算出源码框高度（可视区底 − 源码框顶）。
> 另外设置页补上了**构建指纹**，便于判断设备上装的到底是哪一份构建。

## 修复：源码框下方空出约一个键盘的高度（adj404 / adj408 / adj409）

- **现象**（用户真机反馈，多轮复现）：输入法未打开时源码框满屏正确；一打开输入法，源码框下方空出一大截，
  空出的高度约等于一个键盘。
- **定位过程**（真机读数，非推断）：先按"视口会不会随键盘缩"两条路都试过（`visualViewport` / `min(vv, innerHeight)`），
  在用户机上视口**根本不缩**（`innerH=vvH=914`），故这条路无效；随后在源码视图里加了一行临时诊断输出
  （`appC=595`、`box=502`、`ta=119`、**`padB=319`**），一步定位：
  - `appC=595` = `914 − 319` → Obsidian 自己的容器高度**正确**（只扣一次键盘）；
  - `box=502` = 容器高度也**正确**（顶部文件头 93 + 502 = 595 = 键盘上沿）；
  - **`padB=319`** → 容器自身的 `padding-bottom` 正好等于键盘高，内容盒子因此少了一个键盘高；
  - `ta=119` → 还叠加了宿主 `textarea` 的 `height/min-height/max-height` 规则把高度赋值盖掉。
- **修复**：
  1. **反制宿主的键盘内边距**（`adj409`，真凶）：容器上 inline `padding-bottom: 8px !important`
     ——容器高度已按可视区钉好，不需要宿主那段留白；
  2. **反制宿主 textarea 规则**（`adj408`）：源码框上 inline `flex:0 0 auto` / `min-height:0` /
     `max-height:none` / `height`（按实测算）全部 `!important`，样式文件里再按类名压一层作双保险；
  3. **容器尺寸同样用 inline important 钉死**（`height` / `display:flex` / `flex-direction` /
     `overflow:hidden` / `max-height:none` / `position:relative`），不再依赖 CSS 级联；
  4. 高度**实测**：先 `height:auto` 复位 → 量源码框真实顶部 → 高度 = 可视区底 − 源码框顶 − 内边距；
  5. 键盘高度仍按双信号补偿（`min(innerHeight, visualViewport 底) − 未扣足的键盘高`），并在需要时
     临时解除 `.app-container` 的 `max-height`；切走 / 关闭 / 重画时逐条还原，不留副作用；
  6. 桌面端不挂载这套逻辑（`Platform.isMobile` 判定），行为完全不变。
- **结果**：源码框从工具条一直延伸到键盘上沿，内容填满、滚动条正常（用户真机确认）。

## 新增：设置页显示构建指纹（adj407）

- 设置页头部显示 **`版本 v0.7.2 · 构建 2026-09-14 23:48 @cc88804e · 作者 蜗牛🐌`**。
- 由 `scripts/gen-build-info.mjs` 在 `npm run build` 前生成（`src/gen/buildInfo.ts`，已 gitignore）。
- 意义：同一版本号会有多个本地构建，没有指纹就无法判断设备上装的是哪一份——本轮复测时反复踩过这个坑。

## 验证

- 用户真机逐轮读数确认：修复前 `padB=319 / ta=119`（源码框下方空一个键盘高）→ 修复后源码框填满到键盘上沿 ✓。
- 插件 `npm run smoke` **119 项全绿**（第 12 节新增 adj408 / adj409 / adj404 / adj407 共 7 条断言，
  专门钉住这几处"只在真机上暴露"的反制逻辑，防止后人顺手简化掉）。
- `tsc -noEmit -skipLibCheck` + `npm run build` 通过；`main.js` 为构建产物、不入库。
- 引擎未变动（本版只改插件侧视图逻辑与设置页），`vendor/engine` 与 0.7.1 一致。
