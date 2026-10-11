# iJipu 公开 API（Obsidian 插件）—— 方案 B / B1

> 面向：**其它 Obsidian 插件、QuickAdd / Templater / DataviewJS 脚本、你自己的自动化**。
> 口径文件：`docs/CLI-AND-COMMAND-PLAN.md` §B（分层：纯 TS 能力走本 API；位图/PDF、音色库试听走 B2/B3 的嵌入版 RPC）。
> 状态：**B1 已实现**（命令面板命令 + 公开 JS API）。

## 一、能用什么（能力矩阵）

| 能力 | 本 API（B1 ✓） | 说明 |
|---|---|---|
| 解析 / 校验（错误、告警） | ✓ `lint` | 走引擎 `parseJps` + `splitParseIssues`（与预览区同一份口径） |
| 规范化源码 | ✓ `format` | 引擎 `formatJps`（与应用编辑器"格式化"逐字一致） |
| 导出 **SVG** | ✓ `renderSvg` | 每页一段 SVG 字符串；纯字符串，**移动端同样可用** |
| 生效配置 + 来源 | ✓ `effectiveConfig` | 回答"这个值来自哪一层"（命令行/源内/设置/默认） |
| 连排版结果一起拿 | ✓ `renderFull`（experimental） | 只在确有需要时用；接口可能变 |
| 导出 **MIDI** | ✗（`capabilities.midi=false`） | B3：需接播放序列导出（`eventsToMidi` 已就绪，待接线） |
| 导出 **PNG/JPG/PDF** | ✗（`rasterExport=false`） | B2/B3：需应用侧 canvas/分页 ⇒ 走嵌入版 RPC（隐藏窗口渲染） |
| **试听 / 播放** | ✗（`audioPlayback=false`） | B3：需 AudioContext + 音色库 ⇒ 嵌入版 RPC |

> **为什么"能做的不放进 RPC"**：纯 TS 能力在插件内**直调引擎**（`vendor/engine`）——无 iframe、无网络、延迟最低，
> 而且**手机端也能用**（嵌入版仅桌面）✓。

## 二、怎么拿 API 对象

```ts
// 任何插件 / 脚本里
const ijipu = (this.app as any).plugins?.plugins?.['ijipu']?.api
if (!ijipu) return                     // 插件没装/没启用
if (ijipu.apiVersion !== 1) return     // 版本不符就自行降级（见 §五）
```

- 对象是 **`Object.freeze` 过**的：调用方改不了它 ✓；
- `apiVersion`（当前 `1`）**只增不改**：破坏性变化必然 +1 ✓；
- 先看 `capabilities` 再调（别假设某个能力存在 ✓）。

## 三、方法参考

### `lint(source: string): { ok, errors, warnings }`
```ts
const r = ijipu.lint(jpsSource)
if (!r.ok) {
  for (const e of r.errors) console.log(e.text)   // 问题清单（含行号，字段由引擎定义）
}
```
- `ok === false` 表示存在**错误**（告警不阻断）；
- 不抛异常：解析失败如实反映在返回值里 ✓。

### `format(source: string): string`
```ts
const fixed = ijipu.format(jpsSource)   // 幂等：format(format(x)) === format(x)
```
只做格式化，**不改设置、不写文件** ✓（写文件由你决定 ✓）。

### `renderSvg(source, pageConfig?): { ok, svgs, error?, warnings }`
```ts
const r = ijipu.renderSvg(jpsSource)                       // 用插件当前设置 + 源内 # jps-config
const wide = ijipu.renderSvg(jpsSource, { pageMode: 'full' })  // 临时覆盖若干字段（不落盘）
if (r.ok) for (const svg of r.svgs) { /* 每页一段 <svg> */ }
else console.log(r.error)
```
- 配置解析走插件自己的 `resolvePageConfig(source, settings)`（与预览区**同一份**，禁止各算一套 ✓）；
- `pageConfig` 只**覆盖本次调用**（不写回笔记/设置 ✓）。

### `effectiveConfig(source): { config, baseline, sourceFields }`
```ts
const { config, sourceFields } = ijipu.effectiveConfig(jpsSource)
// sourceFields：这份谱**自己写了**哪些字段（即"跟着谱走"的部分）
```
用来做"把当前排版**固化进谱面**"之类的动作（配合引擎的 `mergeConfigEdits` / `writeJpsConfig`）✓。

