# 爱记谱 iJipu 0.34.2

> **本版是针对社区审核结果的修复版**（PATCH）：0.34.1 的审核判定 **Failed**，
> **唯一 Error** 是本插件自己写的一处**内联样式** ✗ —— 本版按审核给的出路改掉，
> 并把"审核 Error 级规则"落成**自动加载的规范 + 机器闸门**（见下）。
> 0.34.1 → **0.34.2**。**既有谱面与 `.jps` 语法零改动**；引擎与应用仓库本周期未改动。

## 审核 Error：`obsidianmd/no-static-styles-assignment`

- **现象**：审核报告 **Failed**，Source code → Error 指向
  `src/scorePane.ts:790 / 793 / 794` —— 那是 0.34.1 新写的"工具条外侧落位"里
  `el.style.setProperty('position' | 'left' | 'top' | 'bottom' | 'z-index')` ✗。
- **修法**（按审核原文给的三条出路）：
  · **定位与层级交给 CSS 类** `.ijipu-score-toolbar.ijipu-ported`
    （`position: fixed; left: var(--ijipu-port-x); top: var(--ijipu-port-y); bottom: auto; z-index: 40`）；
  · **动态坐标用 `el.setCssProps({ '--ijipu-port-x': …, '--ijipu-port-y': … })`**
    —— 这是 Obsidian 认可的动态值写法 ✓；
  · 收起/搬回容器时 `removeClass('ijipu-ported')` 并清空这两个自定义属性 ✓。
- **行为不变**：外侧落位、跟随滚动/尺寸变化、进视界显示 + 3 秒倒计时、离开视界隐藏，全部与 0.34.1 一致 ✓。

## 新增：审核 Error 级规则的**规范 + 闸门**（用户要求）

用户原话：「**这个问题多次出现，请写进 AGENTS，作为一条规则进行规范**」⇒ 已写入 `ijipu/AGENTS.md` **§六之四**，
按项目"元规则"同时给出 **① 自动加载的规范** 与 **② 机器闸门**：

1. **禁直接写内联样式**（`el.style.x = …`、`el.style.setProperty(…)`、`style.cssText = …`）；
   只允许 **CSS 类**（首选）/ **`setCssProps`** / **`setCssStyles`**；`removeProperty`（摘属性）未被判，但**赋值**一律禁止；
   唯一例外是"循环里的动态键"（`for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v)`，
   键是变量、规则判不了"静态"），新增此类写法必须在注释里写明理由；
2. **同类 Error/Warning 一览表**（内联样式 / `!important` / `innerHTML` / `console.*` /
   `import 'node:*'`（静态导入是刻意的，附原因）/ `fetch` / `getSettingDefinitions()` / Build verification）；
3. **发布前"审核预检"三步**：`smoke` 全绿 → 人工过 Error 行 → 结果记 `docs/ERRORS-LOG.md` 并把能自动化的落成闸门。

**机器闸门**：插件 `npm run smoke` 新增 **`adj799`** —— 扫描 `src/**/*.ts`
（排除 `src/gen/**` 生成物与 `vendor/**`），任何"内联样式赋值"即红灯，并在失败信息里列出**文件:行号**；
带**负对照**（去掉类那一行即判假）。

## 附：审核其余条目的口径（本版未改，均为已知/刻意的）

- `import 'node:http'` / `'node:crypto'`（Warning）：**静态导入是刻意的** —— 本插件以 CJS 打包且把
  `node:*` 列为 external，动态 `import('node:http')` 在渲染进程会退化成浏览器模块请求而**直接失败** ✗
  （0.34.0 曾因此出现「Failed to fetch dynamically imported module: node:http」）；
  手机端安全由**调用方**保证：`./embed/server` 只在 `Platform.isDesktopApp` 时被动态加载 ✓。
- `fetch`（Warning）：已知豁免 —— 音色库下载与嵌入版本地服务（固定端口 47821，仅本机回环）。
- `!important`：**0 处**（闸门 `adj772`）。
- Build verification（Warning）：表示"审核方重建产物 ≠ Release 产物"。本仓库按同一提交重建后
  与 CI 产物**逐字节一致**（0.34.1 实测 `FA4E68F2…`），差异来自重建环境（Node/依赖版本）。

## 验证

- `npx tsc -noEmit -skipLibCheck` 0 错；`npm run smoke` **384 passed, 0 failed**；`npm run build` 正常；
- `node scripts/release-body.mjs` 命中当版 `# 爱记谱 iJipu 0.34.2`；
- `vendor/engine` 与应用引擎**逐文件哈希一致**（46 文件，差异 0）；`adj733` 嵌入版版本闸门通过（v0.51.2）；
- 发布后终验：CI 产物与本地同提交重建**逐字节比对**，并把 CI 产物装进用户库 + `gh attestation verify`。
