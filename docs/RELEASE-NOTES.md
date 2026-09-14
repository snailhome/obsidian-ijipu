<!-- 本文件只保留**当前版本**的更新记录；历史版本见 docs/RELEASE-NOTES-ARCHIVE.md。
     GitHub Release 正文由 scripts/release-body.mjs 从本文件截取当前版本。

     发版流程（每次）：
     1) 写本节（H1 必须形如 `# 爱记谱 iJipu <manifest.json 的 version>`，脚本按版本号定位）；
     2) 把**上一版**的内容整段移到 docs/RELEASE-NOTES-ARCHIVE.md（本文件只留当前版本）；
     3) 同步 manifest.json / package.json / versions.json（+ package-lock.json）的版本号；
     4) 提交 → 打 tag → 推送；CI 会用 release-body.md（只含当前版本）作为 Release 正文。 -->

# 爱记谱 iJipu 0.7.1

> 本版修移动端「**切到源码后窗格缩两次、还填不满窗口**」——手机上一打开源码编辑，
> 键盘弹出缩一次、紧接着又缩一次，而且缩完之后并没有占满可用高度。
> 根因是两套尺寸机制在打架：视图容器自己会滚（`height:100%` + `overflow:auto`），
> 源码框又写死了 `min-height: 240px`；键盘/移动端工具栏先后改变可用高度时，
> 两者叠加就表现为"缩两次"，且收缩后不等于"窗口剩余高度"。
> 现已改为：**源码框永远等于窗口剩余高度**，容器自己不再滚动。

## 修复：`✎ 源码` 窗格缩两次、不填满窗口（adj402）

- **现象**（用户反馈，移动端）：在 `.jps` 文件视图里点「✎ 源码」——输入法刚打开时源码窗格先变小，
  接着**又进一步缩小**；后一次缩小没有必要，且窗格没有占满可用空间。
- **根因**：`.ijipu-file-view` 用 `height:100%` + `overflow:auto`（自己会滚动），
  `.ijipu-source-editor` 又写了 `flex:1 1 auto` + `min-height:240px`（硬下限）。
  可用高度被键盘改变时，容器滚动与内容收缩两套机制叠加，于是出现二次缩小，
  且 `240px` 下限让窗格在矮视口下不再等于"剩余高度"。
- **修复**：
  1. 视图容器 `flex` 列 + `min-height:0` + `box-sizing:border-box`——允许随父级一起收缩；
  2. 源码态给容器加 `.ijipu-file-editing` → 容器**不自己滚动**（`overflow:hidden`），滚动交给源码框，
     避免两套机制叠加；
  3. 源码框去掉 `240px` 硬下限（`min-height:0`）+ `flex:1`——**永远等于窗口剩余高度**；
     桌面端仍保留 `resize: vertical` 手动拉高。
- **顺带**：文件级工具条固定为 `flex:0 0 auto`，不会被源码框挤压换行。

## 验证

- 插件 `npm run smoke` 新增 **4 条断言**（第 12 节：容器 `height:100%+min-height:0+border-box`、
  源码态容器 `overflow:hidden`、源码框无 `240px` 硬下限且 `flex:1`、`fileView.ts` 确实加了
  `.ijipu-file-editing` 类）——**共 112 项全绿**，用来防止"以后又把 240px 加回来 / 忘了加类"
  （这种回归在桌面端看不出来，只有手机上才暴露）。
- `tsc -noEmit -skipLibCheck` + `npm run build` 通过；`main.js` 为构建产物、不入库。
- 引擎未变动（本版只改插件侧 CSS/视图），因此 `vendor/engine` 与 0.7.0 一致。

<!-- 未发布（测试中，真机确认后再定版本号并挪到上面当版）：
     adj404 源码框按 visualViewport 定高——真机上 WebView（随键盘缩布局视口）与 Obsidian
     （`body.is-mobile .app-container { max-height: calc(100vh - var(--keyboard-height)) }`）
     双重扣减 → 源码框比可视区矮一个键盘高；`keyboard-animating` 期间先不扣、动画结束才扣，
     即"缩两次"来源。修法：fitEditorToVisibleArea() 按 visualViewport 实测把容器钉到可视区，
     必要时临时解除 .app-container 的 max-height（切走/关闭全部还原），仅 Platform.isMobile 挂载。
     验证：smoke 新增 2 条断言（共 114 项全绿）；tsc -noEmit + build 通过。 -->
