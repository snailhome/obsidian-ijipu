# iJipu Web 嵌入 Obsidian 插件 — 方案设计（v2）

> ⚠ **本文是 2026-10-08 的**设计**文档，其中"移动端不支持 / `isDesktopOnly: true`"的判断
> **已被 0.32.0–0.33.0 的实现取代**：`isDesktopOnly` 现为 `false`，手机端用宿主编辑器打开 `.jps`
> 源码（iJipu 语法着色 + 语法错误提示）+ 原生谱面预览；内嵌完整编辑器仍只在桌面端（本机服务要 Node）。
> 保留本文只为回溯当时的取舍，**不要**据此判断当前能力（以 README 与 `manifest.json` 为准）。

> **目标（用户口径，2026-10-08）**：
> ① 把 iJipu **整个网页应用**打包进 `obsidian-ijipu` 插件；
> ② 在插件设置里加一个**复选框**，控制是否在**左侧栏放一个图标**；
> ③ 点图标 → 在 **Obsidian 内部页签**里打开这个 iJipu；
> ④ **OB 里的 `.jps` 直接用内部这个 iJipu 打开**——于是**不必再装外部桌面端**；
> ⑤ 嵌入版**默认以当前 Obsidian 文库（vault）为工作区**，从而免去"选文件夹 / 文件系统授权"；
> ⑥ 未使用的 PNG/SVG **不打包**；
> ⑦ 发布物**仍是 `main.js`/`manifest.json`/`styles.css` 三个文件**。

---

## 实施进度（2026-10-08）

| # | 项 | 状态 | 落点 |
|---|---|---|---|
| ① | 插件内本地 HTTP 服务（内存资产、`127.0.0.1`+token） | ✅ 完成 | `obsidian-ijipu/src/embed/server.ts` |
| ② | 桥协议（vault 作工作区） | ✅ 完成 | 插件 `src/embed/bridge.ts` ↔ 应用 `src/store/hostBridge.ts` + `workspace.ts` 的 `'vault'` 后端 |
| ③ | 侧栏图标 + 设置开关 | ✅ 完成 | 插件 `src/main.ts`（`addRibbonIcon` 受设置控制）、`src/settings.ts`「嵌入版」页签 |
| ④ | 双击 `.jps` 用完整 iJipu 打开；`![[xx.jps]]` 保持预览 | ✅ 完成 | 插件 `src/fileView.ts` 的**嵌入分支**（按 `embedded` 分流） |
| ⑤ | 免授权以文库为工作区 | ✅ 完成 | 应用 `main.tsx` 启动握手 ⇒ `setWorkspace(makeVaultWorkspaceRecord(...))` |
| ⑥ | 未使用 PNG/SVG 不打包 | ✅ 完成 | `ijipu/scripts/embed-assets.mjs`（白名单：icons **48→37 个、383→142.5 KB**） |
| ⑦ | 发布物仍 3 个文件 | ✅ 完成 | 网页产物 → `src/gen/webappAssets.ts`（**入库**）→ 由 esbuild 打进 `main.js`（**2.84 MB**） |
| ⑧ | 自动化验证 | ✅ 完成 | `ijipu/scripts/embed-smoke.mjs`：真机 Chrome+CDP，**端到端跑通桥协议** |
| ⑨ | 在**真实 Obsidian** 里手动验收 | ⬜ **待用户执行** | 沙箱内无法运行 Obsidian |

### 端到端验证证据（`npm run smoke:embed`，真机 Chrome + CDP）

```
[embed-smoke] ✅ 单文件产物启动成功、无运行时报错
[embed-smoke] ✅ 桥端到端通过：应用 hello→ready、发出 1 次桥调用（list:{"path":""}）、宿主应答后无报错
[embed-smoke] 应用侧自述：{"vaultName":"测试文库","root":"乐谱","calls":1,"lastOps":["list"]}
```

两个**只有真机才暴露**的问题就是这样抓到的：
① 页面必须挂在 `/<token>/` 下（应用从 URL 首段取 token，取不到直接放弃握手）；
② 底栏默认收起 ⇒ 嵌入版刚打开时**一次桥调用都不会发生**（故启动时主动预热一次文库根）。

### 关键口径（实现时定死，改动前先读）

