# 爱记谱 iJipu（未发布）

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

- 新增 `npm run smoke`（esbuild 打包 `scripts/smoke-frontmatter.mts` → `dist-smoke/`，node 执行）：**90 项断言全绿**，覆盖键名写法兼容、值类型转换、可选字段识别、未识别键建议、优先级、字段表完整性（含"引擎全部 34 个字段都能被同名键命中"）、**源内 `# jps-config` 优先级**（源内 > frontmatter > 插件设置、部分设置行、以及"插件解析结果与 iJipu 源内配置逐字段一致"的端到端核对）、**写回源码的纯函数**（代码块正文替换保持围栏/区间非法原样返回/CRLF 归一、`jpsLinkpath` 链接解析），以及**排版辅助虚线几何**（四边距/描述头/行线/词线的位置与 key、可调范围、三种显示模式的裁剪框与百分比定位、拖拽换算自洽）。
- `npm run build`（`tsc -noEmit -skipLibCheck` + esbuild production）通过；产物 `main.js` 已确认含新逻辑（`MarkdownRenderChild` + `metadataCache.on('changed')`、覆盖徽标、未识别提示、键名复制）。

---

# 爱记谱 iJipu 0.3.15

## 引擎同步 adj361：跳跃演奏无缝衔接

- 同步 `@ijipu/engine`（`vendor/engine/playback/sequence.ts`）：跳跃（反复回跳 `:|`、大反复 `&dc`/`&ds`、跳越 `&ty`、跳房子跳过）后改为**按当前播放时刻对齐**（`pendingJumpMs = lastEndMs`），修掉原先回跳后整体多等「本行布局起点 + 整行时长」、前跳把被跳过段当空档导致的**十几~几十秒延迟**；`totalMs` 改为实际播放到的时刻。

---

# 爱记谱 iJipu 0.3.14

## 引擎同步 adj359/adj360：小节跳跃（试听）按规范重写

- 同步 `@ijipu/engine`（`vendor/engine/playback/sequence.ts`）：
  - **跳房子**：段内 `:|` 个数决定总遍数；volta 番号 = 遍次，非本遍的房子跳过；`:|]["2."` 同一根线正确处理。
  - **段落反复**：无 `|:` 时**默认从头反复**。
  - **大反复**：`&dc` 从头、`&ds` 跳到花 S（`&hs`）之后，各**只跳一次**（原先 `&dc` 会死循环、`&ds` 找不到花 S）。
  - **跳越 `&ty`**：第一次忽略，大反复之后才跳两 `&ty` 之间。
  - **`&fine`**：乐曲含 `&dc`/`&ds` 时仅在大反复之后生效。
  - **未封闭房子 `|]/`**：延续到其后第一个 `:|` 或 `||` 处（房子内后段一并跳过）。

---

# 爱记谱 iJipu 0.3.13

## 引擎同步 adj358：导出按音符乐器发 Program Change

- 同步 `@ijipu/engine`（`vendor/engine/playback/midi.ts`）：`eventsToMidi` 改为**每个音符记录 program**、在乐器变化处插入 Program Change（原先每声部只取第一个音符的音色、每轨只发一次），使导出 MIDI/音频的曲内 `@乐器名` 切换与 `@@` 回默认生效。

---

# 爱记谱 iJipu 0.3.12

## 引擎同步 adj357：临时节拍显示优化 + adj355/356 对齐&跳房子

- 同步 `@ijipu/engine`（`vendor/engine/render` + `layout`）：
  - **临时节拍 `"p:2/4"`**：字体改为音符字体、字号与音符一致、加粗；分数高度压缩为字号的 2/3；**空间优先路径补预留宽度**（原未算上，分数会压到下一音符）。
  - **空间优先自然宽行小节宽对齐上一行**（adj355）、**跳房子 `[-` 降低线**（adj356）——此前 0.3.11 已附带，此处一并随版本归档。

---

# 爱记谱 iJipu 0.3.11

## 引擎同步 adj355：空间优先自然宽行小节宽对齐上一行