### `renderFull(source, pageConfig?)` —— experimental
返回 `{ svgs, layout, error?, warnings, errorIssues }`。**请勿修改** `layout`；它可能在后续版本变形。

## 四、命令面板（给人用的一层）

| 命令（命令面板搜索 "iJipu"） | 作用 | 何时可用 |
|---|---|---|
| **iJipu：格式化当前谱面源码（光标所在代码块）** | 按应用规范规范化（代码块内替换；`.jps` 文件整份） | 光标在 ` ```jps ` 块内，或打开着 `.jps` |
| **iJipu：校验当前谱面（错误 / 告警）** | 弹 `Notice` 报数量与第一条 | 同上 |
| **iJipu：复制当前谱面的 SVG 源码到剪贴板** | 多页以 `<!-- 分页 -->` 连接 | 同上 |
| **iJipu：导出当前谱面为 SVG 文件（存到同目录）** | 多页写 `名字-1.svg`、`名字-2.svg`… | 同上 |
| **iJipu：打开爱记谱** | 打开嵌入版应用（原命令） | 桌面端 |
| **iJipu：格式化当前 .jps 源码（应用规范）** | 原命令（文件视图专用） | `.jps` 文件视图 |

**取源优先级**（决定了"命令对我这份谱做了什么"）：① 打开的 `.jps` 文件视图 → ② 当前编辑器里**光标所在**的
` ```jps ` 块 → ③ 当前活动文件是 `.jps`（读盘）→ ④ 都没有则命令**置灰**（不做"点了没反应"）。

## 五、兼容与版本策略

1. **`apiVersion` 语义**：属性/方法**只增**；删除或改语义 ⇒ `apiVersion + 1`；
2. 调用方写法：`if (ijipu.apiVersion !== 1) { /* 用自己的兜底路径 */ }`；
3. `capabilities` 是**能力探测**（不是版本号）：新能力先 `false`，实现了再 `true`；
4. `renderFull` 标 experimental：**不保证**跨小版本兼容。

## 六、嵌入版 RPC（方案 B / **B2**，postMessage）

> **什么时候用它**：只有"要用**应用**才有的能力"才走这条通道 ✓（位图/PDF、音色库试听 —— B3 起逐项转真）。
> 纯 TS 能力（解析 / 格式化 / 校验 / 导出 SVG）**仍然走 §三 的插件 API**（直调引擎，不绕 iframe ✓，手机端也能用 ✓）。

**协议**（插件 ⇄ 嵌入版 iframe）：
```js
// 请求（嵌入版 → 插件）
parent.postMessage({ __ijipuRpcRequest: 1, id: 1, method: 'render.svg',
                     params: { source: 'V:1.0\nQ: 1 2 3 4', pageConfig: { pageMode: 'score' } } }, '*')
// 响应（插件 → 该 iframe 窗口，只回给它 ✓）
{ __ijipuRpc: 1, id: 1, ok: true, result: { svgs: ['<svg …>'] } }
{ __ijipuRpc: 1, id: 1, ok: false, error: { code: -32601, message: '未知方法：x' } }
```

| 方法 | 参数 | 结果 |
|---|---|---|
| `engine.version` | — | `{ plugin, embedded, engine }`（三处版本，交叉校验用 ✓） |
| `capabilities` | — | `{ platform, svg, raster, pdf, midi, audio, methods }`（**未实现必须 false** ✓） |
| `render.svg` | `{ source, pageConfig? }` | `{ svgs: string[] }`（每页一段；复用插件内 `api.renderSvg` ✓，无第二份实现 ✓） |

**错误码（对外承诺）**：`-32001` 未启用 ｜ `-32601` 未知方法 ｜ `-32602` 参数非法 ｜ `-32603` 内部错误 ✓

**安全边界（写死在代码里，机器闸门 `adj808` 守着 ✓）**：
1. **总开关默认关闭**（`plugin.allowExternalApi = false` ✓，用户裁决 ③）⇒ 关着时一律回 `-32001`；
2. **来源校验**：`event.source` 必须是"src 含本插件 token 的 iframe"窗口 ✓，否则**直接忽略、不回包**（避免被探测 ✓）；
3. **方法白名单**：B2 只有上表三个 ✓（新能力做成再放，不许"先通后补" ✗）；
4. **参数逐项校验**：`source` 必须字符串且 ≤500 000 字符；`pageConfig` 必须对象（不符 ⇒ `-32602`，不做"尽力解析" ✗）；
5. **路径规则** `isSafeVaultPath()`：只允许 vault 内**相对路径**，禁绝对路径 / 盘符 / `..` / NUL ✓（B3 的 `render.png`、`export.*` 用它 ✓）。

