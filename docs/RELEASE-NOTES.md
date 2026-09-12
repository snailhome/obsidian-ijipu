<!-- 本文件只保留**当前版本**的更新记录；历史版本见 docs/RELEASE-NOTES-ARCHIVE.md。
     GitHub Release 正文由 scripts/release-body.mjs 从本文件截取当前版本。

     发版流程（每次）：
     1) 写本节（H1 必须形如 `# 爱记谱 iJipu <manifest.json 的 version>`，脚本按版本号定位）；
     2) 把**上一版**的内容整段移到 docs/RELEASE-NOTES-ARCHIVE.md（本文件只留当前版本）；
     3) 同步 manifest.json / package.json / versions.json（+ package-lock.json）的版本号；
     4) 提交 → 打 tag → 推送；CI 会用 release-body.md（只含当前版本）作为 Release 正文。 -->

# 爱记谱 iJipu 0.4.0

> 本版是插件的一次**功能级**更新（0.3.15 → 0.4.0）：`.jps` 成为一等公民（专用文件视图 + `![[x.jps]]` 嵌入）、
> 谱面内新增「排版」（可拖辅助虚线）与「设置」对话框并支持写回曲谱、frontmatter 覆盖修复与键名一键复制，
> 并同步引擎到 adj-font（设置分层：编辑器偏好移出谱面 / `# jps-config` 差量写入 / 字体策略）。

## 引擎同步 adj-font：设置分层（编辑器偏好移出谱面 / 差量写入 / 字体策略）

- 同步 `@ijipu/engine`（`types.ts` / `settings.ts` / `index.ts` + 新增 `fonts.ts`，逐字节一致）：
  - **编辑器偏好移出谱面级**：`PageConfig` 删除 `editorFont/editorFontSize`；读取白名单同时过滤这两个键（旧谱里已写入的值不再生效）。插件侧把它们归入「**已不再随谱保存**」并给专门提示（`ijipu_editorFont*` 不再算"未识别键"）。编辑器字体/字号请在**插件设置**里调（本机偏好）。
  - **`# jps-config` 差量写入**：只写与默认值不同的字段（无差量不写/删除该行）；插件「设置」对话框新增「**固化全部到谱面**」（`mode:'full'`）用于分享/存档。
  - **字体策略**：插件设置里的字体候选改由引擎 `SCORE_FONT_OPTIONS` 统一提供——**每项都是含通用族的完整栈**，旧的裸字体名（`SimSun`、`KaiTi`…）在读取时经 `normalizeFontStack` 自动补 `serif`/`sans-serif`/`monospace`。
- 分层原则（`L0 默认 < L1 用户个性 < L1.5 笔记级 < L2 谱面级`）见主项目 `docs/SETTINGS-AUDIT.md` 与 `AGENTS.md` 七；插件这边对应关系：**L1 = 插件设置/本机缓存**，**L1.5 = 笔记 frontmatter**，**L2 = 源码 `# jps-config`**。

## 新增：`.jps` 文件识别 + 链接/嵌入（`![[xxx.jps]]`）

- **`.jps` 成为一等公民**：新增 `.jps` 文件视图（`src/fileView.ts`，`registerView` + `registerExtensions(['jps'], …)`）。
  - 文件树双击、`[[我的谱.jps]]` 链接 → 用**简谱视图**打开（不再提示"无法打开该文件"）：渲染谱面 + 试听 + 显示模式 + 排版；
  - 工具栏「✎ 源码」可切到纯文本编辑（textarea，输入停 600ms 自动保存，`Ctrl+S` 立即保存）——谱面报语法错误时可直接改源码；
  - 视图内容即 `# jps-config` 所在的那份文件，「排版 → 保存到谱面」**直接改写该 .jps 文件**。
- **`![[我的谱.jps]]` 嵌入**：新增嵌入处理器（`src/embed.ts`）。Obsidian 若已用 .jps 视图渲染嵌入则不重复渲染（先标记 + 延迟 100ms 确认），否则自己 `cachedRead` 后用同一面板内联渲染（紧凑形态）。链接写法支持 `#子标题`/`|别名`（`jpsLinkpath` 纯函数已加断言）；文件不存在时原位提示"找不到谱面文件"。
- 三种入口（代码块 / 文件视图 / 嵌入）共用同一个渲染面板 `src/scorePane.ts`（试听色块、显示模式、来源徽标、排版、设置变更重渲染全部一致），避免各写一份漂移。

## 新增：谱面内「排版」＝排版辅助虚线（可拖动调版面）

