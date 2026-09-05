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