- **宿主桥的 `root` 一律是 `''`**：宿主只认**文库相对路径**（`vault.adapter.*` 的原生口径）。
  「子目录」表达为应用侧工作区记录的**初始 `path`** ⇒ 换目录仍是普通导航，不会把用户锁在子目录里。
- **应用侧 3 秒握手超时**：超时或不在 iframe 里 ⇒ 判定非嵌入环境，照旧走 `fsa`/`path`，
  **同一份产物在浏览器/桌面壳里不受影响**。
- **iframe 里不注册 Service Worker**（`main.tsx` 的 `isEmbeddedFrame()`）：SW 作用域是 origin，
  而嵌入版那个 origin 只为本次会话服务、没有 `/sw.js`，且 SW 会跨会话存活。
- **`.gitignore` 不能"排除目录再 `!` 放行单个文件"**（git 的否定规则对已排除的父目录无效）⇒
  改为只逐个排除不该入库的文件（`src/gen/buildInfo.ts`）。


---

## 0. 结论摘要

| 判断 | 结论 |
|---|---|
| 可行性 | **可行**，且比预想顺——`.jps` 的视图本来就注册在 `ijipu-jps-view`（`fileView.ts:138`），换掉它的内容即可复用**全部** Obsidian 原生能力（页签、`.jps` 关联、右键菜单、自动保存、最近文件） |
| 网页怎么加载 | **插件内起本地 HTTP 服务**（`http://127.0.0.1:<port>/<token>/`），**不用 `app://`** |
| 文件怎么读写 | **桥协议**：iframe 里的应用 `postMessage` → 插件用 Obsidian `app.vault.adapter.*` 执行 |
| 工作区 | **vault 根**（或设置里指定的子目录）= 工作区根；打开具体文件时由宿主把 `path` 传给应用 |
| 移动端 | **不支持**（本地服务要 Node）⇒ `isDesktopOnly: true` |
| 版本幅度 | 新功能 ⇒ 插件 `0.29.0`（MINOR） |

### 两条**必须避开**的坑（源自 `app://` 的现实）