- **「排版」按钮（田字格图标，与 iJipu 顶栏同一形状）＝ 显示/隐藏排版辅助虚线**，与 iJipu 语义一致（此前误解为"打开设置对话框"，已纠正）。
- **拖动虚线直接调版面**：四边距（上/下/左/右）、描述头区下沿线（`descAreaH`）、第 1 行曲部线（`body_margin_top`）、多声部第 2+ 声部行线（`height_shengbu`）、其他曲部行线（上一行有歌词 → `height_ciqu_lyric`，否则 `height_ciqu`）、歌词行线（第 1 行 `height_quci`、后续行 `height_cici`）——判定规则与 iJipu 预览层**同一套**。
- 拖拽语义与 iJipu 相同：**拖动中只预览（不落盘），松手即写入该谱源码的 `# jps-config` 行**（代码块写回笔记正文、文件/嵌入写回 `.jps`），并弹 Notice 显示保存的字段与新值。
- 开启时若当前是「谱面」视图会自动切到「整页」（否则边距线在裁剪区外看不见），关闭时恢复原视图；虚线层为绝对定位覆盖层，命中热区加宽 ±3px，描述头中线为纯标注（不可拖）。
- 新增纯逻辑模块 `src/guides.ts`（`computeGuideLines` / `cropRectFor` / `guideLimits` / `guidePlacement`，零 Obsidian 依赖），直接复用引擎的 `computeRowGuides`/`metaAreaH`/`dragDelta`/`clamp`/`GUIDE_LIMITS*`，兼容三种显示模式（按裁剪框换算百分比与拖拽比例）；`render.ts` 新增 `renderScoreFull`（同时返回 layout，虚线几何需要）。

## 新增：谱面内「设置」对话框（页面设置，改这一份谱并写回源码）

- 原「排版」按钮的对话框独立为**「设置」**（图标 = 三滑杆，`src/icons.ts` 的 `settingsIcon`）：与 iJipu 排版对话框同构的四组字段（页面/字体/行距/渲染），字段与控件**与设置面板共用一份定义**（`src/defs.ts` 的 `DEFS` + `addConfigControl`），用于设置**不可拖动**的项（字体、字号、渲染开关等）。
- 保存去向两条：
  - 「**保存到谱面**」（主）：用引擎 `writeJpsConfig` 写回**当前曲谱**源码的 `# jps-config` 行——代码块写回笔记正文（优先 `editor.replaceRange` 保留撤销栈，阅读模式回退 `vault.process` 整文件事务写，纯函数 `replaceCodeBlockBody` 已加断言），文件/嵌入写回 `.jps` 文件；
  - 「保存为插件默认」（次）：只把对话框里编辑的字段写入插件设置（全局默认）；
  - 另有「恢复默认」「取消」（取消不改任何东西）。

## 新增：直接复用 iJipu 的谱面设置（`# jps-config`），复制 .jps 即渲染一致

- **谱面源码内的 `# jps-config:{...}` 行现在是最高优先级**：`引擎默认 < 插件设置 < 笔记 frontmatter < 谱面自带设置`。iJipu 点「保存设置」时用 `writeJpsConfig` 把**整份**配置（实测 30 个字段：纸张/四边距/各字体栈/各字号/行距/`noteSpaceLayout`/`lianyinxian_type`/`metaPos`/`editorFont*`）写进源码那一行，因此**把 iJipu 里的 .jps 直接粘进 Obsidian 代码块，排版与 iJipu 一致**；插件设置与 frontmatter 只对**源内没写的键**生效（手写的最小设置行同样支持）。
- 新增纯逻辑模块 `src/config.ts` 的 `resolvePageConfig(source, settings, frontmatter)`：复用引擎 `mergeJpsConfig`（其语义正好是"默认 < 兜底 < 源内"），并回报源内生效字段数供界面显示。
- 谱面工具栏新增来源徽标：绿色「**谱面自带设置 N 项**」（悬停列出每个字段的生效值）与「**frontmatter 覆盖 N 项**」（标题注明"只对谱面未自带设置的键生效"）。
- 设置面板新增「**设置优先级（源内最高）**」说明行，并把面板文案改为"全局默认（谱面未自带设置时生效）"。

## 修复（引擎，需与主项目同步）：`# jps-config` 往返丢 `showInstrument`

- `extractJpsConfig` 的字段白名单 = `Object.keys(defaultPageConfig)` + 手工补的几项，而 `showInstrument`（「显示乐器名」）既是可选字段（不在 `defaultPageConfig` 对象上）又没被补进白名单 → 实测**写入 30 个字段、读回只剩 29**，保存设置后重开就丢。
- 现把可选字段抽成 `OPTIONAL_CONFIG_FIELDS` 常量（补齐 `showInstrument`），并加**编译期完整性断言**：引擎以后新增可选字段而不更新常量时 `tsc` 直接报错，从机制上杜绝"白名单靠人工补"的漏项。
- `vendor/engine/settings.ts` 与主项目 `packages/ijipu-engine/src/engine/settings.ts` 保持逐字节一致（adj382）。