- 同步 `@ijipu/engine`（`vendor/engine/layout/index.ts`）：空间优先布局下，自然宽行（行小节数 < `align_min_bars`）各小节若自然宽小于上一行对应小节宽，则扩到上一行宽度，小节内音符按空间布局摊开，避免末行窄小节与上一行小节线纵向错位。
- **跨组对齐**：小节宽引用跨组共享，使多行谱的后一行（自然宽）对齐前一行的对应小节（如两行谱第 2 行前两小节不再仅约第 1 行的一半宽）。

---

# 爱记谱 iJipu 0.3.10

## 引擎同步 adj354：`@@` 显示音色名与播放端一致

- 同步 `@ijipu/engine`（`vendor/engine/layout/index.ts`）：`layoutScore` 新增可选 `defaultInstrumentRef`，`@@`（切回默认）后的音符标注取默认音色名（有 `Y:`→该声部 `Y:` 乐器名；无 `Y:`→传入默认/第一音色库第一音色），不再固定显示"钢琴"。
- 插件无"收藏音色"概念，`layoutScore` 不传 `defaultInstrumentRef` → 无 `Y:` 时 `@@` 标注为第一音色库第一音色（钢琴），行为不变。

---

# 爱记谱 iJipu 0.3.9

## 引擎同步 adj354：`@@` 恢复默认音色 = 第一音色 + 单声部空间优先尊重 `align_min_bars`

- 同步 `@ijipu/engine`（`vendor/engine`）至 adj354：`buildPlaySequence` 新增可选 `defaultInstrumentRef`（`@@` 无 `Y:` 时取第一启用音色，否则第一音色库第一音色）；单声部空间优先 `barCount < align_min_bars` 时按自然宽排布（不撑满、末线不钳制）；多附点占宽按附点数计。
- 试听导出回调无需改——`buildPlaySequence` 新参数可选，缺省行为不变（有 `Y:` 用 `Y:`，无则回退第一音色库第一音色）。

## 发布流程不再附带 spessasynth_processor.min.js

- 自 0.3.7 起 worklet 已内联进 `main.js`（esbuild text loader），插件目录无需再单独放 `spessasynth_processor.min.js`。
- 现把 Release 产物的 `files` 列表同步为 `main.js` / `manifest.json` / `styles.css` 三项，**不再附带** `spessasynth_processor.min.js`（附件本就冗余，且易让人误以为还需要把它放进插件目录）。
- 试听失败时若弹出"未找到内置 SpessaSynth worklet"，那是构建/分发异常（worklet 没正确内联进 `main.js`），不是插件目录缺文件——按"请重新构建并更新插件"处理即可。

---

# 爱记谱 iJipu 0.3.8

## 统一构建为 esbuild（修复 vite MISSING_EXPORT）

- 之前 `npm run build` 走 **vite/rolldown**，把 `spessasynth_processor.min.js` 当 JS 模块找 default export → `[MISSING_EXPORT] "default" is not exported by "spessasynth_processor.min.js"`。
- 现把 `package.json` 的 `dev`/`build` 改为 **esbuild**：
  - `build` = `tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`（esbuild 的 text loader 把 worklet 内联进 main.js）
  - `dev` = `tsc -noEmit -skipLibCheck && node esbuild.config.mjs`（watch）
- 此后统一用 esbuild 构建，产出单一 `main.js`（含内嵌 worklet）。

---

# 爱记谱 iJipu 0.3.7

## worklet 内嵌进 main.js（不再需要插件目录单独文件）

- 之前的做法要读取插件目录的 `spessasynth_processor.min.js`，装后若没该文件就报「未找到内置 worklet」。
- 现改为：**esbuild 把 worklet 内容以文本内联进 `main.js`**，运行时用 Blob URL 加载——**插件只要 `main.js` 一个文件即可试听**，不再依赖单独的 worklet 文件。
- 重新构建：`node esbuild.config.mjs production`，用新 `main.js` 替换即可（`spessasynth_processor.min.js` 可不放插件目录）。

---

# 爱记谱 iJipu 0.3.6

## 发布产物包含 worklet + 单一 main.js