> **开关现状**：B2 阶段是**代码层开关**（默认关 ✓）；设置界面的「开发者：允许外部调用」行在 B2 收尾补 ✓。
> 临时自测：控制台执行 `app.plugins.plugins['ijipu'].allowExternalApi = true` ✓（重载即回到关闭 ✓）。

## 六之三、协议冻结（方案 B / **B4**）

**协议版本：`1`**（`RPC_PROTOCOL_VERSION`，插件侧 `src/embed/rpc.ts` ✓；`capabilities.protocol` 会回报它 ✓）。

**冻结规则（对外承诺）**：
1. **方法只增不改**：加方法 ⇒ 直接加进白名单并在 `capabilities.methods` / `appMethods` 里出现 ✓；
2. **删方法或改语义 ⇒ 版本 +1**，且两边都要在握手时比对 ✓（不一致就**降级到双方都支持的方法** ✓，不要硬失败 ✗）；
3. **信封字段冻结**：`__ijipuRpcRequest` / `__ijipuRpc` / `__ijipuAppRequest` / `__ijipuAppResponse` / `id` / `ok` / `result` / `error.{code,message}` ✓ —— 改名一律视为破坏性变更 ✓；
4. **错误码冻结**：`-32001` 未启用 ｜ `-32601` 未知方法 ｜ `-32602` 参数非法 ｜ `-32603` 内部错误 ｜ `-32000` 应用侧不支持 ✓；
5. 机器闸门：插件冒烟 **`adj808`**（入站边界）与 **`adj810`**（应用侧边界）✓ —— 改坏任一边都会红灯 ✓。

**当前实现状态（诚实清单）**：
| 通道 | 方法 | 状态 |
|---|---|---|
| 应用 → 插件 | `engine.version` / `capabilities` / `render.svg` | ✓ 已实现（`adj807`） |
| 插件 → 应用 | `render.svg` / `render.png` / `export.midi` | ✓ 已实现（`adj809`/`adj810`/`adj811`） |
| 插件 → 应用 | `playback.play` / `playback.stop` | **未接线** —— 白名单里已留名（`APP_METHODS` ✓），但应用侧要接 audio 播放链路（AudioContext + 音色库 + 当前文档状态 ✓）⇒ 未接之前**不谎报**：`capabilities.audio = false` ✓、应用侧对未实现方法回 `-32000` 并写明原因 ✓ |

> **为什么 `playback.*` 不急着做**（2026-10 定位后的**具体**原因，不是拖延 ✓）：
> 应用侧的播放由 **`src/dialogs/PlaybackDialog.tsx`（React 对话框）** 持有 ——
> 它带着 `playbackSession.ts`（已调度 job 的单例管理 ✓）、`spessaSynthBackend`（音色库/后端就绪状态 ✓）
> 与 `docStore` 的播放态（`playbackMs` / 播放轨道 ✓）。要经 RPC 驱动它，实际上等于**驱动一个 UI 对话框**
> （会弹窗、会改界面状态 ✓）✗。
> ⇒ **前置条件是先把播放抽成无头模块**（"给一段 .jps 就出声、可停止、不依赖 React" ✓）——
> 那是一次**真实重构** ✓，不适合塞进"接一根线"里做 ✗。
> 在此之前：白名单里已留名（`APP_METHODS` ✓），但 `capabilities.audio = false` ✓、
> 应用侧对未实现方法回 `-32000` 并写明原因 ✓ —— **不谎报** ✓。

## 七、写在最后（给实现者的约束，来自项目铁律）

- **不另算布局/配置**：一律复用引擎与 `resolvePageConfig`（"数值口径同源"，AGENTS §六之二·4）；
- **不外泄内部对象**：返回值只用普通数据；`renderFull` 是显式逃生舱；
- **不做隐式写入**：API 绝不主动改笔记/设置（要写由调用方显式做）；
- **审核约束**：新增代码同样受 §六之四约束（禁内联样式、`!important`、`innerHTML`、`console.*` 等）。