1. **不要用 `app://` 在 iframe 里加载本地页**——社区已多次报"本地 HTML 在 iframe 里不再加载"
   （[Obsidian 论坛](https://forum.obsidian.md/t/iframe-no-longer-loading-local-html-files/74509/3) 里
   同一份 `app://<id>/C:/…/test.html` 在 1.5.8 上变空白；前缀也从 `app://obsidian.md/` 变了）。
   `obsidian-html-embed` 这类插件虽声称可用，但**不能作为架构赌注**。
2. **不要把 28 个 chunk 内联进 `main.js`**——现有内联先例（`esbuild.config.mjs:33-46` 的 PNG、
   `:47-57` 的 worklet）都是**单文件资源**；网页产物是 28 个 ESM chunk，靠相对 `import` 互引，
   在 `blob:`/`data:` 下**无法解析**；全 base64 会让 `main.js` 从 1.18 MB 涨到 ~3.7 MB。
   **本地 HTTP 服务天然解决**：相对路径、ESM chunk、`<link>`/`<script>` 全部照常。

---

## 1. 现状核实（两个调研的结论）

### 1.1 应用侧（`ijipu`）

- **`@tauri-apps/*` 导入数 = 0**；桌面能力全走 `window.__TAURI__` 裸 IPC。⇒ 纯网页可独立跑。
- **工作区已是双后端**：`src/store/workspace.ts`（1145 行）`WorkspaceBackend = 'fsa' | 'path'`；
  **真正碰磁盘的是 9 个模块私有原语**（`resolveDirHandle:508`、`resolveFileHandle:519`、
  `listRaw:551`、`dirExistsRaw:601`、`isDirEmptyRaw:619`、`readTextRaw:630`、`writeTextRaw:644`、
  `makeDirRaw:661`、`removeRaw:674`），**全部未 export**，内部按 `backendOf(rec) !== 'fsa'` 二选一
  （558/603/621/632/646/663/678）。
- **打开/保存的入口**：`docStore.openFile:702`、`openWorkspaceFile:768`、`saveFile:1039`→`doSaveFile:1185`
  （三分支：`nativePath` Tauri / `binding` 工作区 / `fileHandle` FSA）、`saveFileAs:1056`、
  `saveToWorkspace:823`、`newWorkspaceScore:1016`。
- **工作区 UI 是独立面板**（`WorkspacePanel.tsx` 1693 行，注册在底栏 `ToolDock.tsx:66/77/268`）。
- **IndexedDB**（`fileHandleDb.ts`，库 `ijipu` / 仓 `fileHandle`）存 5 类键：
  `last` / `workspace` / `workspaceList` / `recentJpsFiles` / `workspaceIndex`。**全部 try/catch 静默降级**
  （写失败静默、读失败返 `null`/`[]`），退化为会话内内存。
- **Service Worker**：`main.tsx:23` 的 `isTauriDesktop()` 在桌面端**主动 unregister + 清 cacheStorage**，
  网页端注册 SW（`main.tsx:46-91`）。⇒ 嵌入版要按"**非独立站点**"处理（不注册 SW）。
- **平台判定抄了 4 份**：`brand/platform.ts:11`、`main.tsx:23`、`samplerCache.ts:15`、
  `spessaSynthBackend.ts:80`（外加 `workspace.ts:470`）。嵌入版会引出**第五种情形**，必须收口。
- **构建产物**：`dist/` = 1.9 MB（`index.html` 2.7 KB + `assets/` 28 chunk 1.16 MB +
  `icons/` 0.37 MB + `spessasynth/` 0.38 MB）；**`index.html` 全是根绝对路径**（`/assets/…`）。
- **音源**：`resources/soundfonts/generaluser_gs.sf2` = **30.8 MB**，**不在** `dist/` 里；
  编辑/排版/导出**不依赖**它，只有"试听音色"要（首次从 CDN 下载并缓存）。

### 1.2 插件侧（`obsidian-ijipu`）

- **唯一视图** `IJipuFileView extends TextFileView`（`fileView.ts:144`），
  `VIEW_TYPE_IJIPU='ijipu-jps-view'`（`:138`）、`JPS_EXTENSION='jps'`（`:140`）；
  `getIcon()` 返回 `'music'`（`:167`）；**现在是 textarea 源码 + `ScorePane` 轻量 SVG 预览**。
- **没有 `addRibbonIcon`、没有任何 `addCommand`、没有 iframe/webview、没有 `getResourcePath`**（全仓 0 命中）。
- `onload`（`main.ts:47-112`）：`loadSettings`→worklet Blob→`addSettingTab`(50)→`registerView`(53)→
  `registerExtensions`(54)→`registerJpsEmbeds`(56)→代码块处理器(58-60)→文件菜单(70-81)→
  `registerJpsFileCreator`(100-108)→`active-leaf-change stopAll`(111)。`onunload`(147-150) 只有 `stopAll()`。
- **设置**：`PluginSettingTab`（`settings.ts:77`），持久化 `loadData/saveData`（`main.ts:172-189` → `data.json`）。
  `defs.ts:21-24` 把 `FieldKey` 钉死为 `keyof PageConfig` ⇒ **"嵌入版开关"这类界面偏好不能进 `DEFS`**，
  要照 `hqVoice`/`hqEnabled` 先例（`types.ts:7-11` 加可选字段 + `settings.ts` 分派）。
- **构建/发布**：`esbuild.config.mjs` → `main.js`（1.18 MB，`format: cjs`，`obsidian` external）；
  `styles.css` **手写 841 行、无构建步骤**；CI `release.yml:53-56` **只发 `main.js`/`manifest.json`/`styles.css`**；
  `.gitignore:8-15` **主动拦** `Jianpu.ico`/`Jianpu.png`/`pwa-*.png`/`manifest.webmanifest`/`sw.js`/`doc/`，
  `:22` 拦 `dist-*.js`。
- **Vault IO 已有先例**：`src/embed.ts:183` `cachedRead`、`:212` `modify`。

---

## 2. 架构

```
┌──────────────────────── Obsidian 桌面（Electron） ─────────────────────────┐
│                                                                            │
│  插件进程（Node 可用）                                                       │
│   ├─ LocalServer  http.createServer，仅服务 <pluginDir>/webapp/**           │
│   │               绑 127.0.0.1，URL 带一次性 token                          │
│   └─ Bridge       postMessage 路由 → app.vault.adapter.*                    │
│                                                                            │
│  ┌── 页签 A：iJipu 应用（侧栏图标打开）──────────┐   ┌── 页签 B：.jps ──┐ │
│  │  iframe  http://127.0.0.1:<port>/<token>/    │   │ 同一个 iframe     │ │
│  │  = 完整 iJipu（工作区 = vault）              │   │ + 打开指定文件    │ │
│  └───────────────────────────────────────────────┘   └───────────────────┘ │
│              ▲ postMessage（请求/响应 + 事件）                              │
│              │                                                             │
│        Obsidian Vault（= 工作区根）                                         │
└────────────────────────────────────────────────────────────────────────────┘
```

**两个入口，一套桥：**

| 入口 | 触发 | 应用行为 |
|---|---|---|
| **A. 应用页签** | 左侧栏图标 / 命令面板 | 打开 iJipu，工作区 = vault 根（文件树里就是文库里的 `.jps`） |
| **B. 文件页签** | 双击 vault 里的 `.jps`（现有 `registerExtensions` 自动生效） | 同一个 iframe，宿主把 `this.file.path` 传给应用 ⇒ 应用直接打开该文件；保存经桥写回 vault |

> 入口 B 意味着：**用户在 OB 里双击 `.jps`，看到的就是完整的 iJipu 编辑器**，
> 不再是现在的"textarea + 轻量预览"。这正好满足"不用再装外部桌面端"。

---

## 3. 桥协议

**传输**：`iframe.contentWindow.postMessage(msg, 'http://127.0.0.1:<port>')`；URL 带 `token`。
**握手**：`hello`(app) → `welcome`(host，带 `vaultName`/`theme`/`caps`) → `ready`(app)。
**超时 3 s** 未握手 ⇒ 应用判定"非嵌入环境"，退回普通网页逻辑（**同一份产物在浏览器里照常可用**）。

| `op` | args | 对应 Obsidian API |
|---|---|---|
| `list` | `{ path }` | `adapter.list` + `adapter.stat` |
| `read` / `write` | `{ path[, text] }` | `adapter.read` / `adapter.write`（写后**回读校验**） |
| `exists` / `stat` | `{ path }` | `adapter.exists` / `adapter.stat` |
| `mkdir` / `create` | `{ path }` | `adapter.mkdir` / `adapter.write(p,'')` |
| `rename` / `move` | `{ from, to }` | `adapter.rename` |
| `remove` | `{ path, trash? }` | `adapter.trash` / `adapter.remove` |
| `search` | `{ query }` | 插件侧遍历（只扫 `.jps`） |
| `openInObsidian` | `{ path }` | `workspace.openLinkText(path,'')` |

**宿主 → 应用事件**：`theme{mode}`、`vaultChanged{path}`（OB 侧被改 ⇒ 应用刷新）、
`openFile{path}`（入口 B 指定要打开的文件）。
**应用 → 宿主事件**：`status{dirty,file}`（页签脏标记）、`openNote{path}`。

**路径口径与安全**：统一 **vault 相对路径**（`a/b/c.jps`，正斜杠）；插件侧 `normalizePath`
并**拒绝 `..` 越界**；`event.source === iframe.contentWindow` + `token` 双重校验。

> **`adapter` 已核实的可用方法**（`obsidian.d.ts`）：`list:2033`、`stat:2027`、`exists:2020`、
> `read:2038`、`write:2052`、`readBinary:2044`、`writeBinary:2062`、`mkdir:2099`、`remove:2101`、
> `getResourcePath:2093`。

---

## 4. 应用侧改造（`ijipu` 仓库）

### 4.1 三步核心（调研给出的"最小改造点"）

| 步骤 | 内容 | 落点 |
|---|---|---|
| **S1** | 把 `workspace.ts:508-684` 那 9 个**私有 IO 原语**提升为可注册的 `WorkspaceFs` 接口（`list/dirExists/isDirEmpty/readText/writeText/makeDir/remove`），`backendOf` 由"两个硬编码后端"扩为**注册表** | `src/store/workspace.ts` |
| **S2** | 收口 `docStore` 里**直接**调浏览器/桌面的 5 处（`showOpenFilePicker:704`、`showSaveFilePicker:1059`、`<input type=file>:1351`、`nativePath:1191`、`fileHandle:1260`），让"文件从哪来/往哪去"只在**一层**决策 | `src/store/docStore.ts` |
| **S3** | `brand/platform.ts:11` 扩成 **host 三态**（`tauri`/`web`/`obsidian`），并删掉 `main.tsx:23`、`samplerCache.ts:15`、`spessaSynthBackend.ts:80` 的三份重复判定 | 5 处收敛到 1 处 |

### 4.2 新增 `'vault'` 后端 + 桥客户端

```ts
// src/store/workspace.ts
export type WorkspaceBackend = 'fsa' | 'path' | 'vault'
export function backendOf(rec) {
  if (rec.bridge) return 'vault'          // 最高优先
  if (typeof rec.dir === 'string' && rec.dir) return 'path'
  if (rec.handle) return 'fsa'
  return null
}
export function supportsVaultWorkspace(): boolean { return !!globalThis.__IJIPU_HOST__ }
export function isWorkspaceAvailable(): boolean {
  return supportsVaultWorkspace() || supportsPathWorkspace() || isWorkspaceSupported()
}
```

- 新文件 `src/store/hostBridge.ts`（~200 行）：读 token → 握手（3 s 超时）→
  `hostList/hostRead/hostWrite/hostExists/hostMkdir/hostRename/hostRemove/hostSearch`，
  内部 `id` 多路复用 + 超时 + 错误规范化；把 `theme` 转发给 `uiStore`。
- `WorkspaceRecord` 加 `bridge?: { vaultName: string }`（**不持久化句柄**，宿主每次启动自带）。

### 4.3 首屏与"打开指定文件"

```ts
const host = await initHostBridge()          // 嵌入环境？
if (host) {
  await setWorkspace(makeVaultWorkspaceRecord(host.vaultName))   // 免授权进工作区
  host.on('openFile', ({ path }) => docStore.openWorkspaceFile(path))  // 入口 B
  // 关掉"选文件夹/授权"引导；隐藏「选择文件夹」「最近工作区」等无意义入口
}
```

### 4.4 需要"藏起来"的东西（vault 语境下无意义）

- 「选择文件夹当工作区」（`WorkspacePanel` 的 `onPick:749`）；
- 「继续访问（授权）」（`onGrant:795`）；
- 「最近工作区」（`onActivate:822`）。

> 注意：**不是**把整个工作区面板删掉——`vault` 语境下它仍然有用（浏览文库里的 `.jps`、
> 新建谱夹/改名/删除）。只是**入口从"选文件夹"变成"文库根"**。

### 4.5 其他必要调整

- **SW**：嵌入版**不注册** SW（`main.tsx:46-91` 增加 host 判定）；
- **导出**：`export.ts:11-44` 现在是 `URL.createObjectURL` + `a.download`（Electron 里落到下载栏）。
  嵌入版建议改为**写回 vault**（如 `导出/<文件名>.pdf`）——**可后置**，先保留"下载到系统下载夹"；
- **窄屏判定**：`matchMedia` 是**窗口级**的，嵌入后应按**容器宽度**（`ResizeObserver`）——
  否则在窄侧栏里会误判为手机布局；
- **构建**：新增嵌入模式，`vite.config.ts` 的 `base` 按 mode 切 `'./'`（避免影响 PWA 版）；
  `manifest.webmanifest`/`sw.js` 在嵌入版忽略。

### 4.6 音源（分阶段）

- **阶段 1**：不做。试听走 SpessaSynth（`dist/spessasynth/*` 0.38 MB 已在产物里），
  sf2 由 CDN 首次下载并缓存进 iframe 的 IndexedDB（origin 稳定 ⇒ 跨会话保留）。
- **阶段 2（可选）**：把 `generaluser_gs.sf2`（30.8 MB）放进插件资源，桥加 `assetUrl{name}`
  返回 `adapter.getResourcePath(...)` ⇒ 离线可用，但插件包从 ~3 MB 涨到 ~34 MB。**默认关闭，做成设置开关。**

---

## 5. 插件侧改造（`obsidian-ijipu` 仓库）

### 5.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/embed/server.ts` | 本地 HTTP 服务：只服务 `<pluginDir>/webapp/**`、绑 `127.0.0.1`、端口 `0`（系统分配）、随机 token、MIME 表、`Cache-Control: no-store` |
| `src/embed/bridge.ts` | postMessage 路由：校验 `event.source` + token；把 op 翻成 `app.vault.adapter.*`；错误统一包装 |
| `src/embed/vaultFs.ts` | 纯函数：路径归一化 / `..` 越界拒绝 / `list` 结果整形（只回 `.jps` + 目录，对齐 `DirEntry`） |
| `src/embed/frame.ts` | 管 iframe 生命周期：建、挂、`postMessage` 收发、重载、销毁 |
| `src/embed/webappBuild.mjs` | 构建期：跑 `ijipu` 嵌入构建 → 拷 `dist/**` → `obsidian-ijipu/webapp/` |

### 5.2 改动既有文件

| 文件 | 改动 |
|---|---|
| `src/fileView.ts` | `IJipuFileView` 的 `render()`（`:210-277`）增加**嵌入模式分支**：设置开了就用 iframe 打开 `this.file.path`，否则保持现有 textarea+预览。**保存**：监听桥的 `write`（或直接用 `app.vault.modify`） |
| `src/main.ts` | `onload`：`addRibbonIcon('music','打开爱记谱',…)`（**受设置开关控制**，`addRibbonIcon` 返回 `HTMLElement` ⇒ 可动态显隐）、`addCommand({id:'open-ijipu-app'})`；`onunload`：停服务（视图已由 OB 自行 detach） |
| `src/settings.ts` | 新增一组「嵌入版」设置：`嵌入版开关`(toggle，控制 ribbon)、`工作区子目录`(text，默认空=vault 根)、`离线音源`(阶段 2)、`跟随 Obsidian 主题`(toggle) |
| `src/types.ts` | `IJipuSettings` 加这几个可选字段（**不能进 `defs.ts` 的 `DEFS`**，见 §1.2） |
| `manifest.json` | `isDesktopOnly: true` |
| `esbuild.config.mjs` | 主体不动；`webapp/` 是静态资源不参与 bundle |
| `package.json` | `build` 脚本追加 `node src/embed/webappBuild.mjs` |
| `.gitignore` | 忽略 `webapp/`（构建产物）——**注意避开 `:8-15` 的既有规则** |
| `.github/workflows/release.yml` | 发版需**附带 `webapp/`**：现在 `:53-56` 只发 3 个文件 ⇒ 改为打 zip 或把 `webapp/` 一起上传 |

### 5.3 侧栏图标与视图激活（仓库内 0 先例，需新写）

```ts
// main.ts onload
this.ribbonEl = this.addRibbonIcon('music', '打开爱记谱', () => this.openIjipuApp())
this.addCommand({ id: 'open-ijipu-app', name: '打开爱记谱（应用）', callback: () => this.openIjipuApp() })

async openIjipuApp() {
  const { workspace } = this.app
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_IJIPU_APP)[0]
  if (!leaf) {
    leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true)
    await leaf.setViewState({ type: VIEW_TYPE_IJIPU_APP, active: true })
  }
  workspace.revealLeaf(leaf)
}
```

> 图标：`addRibbonIcon` 的 `icon` 参数要 **IconName（内置名）或已 `addIcon` 注册的 id**；
> 现有品牌图是 **PNG（`icons.ts` 走 data URI）**，**不能**直接喂给 `addIcon`（它要 SVG 字符串）。
> ⇒ 用内置名 `'music'`（与现有 `fileView.ts:168` 一致）最省事；要用品牌图需另行准备 **SVG**。

---

## 6. 分阶段实施

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **P0 打样** | 插件里起本地服务 + 空 iframe 加载占位页 + 一次 `postMessage` 往返 | OB 里侧栏能打开、控制台看到握手 | 0.5 天 |
| **P1 应用可托管** | 嵌入模式构建（`base:'./'`）+ 搬运脚本 + iframe 里跑起**完整 iJipu**（暂不接工作区） | 能编辑/排版/播放（试听走 CDN） | 1 天 |
| **P2 工作区桥** | `hostBridge` + `'vault'` 后端 + 免授权进工作区（`list/read/write/exists/mkdir/rename/remove`） | 文件树显示文库里的 `.jps`；改动保存回 vault | 1.5–2 天 |
| **P3 文件页签** | `IJipuFileView` 嵌入分支：双击 `.jps` 用完整 iJipu 打开；保存走 `vault.modify`；脏标记 | **替代外部桌面端的核心体验达成** | 1 天 |
| **P4 收口** | 主题跟随、`vaultChanged` 刷新、窄屏容器感知、快捷键（`Ctrl+S` 在 iframe 内 `preventDefault`）、隐藏"选文件夹/授权"入口 | 与浏览器里体验一致 | 1 天 |
| **P5 可选** | 离线 sf2 开关、"在 Obsidian 中打开"互链、导出写回 vault、文库子目录 | — | 按需 |

**MVP = P0+P1+P2+P3**（约 3.5–4 天）⇒ 此时"在 OB 里双击 `.jps` 就是完整 iJipu"已经成立。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `app://` 在 iframe 里不可靠 | 方案不成立 | **已规避**：本地 HTTP 服务 |
| **`.gitignore:8-15` 主动拦网页产物文件名**（`Jianpu.ico`/`pwa-*.png`/`manifest.webmanifest`/`sw.js`/`doc/`），`:22` 拦 `dist-*.js` | 产物进不了仓库、CI checkout 缺文件 | `webapp/` 用**新目录名**并显式加白/忽略规则；`release.yml` 同步扩 `files:` |
| **`release.yml:53-56` 只发 3 个文件** | 用户装到的插件里没有网页 | 发版改为**打 zip**（含 `webapp/`）或把 webapp 一起上传；`manifest.json` 里声明资源 |
| 28 个 ESM chunk 不能内联进 `main.js` | `main.js` 膨胀且相对 import 失效 | 本地服务托管，**不内联** |
| 端口被占 / 同机页面误连 | 服务起不来或安全 | 端口 `0` 由系统分配；URL 带**一次性 token**；仅 `127.0.0.1`；只服务 `webapp/**`；每次加载换 token |
| 移动端无 Node | 移动端不可用 | `isDesktopOnly: true`；移动端保留现有轻量渲染 |
| iframe 沙箱限制导出/弹窗 | 导出 PDF 失败 | sandbox 加 `allow-downloads`/`allow-modals`；导出走 `blob:` + `a.download`（iframe 内可用） |
| 平台判定已有 4 份重复 | 加第五种情形必飘 | **先做 S3 收口**（`brand/platform.ts` 唯一出处），再动嵌入 |
| `matchMedia` 是窗口级 | 窄侧栏误判手机布局 | 改 `ResizeObserver` 观察容器 |
| sf2 首次下载慢 | 试听等待 | 沿用应用既有缓存；P5 提供离线开关 |
| 同一份产物两处用（PWA + 嵌入） | 基线漂移 | 同一源码、两个 mode；CI 两个 mode 都构建 + `smoke` |
| 插件体积 | 安装包变大 | webapp ≈1.9 MB（不含 sf2）⇒ 总量 ~3 MB，可接受 |

---

## 8. 需要你拍板

1. **工作区根**：默认 **vault 根**，还是某个子目录（如 `乐谱/`）？（建议：vault 根，设置里可指定子目录）
2. **入口 B 的范围**：双击 `.jps` **直接**用嵌入 iJipu 打开（**完全替代**现有轻量视图），
   还是**默认轻量、加一个"用完整编辑器打开"按钮**？（后者风险小、可回退；前者才是"替代桌面端"）
3. **音源**：P1 先走 CDN 缓存（插件保持 ~3 MB），还是一开始就内置 sf2（+30.8 MB）？
4. **发布形态**：`webapp/` 进 git（仓库变大但 CI 简单），还是**构建期生成**（仓库干净、CI 要加构建步骤）？
   我建议**构建期生成**，并在 Release 里打 zip。

---

## 9. 与现有发布链的衔接

- 属插件 **CHAIN-B** 流程（`obsidian-ijipu`）⇒ 版本 `0.28.3` → **`0.29.0`**（MINOR）。
- `webapp/` 是构建产物：进 `.gitignore`；但**必须进 Release 附件** ⇒ `release.yml` 要加
  "构建 ijipu 嵌入版 → 拷进 webapp/ → 与 main.js 一起打包"的步骤。
- 应用到插件的引擎同步（`OP-12` 哈希对比）**照旧**——嵌入版与 `vendor/engine` 用同一份引擎源码，
  但**各自构建**；发版时两者一起走。