- **修复**：GitHub Actions 发布产物此前只含 `main.js/manifest.json/styles.css`，**不含 `spessasynth_processor.min.js`**（用户安装后插件目录无 worklet → 试听无声）。现发布流程：
  - 用 `node esbuild.config.mjs production` 产出**单一 main.js**（不再用 vite 拆出 `dist-*.js` chunk，避免 `Cannot find module`）。
  - 发布 `files` 追加 **`spessasynth_processor.min.js`**（worklet）。
- 安装后请确认插件目录含 `main.js` + `spessasynth_processor.min.js`。

---

# 爱记谱 iJipu 0.3.5

## 修复构建失败（BigInt target 过旧）

- esbuild 构建目标由 `es2018` 提升到 **`es2020`**（`spessasynth_core` 用到 BigInt，`es2018` 不支持导致 `node esbuild.config.mjs production` 报 `Big integer literals are not available`）。Obsidian/Electron 全程支持 ES2020，不受影响。

---

# 爱记谱 iJipu 0.3.4

## 修复试听无声（Cannot find module dist-*.js）

- **根因**：`spessasynth_lib` 用动态 `import()` 拆出了独立 chunk（`dist-*.js`），而 Obsidian 插件目录只有 `main.js`，缺少该 chunk → 试听时报 `Cannot find module '.../dist-CwEozVpz.js'` 而无声。
- **修复**：`spessasynth_lib` 改为**静态 import**，打包进 `main.js` 单文件（不再拆 chunk），无需额外 `dist-*.js`。
- **请重新构建**（本机）：`node esbuild.config.mjs production`，用新 `main.js` 替换插件目录旧的（并确保插件目录含 `spessasynth_processor.min.js`）。

---

# 爱记谱 iJipu 0.3.3

## 试听失败可见（定位无声问题）

- 点击「试听」若无声，现在会弹出**具体失败原因**（如：未找到内置 worklet、音源下载失败、AudioContext 不可用、谱面解析失败等），不再静默无声——便于定位。
- 排查：确保插件目录含 `spessasynth_processor.min.js`；首次试听需联网下载约 30MB 音源（可先在设置里「下载并缓存」）。

---

# 爱记谱 iJipu 0.3.2

## 音源缓存：状态判断 + 下载按钮

- 设置 → iJipu → 音色库 新增「高保真音源缓存」：实时显示**是否已缓存**（IndexedDB），并提供「下载并缓存」按钮（约 30MB），点击下载并写入缓存（之后试听直接用缓存）。

---

# 爱记谱 iJipu 0.3.1

## 音色库收藏音色改为可勾选列表

- 设置 → iJipu → 音色库 →「收藏音色」改为**可勾选列表**（GM 全集 checkbox，可滚动），勾选即试听可用音色（默认常用音色）。

---

# 爱记谱 iJipu 0.3.0

## 音色库 + SpessaSynth 高保真试听（已同步 iJipu 引擎）

- **同步 iJipu 引擎**：多声部声部乐器独立延续（adj351——Q1/Q2/Q3 各自动器、下一组同声部延续）等引擎更新。
- **音色库设置**：插件设置新增「音色库」组——默认音色（GM 全集，自动=按声部名 @乐器 / Y 默认路由）+ 收藏音色（默认常用音色，可增删）。
- **SpessaSynth 高保真试听**：试听由合成升级为 SpessaSynth（SF2 高保真通用音源 GeneralUser GS）；音源**远端下载一次 + IndexedDB 缓存**（之后直接用）；worklet 处理器随插件内置（`.obsidian/plugins/obsidian-ijipu/spessasynth_processor.min.js`）。
- 依赖：spessasynth_lib / spessasynth_core（随插件 bundle 进 main.js；需在插件目录含 worklet 文件）。

## 安装 / 使用

- 升级后首次试听会下载约 30MB 高保真音源（仅一次，之后走缓存）；安装时请确认插件目录含 `spessasynth_processor.min.js`。
- 在 Obsidian 设置 → iJipu → 音色库 配置默认音色与收藏音色。
- 完全兼容旧版（0.1.0 及以上 `.jps` 代码块无需改动）。

---

# 爱记谱 iJipu 0.2.0（独立定版）

> 0.2.0 为 obsidian-ijipu **独立版本线**的定版发布。此前的 `0.10.x` 版本号是随主机项目（iJipu 应用）对齐的历史编号，其累积更新已全部并入本版本说明，不再保留独立条目。