## 修复：frontmatter 覆盖失效 / 键名写法兼容 / 未识别键不再静默忽略

- **可选字段的键此前被静默忽略（这是"设置了没生效"的主因）**：引擎 `defaultPageConfig` 只含 28 个"有默认值"的字段，而 `lyricShrink` / `showInstrument`（正是设置面板里的两项）等 6 个**可选字段**不在其中。原实现按 `ijipu_<字段名>` 去 `defaultPageConfig` 查表，于是 `ijipu_showInstrument: true`、`ijipu_lyricShrink: true` 被判成"未识别键"**直接丢弃**。现显式列出 `PageConfig` 全部 **34 个字段**，并加**编译期完整性断言**（引擎增删字段时 `tsc` 直接报错提醒同步）。
- **键名写法兼容**：比较键名时去掉下划线/连字符并统一小写 → `ijipu_note_size`、`ijipu_noteSize`、`ijipu_note_space_layout`、`IJIPU_NOTE_SIZE` 都能识别（此前按 README 旧示例写的 `ijipu_note_space_layout` / `ijipu_show_instrument` / `ijipu_paper` 全部无效，README 示例已同步修正）。
- **值按字段类型转换**：Properties 面板常把数字存成字符串、布尔写成中文或 0/1，现统一转换（`"15"`→15、`是`→true、`否`→false）；空值/无法转换的值视为"未设置"回落默认，且不计入"已生效"（避免徽标虚报）。
- **改动即时生效**：谱面改为 `MarkdownRenderChild`，监听 `metadataCache.on('changed')` 与插件设置变更 → 改 frontmatter（Properties 面板或 YAML）或改设置面板后**立刻重渲染**，重渲染时自动停止进行中的试听并清空 DOM（此前必须重开笔记，这也是"设置好像没生效"的常见观感）。
- **不再静默失效**：谱面工具栏显示「**frontmatter 覆盖 N 项**」徽标（悬停列出每个键与值）；无法识别的 `ijipu_*` 键在谱面下方提示并给出**最近键名建议**（`ijipu_paper` → "是否想写 ijipu_page？"）。

## 新增：frontmatter 键名一键复制

- 设置面板每项下方的键名（如 `ijipu_note_size`）**点击即复制**（支持键盘 Enter/Space，悬停提示，复制后弹 Notice 确认）。
- 面板顶部新增「**复制全部键名**」（34 个键，每行一个）与「**复制 frontmatter 模板**」（带当前生效值的 YAML + 分组注释，可直接粘贴到笔记顶部 `---` 之间）。
- 剪贴板优先 Clipboard API，失败回退 `execCommand`（桌面/移动端均可用）。

## 引擎同步 adj381：试听末音符后的增时线没有色块

- 同步 `@ijipu/engine`（`vendor/engine/playback/index.ts`）：`schedulePlay` 的 `totalMs` 改为取**所有事件尾端**（`atMs + durationMs`）的最大值 + 100ms 余量 + 准备延迟。此前只取末事件**起声时刻**，末音符时值跨多拍（如末尾 `6,---` 共 4 拍）时，收尾定时器在该音符刚起声就把色块轨道清空 → **末音符后面的增时线永远没有色块**，且显示总时长与实播时长不一致。与主项目 0.12.18 同步。

## 验证

- 新增 `npm run smoke`（esbuild 打包 `scripts/smoke-frontmatter.mts` → `dist-smoke/`，node 执行）：**99 项断言全绿**，覆盖键名写法兼容、值类型转换、可选字段识别、未识别键建议、优先级、字段表完整性（含"引擎全部 34 个字段都能被同名键命中"）、**源内 `# jps-config` 优先级**（源内 > frontmatter > 插件设置、部分设置行、以及"插件解析结果与 iJipu 源内配置逐字段一致"的端到端核对）、**写回源码的纯函数**（代码块正文替换保持围栏/区间非法原样返回/CRLF 归一、`jpsLinkpath` 链接解析）、**排版辅助虚线几何**（四边距/描述头/行线/词线的位置与 key、可调范围、三种显示模式的裁剪框与百分比定位、拖拽换算自洽），以及**设置分层**（编辑器偏好归入"已不再随谱保存"而非未识别、差量写入只含非默认项、全默认不写设置行、旧裸字体名自动补 fallback）。
- `npm run build`（`tsc -noEmit -skipLibCheck` + esbuild production）通过；产物 `main.js` 已确认含新逻辑（`MarkdownRenderChild` + `metadataCache.on('changed')`、覆盖徽标、未识别提示、键名复制）。

---
