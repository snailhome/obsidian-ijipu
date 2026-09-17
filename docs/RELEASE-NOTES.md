<!-- 本文件只保留**当前版本**的更新记录；历史版本见 docs/RELEASE-NOTES-ARCHIVE.md。
     GitHub Release 正文由 scripts/release-body.mjs 从本文件截取当前版本。

     发版流程（每次）：
     1) 写本节（H1 必须形如 `# 爱记谱 iJipu <manifest.json 的 version>`，脚本按版本号定位）；
     2) 把**上一版**的内容整段移到 docs/RELEASE-NOTES-ARCHIVE.md（本文件只留当前版本）；
     3) 同步 manifest.json / package.json / versions.json（+ package-lock.json）的版本号；
     4) 提交 → 打 tag → 推送；CI 会用 release-body.md（只含当前版本）作为 Release 正文。 -->

# 爱记谱 iJipu 0.10.0

> 本版有两件事：**工具条图标换用与应用同源的成套图形**（不再"照着应用手绘"），
> 以及随 `@ijipu/engine`（0.13.0 → **0.13.1**）同步的**谱面修饰符换矢量图**。
> 插件侧**不需要改笔记里的任何写法**——语法与语义零变化，只是"画出来的样子"变了。

## 改进：工具条图标与 iJipu 应用完全同源

- **试听 / 排版 / 设置 / 谱面 / 满宽 / 整页**六个按钮改用应用 `public/icons/` 里的**同一批 PNG**
  （取「试听→播放、排版→排版、设置→设置、谱面→谱面、满宽→页宽、整页→整页」；试听中切换的「停止」
  也一并换成同套图，避免一个按钮两种笔画粗细）。
- **不再"照着应用手绘一套"**：此前 `src/icons.ts` 手绘内联 SVG 来对齐应用，两边各画一份必然漂移
  （本插件历史上就为对齐应用把「页面设置」从滑杆改成齿轮、线宽 1.4 提到 1.8）。现在直接用同一份图，
  且与应用**逐字节一致**（同步进 `vendor/icons/`）。
- **颜色随主题自动跟随**：只取 PNG 的 **alpha 通道**当形状，颜色交给 CSS
  （`background-color: currentColor` + `mask`）——亮/暗主题、悬停、以及「排版」按钮的
  选中态（强调色底）**全部自动同色**，不需要为深色主题另备一套图，也不会"黑线稿铺在深色底上隐形"。

## 引擎同步：谱面里的波音 / 滑音 / 延长记号改为矢量图

- 七枚符号（`&sby`/`&xby`/`&sby+`/`&xby+` 波音、`&shy`/`&xhy` 滑音、`&yc` 延长记号）从引擎此前手绘的
  矢量近似，改为**内联用户提供的 SVG 路径**——既是设计者给的原始图形，又保住**无损矢量**
  （导出/打印放大不糊）。
- 尺寸沿用既有占位口径（波音 9s/13.5s、延长记号 9.6s、滑音按高度贴合），**排版不会位移**；
  `docs/SYNTAX.md` 的语法说明**无需改动**（语义没变，只是图形换了）。

## 自包含性未变（发布物仍是三个文件）

- 图标在**构建期内联成 base64 data URI** 编进 `main.js`：发布物依旧只有
  `main.js` / `manifest.json` / `styles.css`，**不带任何图标目录**（社区发布与 `copy2ob.bat` 都只拷这三个）。
- `esbuild.config.mjs` 增加 `png-dataurl` 插件、`vite.config.ts` 设 `assetsInlineLimit`；
  新增 `src/assets.d.ts` 声明 `*.png` 导入到的是 data URI 而非文件路径。

## 验证

- 插件 `npx tsc -noEmit -skipLibCheck` 通过；`npm run build` 通过；`npm run smoke`：**149 项全绿**。
- `vendor/engine` 与 iJipu 引擎**逐文件哈希一致**（33 个文件，含新增/删除两侧核对，差异为 0）。
- `main.js` 逐项核对：**7 枚图标与 `vendor/icons/` 的 data URI 完全一致**、`data:image/png;base64,`
  恰好 7 处、**无任何运行时图标路径残留**。
- 应用侧同批（v0.23.0）：`smoke` **0 失败**、`preview:render` 7 谱 errors=0；
  无头 Chrome 3 倍/9 倍截图逐符号肉眼核对修饰符形态。