## 引擎同步 / 功能同步（累积）

- **adj334 音符上方单字修饰符**：新增 `&tu`（吐音→粗体 **T**）/`&ku`（吐音→粗体 **K**）/`&da`（打音→粗体 **扌**）/`&die`（叠音→粗体 **又**），写在音符后、居中显示于音符正上方（`render/index.ts` 的 `ABOVE_GLYPH`，用中文黑体栈 `FONT_CN` 粗体 + `text-anchor="middle"`）。
- **adj335 叠音「又」横向缩 3/4**：`scale(0.75,1)`，以数字槽中心为锚缩放、视觉居中。
- **adj336 新增吐音 `&ku`**：与 `&tu` 同显示方式（粗体 K，无缩放）。
- **adj338 上方修饰层专属层间留白更小**：新增 `SYM_LAYER_GAP` 仅用于音符上方符号循环（共享 `LAYER_GAP=2` 仍用于减时线/低八度点/连音线），多修饰符堆叠紧凑而不影响其它层。
- **adj321 / adj321b 连音线连接点规则**（原 0.10.2）：连音线至少连接 2 个音符。`(X)`（一个音符被 `(`开 + `)`关紧贴）且栈内还有更早未闭合连音时，X 是**连接点**——终止前一连音于 X、并以 X 为起点重新开启新连音。用例：`(1 (2) 3)` → 1→2 + 2→3（两条）；`(1(2 3))` / `(1 (2 3) 4)` 为真嵌套（内层 ≥ 2 音符，不触发连接点）。深嵌套豁免：连接点检测**不受 `depth<2`（adj91 渲染层数限制）约束**，连接点总是触发。
- **adj322 宽屏自动左右分屏 / 窄屏自动上下分屏**（原 0.10.3）：本插件视图继承自主项目 `App.tsx` 的视口驱动拆分逻辑（≤1024px = 窄屏）；本插件宿主 Obsidian 自身的 split 行为独立于主机，本版本号同步标记该主机侧特性已发布。

## 用法

完全兼容旧版（0.1.0 及以上 `.jps` 代码块无需改动）。详细见 `README.md`。

---

# 爱记谱 iJipu 0.1.0（首版）

在 Obsidian 笔记中用 ` ```jps ` 代码块把 **.jps 简谱脚本**渲染为可视化简谱（SVG），并可**试听**。渲染引擎复用 `@ijipu/engine`（与 iJipu 应用一致），设置项与 iJipu 一脉传承。

## 主要功能

- **可视化简谱渲染**：引擎支持 `.jps` 描述头、Q/C 行、修饰符、连音线、多声部、小节线 / 反复 / 跳房子
- **试听**：Web Audio 合成（SynthBackend），播放色块逐音符跟进（iJipu 同款 playheadPosOf 逻辑），多声部同时高亮
- **三种显示模式**：整页 / 满宽 / **谱面**（默认，自动消除页边距、最大化有效观看面积）
- **设置项与 iJipu 应用一脉传承**：页面 / 字体 / 行距 / 渲染 四组共 30+ 项
- **frontmatter 覆盖**：单笔记可用 `ijipu_*` 键覆盖全局默认，优先级：默认 < 全局 < frontmatter
- **插件卸载 / 切笔记自动停止试听**：避免失去控制
- **赞赏入口**：设置页「支持作者 ❤」链接到 iJipu 应用微信赞赏码

## 用法

在任意笔记写 ` ```jps ` 代码块即可：

```jps
V: 1.0
B: 两只老虎
Z: 法国童谣 词曲
D: C
P: 4/4
Q: 1 2 3 1 | 1 2 3 1 | 3 4 5 - | 3 4 5 - |
C: 两只老虎 两只老虎 跑得快 跑得快
```

详细 frontmatter 键对照表见 `README.md`。

## 链接

- [iJipu 官网](https://ijipu.pages.dev)
- [脚本规则说明](https://ijipu.pages.dev/doc/jps-spec.html)
- 引擎：[@ijipu/engine](https://github.com/snailhome/obsidian-ijipu)（vendor 内置，仓库自包含）

## 反馈

有问题请到 iJipu 官网或 GitHub Issues。
