import { Events, Keymap, MarkdownRenderChild, MarkdownView, Notice, Platform, Plugin, requestUrl, TFolder, TFile, type MarkdownSectionInformation, type WorkspaceLeaf } from 'obsidian'
// adj749d：自动格式化（光标离开本行时格式化该行）用**引擎里那份应用自己的**逐行格式化器
import { formatLine, applyRangeToSvg, rangeBox, readViewBoxOf, insertPngPhys, dpiForScale, RANGE_PAD_DEFAULT, type RangeBox } from '@ijipu/engine'
// adj774：markdown 笔记里 ```jps 代码块的围栏扫描（着色/错误提示/自动格式化三处共用同一份口径）
import { jpsBlockRanges, zoomOfInfo } from './jpsBlocks'
import { createIjipuApi, type IjipuApi } from './api'
import { createAppRequester, createEmbedRpc, type AppRequester, type EmbedRpc } from './embed/rpc'
// adj807（B2）：RPC 的 `render.svg` 允许带 `pageConfig` 覆盖 ⇒ 这里只需要它的**类型**
import type { PageConfig } from '@ijipu/engine'
import { IJipuSettingTab } from './settings'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import { registerJpsEmbeds } from './embed'
// adj752：`.jps` 源码高亮（CM6 扩展，规则来自引擎、配色来自应用）
import { jpsHighlightExtension } from './jpsHighlight'
import { IJipuFileView, JPS_EXTENSION, VIEW_TYPE_IJIPU } from './fileView'
import { createJpsFile, consumeJpsLinkCreate, materializeJpsFile, planJpsLinkCreate, registerJpsFileCreator, unregisterJpsFileCreator, NEW_JPS_TEMPLATE } from './newFile'
import { replaceCodeBlockBody } from './sourceEdit'
import { canOpenWithDefaultApp, openWithDefaultApp } from './openExternal'
import { DEFAULT_EMBED_OPEN_MODE, DEFAULT_EXPORT_RANGE, type EmbedOpenMode, type ExportRangeSetting, type IJipuSettings } from './types'
import { IJipuBridge } from './embed/bridge'
import { embedEditLeavesObsidian, planEmbedTarget } from './embed/openPlan'
/**
 * adj741（用户决定：按 P0"一版多端"做，见任务 1）—— **嵌入版 iJipu 的本地服务必须按需加载**。
 *
 * `./embed/server` 里是 `node:http` + `node:crypto`（把嵌入版单文件网页提供给 iframe）。
 * 这两样在 Obsidian **手机端不存在**：静态 `import` 会在**加载插件**时就解析失败 ⇒
 * 整个插件起不来（连"手机端最需要的"普通预览都一起没了）。所以：
 *  · 这里只保留**类型**导入（`import type` 编译期擦除，不产生运行时 require）；
 *  · 真正的 `import('./embed/server')` 放进 `loadEmbedServer()`，且**仅桌面端**调用。
 * 这条由冒烟断言钉住（"手机端路径不得静态引用 node:*"）。
 */
import type { EmbedServer } from './embed/server'
import { IJipuAppView, VIEW_TYPE_IJIPU_APP } from './embed/appView'
import { HQ_LIBRARIES } from './soundbank'
import { createBankFileStore, type BankFileStore } from './bankFile'
// @ts-ignore esbuild 以 text loader 把 worklet 内联为字符串（main.js 单文件自包含，无需插件目录单独 worklet）
import workletCode from '../spessasynth_processor.min.js'
// adj796：完整诊断报告里要报"构建信息 / 嵌入版版本"，故在此导入（两者都是构建期生成、无运行时开销）
import { BUILD_STAMP, GIT_COMMIT } from './gen/buildInfo'
import { WEBAPP_META } from './gen/webappAssets'

/** 插件内事件广播：设置面板保存后触发，打开中的谱面据此即时重渲染 */
export const SETTINGS_CHANGED = 'settings-changed'
/** 插件内事件广播：「排版辅助虚线」开关变化（所有面板同步） */
export const GUIDES_CHANGED = 'guides-changed'

/**
 * adj864：把 PNG 字节写进系统剪贴板（只能走 `navigator.clipboard.write` + `ClipboardItem`）。
 *
 * 失败情形必须**如实报错**（移动端 WebView、老宿主、权限被拒都可能没有这个 API）——
 * 复制类操作最容易"静默失败"：用户以为复制好了，粘出来却是空的 ✗。
 */
async function copyPngBytesToClipboard(bytes: Uint8Array): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || navigator.clipboard?.write === undefined) {
    throw new Error('当前环境不支持写入剪贴板图片（可改用「导出 PNG」命令，会存到谱面同目录）')
  }
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' })
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

/**
 * obsidian-ijipu —— 在 Obsidian 笔记里用 ```jps 代码块渲染可视化简谱并可试听。
 *
 * 三种入口共用同一渲染面板（`scorePane.ts`）：
 *  ① ```jps 代码块（正文即 .jps 源码，与 iJipu 打开的文件内容一致）
 *  ② `.jps` 文件视图（插件启用后 Obsidian 把 .jps 识别为简谱文件，`[[xxx.jps]]` 可直接打开）
 *  ③ `![[xxx.jps]]` 嵌入（在笔记里内联渲染该谱）
 * 页面设置优先级：引擎默认 < 插件设置 < 笔记 frontmatter < 谱面源码内 `# jps-config`（最高）。
 * 「⚙ 排版」改的是**当前这一份谱**，保存即写回源码（代码块写回笔记正文、文件/嵌入写回 .jps）。
 */
export default class IJipuPlugin extends Plugin {
  settings: IJipuSettings = {}
  /**
   * adj800（B1）：**公开调用面**（`Object.freeze` 过、带 `apiVersion`）——
   * 其它插件/脚本这样用：`app.plugins.plugins['ijipu'].api`（见 `src/api.ts` 顶部说明与
   * `docs/OBSIDIAN-API.md`）。`onload` 里创建（设置以**函数**形式传入，改动即时生效）。
   */
  api!: IjipuApi
  /**
   * adj807（方案 B / **B2**）：嵌入版 RPC 的**总开关** —— 用户裁决 ③「**默认关闭**」✓。
   * 打开后才接受嵌入版 iframe 的 `postMessage` 请求（方法白名单见 `src/embed/rpc.ts` ✓）。
   * 设置界面里的开关在下一轮补 UI；现在可用控制台/后续设置项打开，**默认是关** ✓。
   */
  allowExternalApi = false
  /**
   * adj835（用户报 ③）：**源码态事件序列记录器** —— 用来定位
   * 「在 ` ```jps ` 代码块的源码态按 Ctrl+P（命令面板），块闪回预览；关掉面板又回到源码」✗。
   *
   * 记录内容（都是**可判定的事实**，不含主观描述 ✓）：
   *  · 时间 + 事件名（`window.focus` / `window.blur` / `visibilitychange` / `active-leaf-change` ✓）；
   *  · 当时**活动文件** ✓；
   *  · 当时**预览 widget 数**（`.ijipu-score` ✓）与**源码 pre 数**（`.cm-embed-block pre, .cm-embed-block code` ✓）
   *    —— 前者 >0 = 正在**预览** ✓，后者 >0 且前者 = 0 = 正在**源码** ✓（这就是"闪回"的判据 ✓）；
   *  · 是否处于 `.jps` 借用编辑器的源码页签（`.workspace-leaf.ijipu-plain-source` ✓）。
   * 只保留最近 12 条 ✓；结果进「生成完整诊断报告」✓（用户点一下即复制 ✓）。
   */
  private sourceModeLog: string[] = []

  private logSourceModeEvent(name: string): void {
    try {
      const file = this.app.workspace.getActiveFile()?.path ?? '(无)'
      /**
       * ⚠ adj836（用户 2026-10-11 诊断纠正）：**上一版判据是错的** ✗ ——
       * 我按"`.cm-embed-block` 里有没有 `pre/code`"判源码态 ✓，实测**永远是 0** ✗
       * （Live Preview 的源码态就是 `.cm-line` 纯文本，不套 `pre` ✓）；
       * 而 `widget` 数是**整篇笔记**的 ✓，不能代表"当前这块" ✗。
       * ⇒ 改成**逐块**判定：每个 `.block-language-jps` 含不含 `.ijipu-score`
       * （含=该块**预览** ✓，不含=该块**源码** ✓），并报出"预览 n / 源码 m（共 n+m）"✓。
       */
      const blocks = Array.from(document.querySelectorAll('.block-language-jps'))
      let preview = 0
      let source = 0
      for (const b of blocks) {
        if (b.querySelector('.ijipu-score') !== null) preview += 1
        else source += 1
      }
      const mode = blocks.length === 0 ? '无块' : `预览${preview}／源码${source}（共${blocks.length}）`
      const plainLeaf = document.querySelector('.workspace-leaf.ijipu-plain-source') !== null
      const d = new Date()
      const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
      this.sourceModeLog.push(`${t} ${name}｜文件=${file}｜块态=${mode}｜借用编辑器=${plainLeaf ? '是' : '否'}`)
      if (this.sourceModeLog.length > 12) this.sourceModeLog.shift()
    } catch {
      /* 诊断失败不影响交互 ✓ */
    }
  }
  private embedRpc: EmbedRpc | null = null
  /** adj809（B3 起步）：反方向请求器（插件 → 嵌入版，如 render.png） */
  appRpc: AppRequester | null = null

  /**
   * adj809（B3 起步）：当前**嵌入版 iframe 的窗口** —— 收发消息与来源校验都用它 ✓。
   * 判据：`src` 里带本插件发的 `token=`（与 `IJipuBridge` 的登记口径一致 ✓）。
   */
  private embedRpcWindow(): Window | null {
    /**
     * adj844（用户实测：「导出 PNG 仍然没有应答」✗，且嵌入产物里**确实含桥** ✓）：
     *
     * 最可能的元凶是**选错了 iframe** ✗ —— 页面里可能同时存在多个本机服务 iframe
     * （右栏一个、别的页签/历史视图一个、甚至已关闭但未回收的一个 ✓），
     * 而原来的实现取"**第一个**匹配的" ⇒ 可能发给了**隐藏/陈旧**那个 ⇒ 永远等不到应答 ✓。
     *
     * 现在的选取顺序（**可见优先** ✓，并把结果记进诊断 ✓）：
     *  ① 可见（`offsetWidth/Height > 0` ✓）且 `contentWindow` 非空 ✓ 的候选 —— 取**最后一个**
     *     （后建的通常是当前活动视图 ✓）；
     *  ② 否则退回任意候选（保持可用的降级 ✓）。
     * 同时把"选中了哪个 src"记进 `lastEmbedFrameInfo` ✓ ⇒ 下次诊断一眼可判 ✓。
     */
    const isEmbedIframe = (f: HTMLIFrameElement): boolean => {
      const src = f.src
      if (src === '') return false
      if (src.includes('token=')) return true
      return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(src)
    }
    const candidates = Array.from(document.querySelectorAll('iframe')).filter(
      (f) => isEmbedIframe(f) && f.contentWindow !== null,
    )
    const visible = candidates.filter((f) => f.offsetWidth > 0 && f.offsetHeight > 0)
    const pick = visible.length > 0 ? visible[visible.length - 1] : candidates[candidates.length - 1]
    if (pick === undefined) {
      this.lastEmbedFrameInfo = `候选 iframe=${candidates.length}｜可见=${visible.length}｜⇒ 没有可用的嵌入版窗口`
      return null
    }
    this.lastEmbedFrameInfo =
      `候选 iframe=${candidates.length}｜可见=${visible.length}｜选中=${pick.src.replace(/^https?:\/\//, '').slice(0, 60)}` +
      `（${visible.length > 0 ? '可见' : '降级：取任意候选'} ✓）`
    return pick.contentWindow
  }

  /** adj844：最近一次"嵌入版窗口选取"的结论（进诊断报告 ✓） */
  lastEmbedFrameInfo: string | null = null
  /** adj847：向嵌入版服务**实际取回一次 HTML** 的结论（分辨"iframe 里是旧 JS"还是"产物没更新"✓） */
  embedServeInfo: string | null = null
  /**
   * adj851：**嵌入版自报家门**的结论（与 `embedServeInfo` **分开存** ✓）——
   * 上一版两者共用一个字段 ✗ ⇒ 异步取回会把 hello 覆盖掉 ✓（要看的恰好是 hello ✗）⇒ 分开 ✓。
   */
  embedHelloInfo: string | null = null
  /** 插件内事件广播（当前用于设置变更 → 打开中的谱面即时重渲染） */
  readonly events = new Events()
  /** 「排版辅助虚线」是否显示（与 iJipu 顶栏「排版」按钮同一个开关；所有面板共享、不落盘） */
  showGuides = false
  /** 所有进行中试听的停止函数（切换笔记/卸载时统一停止） */
  private playStops: (() => void)[] = []
  /** 内置 SpessaSynth worklet URL（worklet 代码内联进 main.js → Blob URL，随插件单文件分发） */
  private workletUrl = ''
  /**
   * adj729（用户要求）：**音色库落在插件目录**里的存储层
   * （`<配置目录>/plugins/<插件 id>/soundfonts/<库 id>.sf2`）。
   *
   * 用户原话：「音色库下载或导入后，建议放在插件目录中，以便能随文库一起走」——
   * 此前只存 IndexedDB（还分两个 origin），换机器/换库就没了、也**不随文库同步**。
   */
  private bankFiles: BankFileStore | null = null
  /** adj631：「设置 → iJipu」页签的"就地重画"回调（别处改了插件设置时保持两边显示一致） */
  private settingsRefresh: (() => void) | null = null
  /**
   * adj724b（嵌入版）：本地 HTTP 服务 + 桥。
   *
   * 服务**懒启动**（第一次需要 iframe 时才起），启动中保存 Promise 以便并发调用共享同一次启动。
   * 关掉「使用嵌入版 iJipu」或卸载插件时释放。
   */
  private embedServer: EmbedServer | null = null
  /** adj775：允许为 `null` —— 启动失败时把它清回 null（下一次打开即**重试**，而不是永远抛同一个错） */
  private embedServerStarting: Promise<EmbedServer | null> | null = null
  /** 桥（vault 读写 + postMessage 路由）；`onload` 里建，因为要读设置 */
  bridge!: IJipuBridge
  /** 左侧栏图标元素（设置开关切换时显隐） */
  private ribbonEl: HTMLElement | null = null
  /** adj724b：每个应用页签"待打开的文件"（`.jps` 的文库相对路径），应用 `ready` 后由桥取走 */
  readonly pendingOpenPaths = new Map<string, string>()
  /** 自增的页签令牌（`WorkspaceLeaf` 没有稳定 id ⇒ 自己发一个，随 ViewState 传给视图） */
  private leafSeq = 0

  /**
   * adj800（B1）：注册"命令面板能用"的能力（给人用的一层）。
   *
   * 取源优先级（**与用户直觉一致**）：
   *  ① 当前打开的 `.jps` 文件视图 ⇒ 用它（整份谱）；
   *  ② 否则：当前**编辑器**（含 markdown 笔记）里**光标所在**的 ` ```jps ` 代码块 ⇒ 用它；
   *  ③ 否则：当前活动文件是 `.jps` ⇒ 读文件；
   *  ④ 都没有 ⇒ 命令在面板里**置灰**（`checkCallback` 返回 false），不做"点了没反应"✓。
   *
   * 约定：命令只做**纯 TS** 的事（格式化/校验/导出 SVG/MIDI）——
   * 位图与试听留给嵌入版 RPC（B2/B3），避免在两个地方各写一份导出逻辑 ✗。
   */
  private registerCommands(): void {
    /** 取"当前上下文里的谱面源码"；取不到返回 null（命令据此置灰） */
    const contextSource = (): { source: string; label: string; file: TFile | null; block: { start: number; end: number } | null } | null => {
      const view = this.app.workspace.getActiveViewOfType(IJipuFileView)
      if (view) {
        const source = view.getViewData()
        if (source.trim() !== '') return { source, label: view.file?.basename ?? '当前 .jps', file: view.file, block: null }
      }
      const editor = this.app.workspace.activeEditor?.editor
      const mdFile = this.app.workspace.getActiveFile()
      if (editor) {
        const doc = editor.getValue()
        const line = editor.getCursor().line
        const hit = jpsBlockRanges(doc).find((b) => line >= b.fenceStart - 1 && line <= (b.fenceEnd ?? Number.MAX_SAFE_INTEGER))
        if (hit) {
          const lines = doc.split('\n')
          const body = lines.slice(hit.bodyStart - 1, hit.bodyEnd).join('\n')
          return { source: body, label: `${mdFile?.basename ?? '笔记'} 第 ${hit.fenceStart} 行起`, file: mdFile, block: { start: hit.bodyStart, end: hit.bodyEnd } }
        }
      }
      const file = mdFile
      if (file && file.extension === 'jps') {
        const cached = this.app.vault.cachedRead(file)
        // 用 cachedRead 的同步缓存不可行 ⇒ 这条路径交给异步命令自己读（这里只给"能取到"的信号）
        void cached
        return { source: '', label: file.basename, file, block: null }
      }
      return null
    }
    /** 异步取源（`contextSource` 只做同步判断；`.jps` 文件这条要读盘） */
    const contextSourceAsync = async (): Promise<{ source: string; label: string; file: TFile | null; block: { start: number; end: number } | null } | null> => {
      const ctx = contextSource()
      if (!ctx) return null
      if (ctx.source === '' && ctx.file) return { ...ctx, source: await this.app.vault.cachedRead(ctx.file) }
      return ctx
    }

    this.addCommand({
      id: 'format-jps-block',
      name: '格式化当前谱面源码（光标所在代码块）',
      checkCallback: (checking) => {
        const ctx = contextSource()
        if (!ctx) return false
        if (!checking) {
          void (async () => {
            const c = await contextSourceAsync()
            if (!c) return
            const fixed = this.api.format(c.source)
            if (fixed === c.source) {
              new Notice('iJipu：已经符合规范，无需修改')
              return
            }
            if (c.block) {
              const editor = this.app.workspace.activeEditor?.editor
              if (editor) {
                const lines = editor.getValue().split('\n')
                const from = { line: c.block.start - 1, ch: 0 }
                const to = { line: c.block.end - 1, ch: (lines[c.block.end - 1] ?? '').length }
                editor.replaceRange(fixed, from, to)
                new Notice('iJipu：已按应用规范格式化该代码块')
                return
              }
            }
            if (c.file) {
              await this.app.vault.process(c.file, () => fixed)
              new Notice('iJipu：已按应用规范格式化该谱面')
            }
          })()
        }
        return true
      },
    })

    this.addCommand({
      id: 'lint-jps',
      name: '校验当前谱面（错误 / 告警）',
      checkCallback: (checking) => {
        if (!contextSource()) return false
        if (!checking) {
          void (async () => {
            const c = await contextSourceAsync()
            if (!c) return
            const r = this.api.lint(c.source)
            if (r.ok && r.warnings.length === 0) {
              new Notice(`iJipu：${c.label} 没有发现问题 ✓`)
              return
            }
            const first = (r.errors[0] ?? r.warnings[0]) as { text?: string; line?: number } | undefined
            const where = first?.line !== undefined ? `第 ${first.line} 行：` : ''
            new Notice(
              `iJipu：错误 ${r.errors.length} 个、告警 ${r.warnings.length} 个` +
                (first ? `｜${where}${String(first.text ?? '').slice(0, 60)}` : ''),
              6000,
            )
          })()
        }
        return true
      },
    })

    /**
     * adj811（B3 收尾）：**导出 PNG** —— 位图渲染需要 canvas ⇒ 只能走**嵌入版通道**
     * （插件 → iframe 的 `render.png` ✓，应用侧复用 `svgToCanvas` ⇒ 与 GUI 导出同一套 ✓）。
     * 依赖：① 嵌入版 RPC 总开关已开（默认关 ✓）② 嵌入版已打开过（否则 `appRpc` 会明确报错 ✓）。
     */
    this.addCommand({
      id: 'export-jps-png',
      name: '导出当前谱面为 PNG（需要嵌入版通道）',
      checkCallback: (checking) => {
        if (!contextSource()) return false
        if (!checking) {
          void (async () => {
            const c = await contextSourceAsync()
            if (!c) return
            if (this.appRpc === null) {
              new Notice('iJipu：嵌入版通道不可用（请先打开一次嵌入版 iJipu）')
              return
            }
            try {
              /**
               * adj845（用户实测：窗口选对 ✓、总开关开 ✓、服务无错误 ✓，但 `render.png` **无应答** ✗）：
               * 用一个**应用已支持的轻量方法**先探活 ✓ —— 若探针也不通 ⇒ 是**通道本身**的问题（桥没装/被拦 ✗）；
               * 若探针通、PNG 不通 ⇒ 是 **PNG 那条链路**的问题（canvas/字体/分页 ✗）。一次就能分清 ✓。
               */
              let ping = '未探'
              let probeSvgs: string[] = []
              try {
                const r = await this.appRpc.request<{ svgs: string[] }>('render.svg', { source: c.source }, 4000)
                probeSvgs = r.svgs
                ping = `render.svg 探针通了 ✓（${r.svgs.length} 页）`
              } catch (e) {
                ping = `render.svg 探针也不通 ✗ —— ${e instanceof Error ? e.message : String(e)}`
                new Notice(`iJipu：嵌入版通道不通（${ping}）`, 8000)
                this.lastEmbedError = `${new Date().toLocaleTimeString()} · ${ping}`
                return
              }
              /**
               * adj863（T-3 定稿）：范围 = **谱面** ⇒ 用**刚探测到的**产物算墨迹盒（同一份源码、
               * 同一套排版 ⇒ 页宽一致），再把**盒**交给应用侧 —— 应用只做 `applyRangeToSvg()`，
               * **不重算几何** ✗（两边各算一遍必漂；"一处口径"是这条的由来）。
               */
              const ranged = this.applyExportRange(c.source, probeSvgs)
              if (ranged.error !== undefined) {
                new Notice(`iJipu：导出范围「谱面」不可用 —— ${ranged.error}`, 8000)
                this.lastEmbedError = `${new Date().toLocaleTimeString()} · 导出谱面范围不可用：${ranged.error}`
                return
              }
              const params: Record<string, unknown> = { source: c.source, scale: 2 }
              // 只有"导出谱面"才带 crop（整页范围不带 ⇒ 与改动前的请求逐字一致 ✓）
              if (ranged.box !== null) params.crop = ranged.box
              const res = await this.appRpc.request<{ pngs: string[] }>('render.png', params)
              const dir = c.file?.parent?.path ?? ''
              const base = (c.file?.basename ?? 'score').replace(/\.jps$/i, '')
              const made: string[] = []
              for (let i = 0; i < res.pngs.length; i += 1) {
                const b64 = res.pngs[i].split(',')[1] ?? ''
                const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
                const name = res.pngs.length > 1 ? `${base}-${i + 1}.png` : `${base}.png`
                const path = dir === '' || dir === '/' ? name : `${dir}/${name}`
                const existing = this.app.vault.getAbstractFileByPath(path)
                // Obsidian 的 `*Binary` 接口要 `ArrayBuffer`（不是 `Uint8Array` ✗）
                const bytesAsBuffer = bytes.buffer as ArrayBuffer
                if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytesAsBuffer)
                else await this.app.vault.createBinary(path, bytesAsBuffer)
                made.push(name)
              }
              new Notice(`iJipu：已导出 ${made.join('、')}`)
            } catch (e) {
              // 诚实报错：通道未启用/嵌入版没开/应用侧渲染失败 —— 原因原样透出 ✓
              new Notice(`iJipu：PNG 导出失败 —— ${e instanceof Error ? e.message : String(e)}`, 6000)
            }
          })()
        }
        return true
      },
    })

    /**
     * adj821（B3 补口）：**导出 MIDI** —— 与「导出 PNG」同构 ✓。
     * 为什么也走应用通道：应用侧的 `export.midi` 复用同一套 `buildPlaySequence` + `eventsToMidi`
     * 且**带应用当前的音色/声部设置** ✓；插件内 B1 的 `api` 故意不提供 MIDI（`capabilities.midi=false` ✓），
     * 以免出现"两条导出路径结果不同" ✗。
     */
    this.addCommand({
      id: 'export-jps-midi',
      name: '导出当前谱面为 MIDI（需要嵌入版通道）',
      checkCallback: (checking) => {
        if (!contextSource()) return false
        if (!checking) {
          void (async () => {
            const c = await contextSourceAsync()
            if (!c) return
            if (this.appRpc === null) {
              new Notice('iJipu：嵌入版通道不可用（请先打开一次嵌入版 iJipu）')
              return
            }
            try {
              const res = await this.appRpc.request<{ midiBase64: string; bytes: number }>('export.midi', { source: c.source })
              const bin = atob(res.midiBase64)
              const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
              const dir = c.file?.parent?.path ?? ''
              const base = (c.file?.basename ?? 'score').replace(/\.jps$/i, '')
              const path = dir === '' || dir === '/' ? `${base}.mid` : `${dir}/${base}.mid`
              const existing = this.app.vault.getAbstractFileByPath(path)
              if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes.buffer as ArrayBuffer)
              else await this.app.vault.createBinary(path, bytes.buffer as ArrayBuffer)
              new Notice(`iJipu：已导出 ${base}.mid（${res.bytes} 字节）`)
            } catch (e) {
              new Notice(`iJipu：MIDI 导出失败 —— ${e instanceof Error ? e.message : String(e)}`, 6000)
            }
          })()
        }
        return true
      },
    })

    this.addCommand({
      id: 'copy-jps-svg',
      name: '复制当前谱面的 SVG 源码到剪贴板',
      checkCallback: (checking) => {
        if (!contextSource()) return false
        if (!checking) {
          void (async () => {
            const c = await contextSourceAsync()
            if (!c) return
            // adj864：与「⋯ 更多 → 复制 SVG 文本」**同一份实现**（含导出范围裁剪）
            await this.copyScoreSvg(c.source)
          })()
        }
        return true
      },
    })

    this.addCommand({
      id: 'export-jps-svg',
      name: '导出当前谱面为 SVG 文件（存到同目录）',
      checkCallback: (checking) => {
        if (!contextSource()) return false
        if (!checking) {
          void (async () => {
            const c = await contextSourceAsync()
            if (!c) return
            const r = this.api.renderSvg(c.source)
            if (!r.ok) {
              new Notice(`iJipu：无法渲染 —— ${r.error ?? '未知原因'}`)
              return
            }
            // adj863（T-3）：同上——按设置裁到所选范围
            const ranged = this.applyExportRange(c.source, r.svgs)
            if (ranged.error !== undefined) {
              new Notice(`iJipu：导出范围「谱面」不可用 —— ${ranged.error}`, 8000)
              return
            }
            const dir = c.file?.parent?.path ?? ''
            const base = (c.file?.basename ?? 'score').replace(/\.jps$/i, '')
            const made: string[] = []
            for (let i = 0; i < ranged.svgs.length; i += 1) {
              const name = ranged.svgs.length > 1 ? `${base}-${i + 1}.svg` : `${base}.svg`
              const path = dir === '' || dir === '/' ? name : `${dir}/${name}`
              const existing = this.app.vault.getAbstractFileByPath(path)
              if (existing instanceof TFile) await this.app.vault.modify(existing, ranged.svgs[i])
              else await this.app.vault.create(path, ranged.svgs[i])
              made.push(name)
            }
            new Notice(`iJipu：已导出 ${made.join('、')}`)
          })()
        }
        return true
      },
    })
  }

  /** 切换排版辅助虚线（显示后可拖动虚线调边距/行距），并通知所有面板重画 */
  toggleGuides(): boolean {
    this.showGuides = !this.showGuides
    this.events.trigger(GUIDES_CHANGED)
    return this.showGuides
  }

  async onload(): Promise<void> {
    await this.loadSettings()
    this.workletUrl = this.makeWorkletUrl()
    // adj729：音色库文件的落点 = 插件自己的目录（`manifest.dir` 由 Obsidian 给出）
    // adj772（社区审核）：兜底路径**不硬编码 `.obsidian`** —— 配置目录可由用户改名，按 `vault.configDir` 拼
    this.bankFiles = createBankFileStore(
      this.app,
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
    )
    // adj741：留一份设置页实例的引用，供"打开音色库"（手机端）把设置面板切到「说明」页签
    this.settingsTab = new IJipuSettingTab(this.app, this)
    this.addSettingTab(this.settingsTab)

    // ① .jps 文件识别：注册专用视图 → 打开 .jps（含 [[xxx.jps]] 链接）即渲染为简谱
    this.registerView(VIEW_TYPE_IJIPU, (leaf) => new IJipuFileView(leaf, this))
    this.registerExtensions([JPS_EXTENSION], VIEW_TYPE_IJIPU)
    // ② ![[xxx.jps]] 嵌入兜底（Obsidian 已渲染则不重复渲染）
    registerJpsEmbeds(this)
    // ③ ```jps 代码块
    this.registerMarkdownCodeBlockProcessor('jps', (source, el, ctx) => {
      ctx.addChild(new IJipuBlock(this, source, el, ctx.sourcePath, () => safeSectionInfo(ctx, el)))
    })

    /**
     * ④ 文件列表里**文件夹右键菜单** → 「新建 JPS 文件」（用户要求）。
     *
     * `file-menu` 对文件与文件夹都会触发，这里只认文件夹（`TFolder`）；
     * 建好即打开（`.jps` 已注册为简谱视图 ⇒ 直接进谱面），命名与模板见 `newFile.ts`。
     * `setSection('action-primary')` = Obsidian 自带「新建笔记 / 新建文件夹」同一组
     * （从 `obsidian.asar` 核实的 section 名，见 `docs/RELEASE-NOTES.md`），排在它们之后。
     */
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder)) return
        menu.addItem((item) =>
          item
            .setTitle('新建 JPS 文件')
            .setSection('action-primary')
            .setIcon('file-plus')
            .onClick(() => void createJpsFile(this.app, file)),
        )
      }),
    )

    /**
     * ⑤ 点击**指向不存在的 `.jps` 的内部链接**（`[[谱名.jps]]`）→ 自动建文件并打开（用户要求）。
     *
     * 为什么用 document 上的**捕获**阶段监听：Obsidian 自己的链接点击处理挂在 `<a>` 元素上
     * （`t.onClickEvent(...)`，内部还看 `e.defaultPrevented`），捕获阶段先跑才能把它拦下来
     * ——这一步必须**同步**完成，所以判断逻辑抽成了纯函数 `planJpsLinkCreate`；
     * 建文件是异步的，放到拦截之后。
     */
    this.registerDomEvent(document, 'click', (evt) => this.onLinkClick(evt), { capture: true })

    /**
     * ⑥ 让 Obsidian 自己也把 `[[谱名.jps]]` 认成 **`.jps` 文件**（用户报：此前会建成 `谱名.jps.md`）。
     *
     * 注册创建器后，**非点击**路径（`Ctrl+Enter` 跟随链接、悬浮预览里的"打开链接"、
     * 其它插件调 `openLinkText`）也会正确建成 `谱名.jps`（落在链接所在笔记的同级目录）。
     * 那条路径建出来是**空文件** ⇒ 建完补默认模板。
     */
    registerJpsFileCreator(this.app)
    this.register(() => unregisterJpsFileCreator(this.app))
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!(file instanceof TFile) || file.extension !== JPS_EXTENSION) return
        if (!consumeJpsLinkCreate()) return
        if (file.stat.size === 0) void this.app.vault.modify(file, NEW_JPS_TEMPLATE)
      }),
    )

    // 切换笔记时自动结束所有试听（避免试听继续却失去控制）
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.stopAll()))

    /**
     * adj748（用户报：「jps 文件的源码模式切回**阅读模式**，还是源码，只是显示方式不同，
     * 而不是我们所希望的**预览视图**」）：
     *
     * 起因是 `adj744`：手机端「✎ 源码」把那个页签换成了**宿主的 markdown 视图**（源码模式）。
     * 于是用户再切"阅读模式"时，宿主的 markdown **阅读视图**又把这个 `.jps` 当 markdown 渲染
     * ⇒ 看到的还是源码（只是排版不同），**不是我们的谱面预览**。
     *
     * 期望的心智模型（用户原话）：**源码模式 = 宿主编辑器；阅读模式 = 我们的预览视图**。
     * 做法：监听布局变化，凡是"**某个 `.jps` 文件正躺在 markdown 视图的阅读模式里**"，
     * 就把它按扩展名重新打开 —— `.jps` 注册给本插件的文件视图 ⇒ 自动换回**谱面预览**。
     * （不监听源码模式：那条正是用户要的编辑态，保持不动；因此也不会来回打架。）
     */
    const schedulePreviewRestore = (): void => {
      if (this.previewRestorePending) return
      this.previewRestorePending = true
      window.requestAnimationFrame(() => {
        this.previewRestorePending = false
        this.restoreJpsPreview()
      })
    }
    this.registerEvent(this.app.workspace.on('layout-change', schedulePreviewRestore))
    this.registerEvent(this.app.workspace.on('active-leaf-change', schedulePreviewRestore))
    this.registerEvent(this.app.workspace.on('file-open', schedulePreviewRestore))

    /**
     * ⑦ adj724b（嵌入版）：完整 iJipu 应用页签。
     *
     * 三件事：
     *  ① 建桥（vault 读写 + postMessage 路由）——需要设置，故在 `loadSettings` 之后；
     *  ② 注册应用视图 + 左侧栏图标（图标显隐由设置项控制，见 `syncEmbedRibbon`）；
     *  ③ 全局收一条 `message` 监听（两个页签的 iframe 共用同一个桥）。
     */
    this.bridge = new IJipuBridge({
      app: this.app,
      token: '', // 服务启动后由 syncEmbedToken 填
      root: '',
      theme: () => (document.body.classList.contains('theme-dark') ? 'dark' : 'light'),
      // adj724b：把设置里的「跟随 Obsidian 主题」告知应用（它据此决定覆盖还是尊重用户选择）
      followTheme: () => this.settings.embedFollowTheme !== false,
      // adj724b：应用侧偏好/设置 → 插件 `data.json`（与 iframe 的 origin/端口解耦）
      kv: {
        all: async () => ({ ...this.embedKv }),
        get: (k) => this.embedKvGet(k),
        set: (k, v) => this.embedKvSet(k, v),
        remove: (k) => this.embedKvRemove(k),
      },
      /**
       * adj729（用户要求）：**音色库落在插件目录**——把"按 id 取的音源 URL"与"由插件导入"交给应用：
       *  · `bankUrls()`：应用不再自己下 32 MB，直接取插件目录里那份（随文库同步）；
       *  · `importSoundbank(id)`：应用里点「导入音色文件」时，由**插件**弹文件选择器并写进插件目录
       *    （32 MB 走 postMessage 要 base64 ≈43 MB，慢且吃内存 —— 让插件自己挑、自己写盘最省）。
       */
      bankUrls: () => this.bankUrls(),
      importSoundbank: (id) => this.importSoundfont(id),
    })
    // adj741：嵌入版 iJipu 的**完整编辑器视图**只注册在桌面端（它依赖本地 HTTP 服务）
    if (Platform.isDesktopApp) this.registerView(VIEW_TYPE_IJIPU_APP, (leaf) => new IJipuAppView(leaf, this))
    this.registerDomEvent(window, 'message', (ev) => {
      void this.bridge.handle(ev)
      /**
       * adj850（配套应用侧）：**嵌入版自报家门** —— 应用把桥装好后会发一条
       * `{ __ijipuAppHello: 1, href }` ✓。收到就记下来（复用报告里"嵌入版服务产物自检"那段 ✓），
       * 于是"桥到底有没有在 iframe 里执行"从**推断**变成**看得见** ✓：
       *  · 已收到 ⇒ 桥在跑 ✓（若仍无应答 ⇒ 是"拒绝/回包被拦"✗）；
       *  · 未收到 ⇒ 桥**没执行到安装** ✗（我会把安装再前移 ✓）。
       */
      const hello = ev.data as { __ijipuAppHello?: number; href?: string } | null
      if (hello !== null && typeof hello === 'object' && hello.__ijipuAppHello === 1) {
        const t = new Date().toLocaleTimeString()
        this.embedHelloInfo = `嵌入版自报家门：**已收到 ✓**（${t}；${String(hello.href ?? '').replace(/^https?:\/\//, '').slice(0, 50)}）`
      }
      // adj807（B2）：同一条 window message 监听里再交给嵌入版 RPC（它自己做来源校验与白名单 ✓）
      this.embedRpc?.handle(ev)
      // adj809（B3）：反方向请求器的**应答**也走这条监听 ✓
      this.appRpc?.handleResponse(ev)
    })
    /**
     * adj835（③ 专项）：挂上**源码态事件序列**的监听 ✓ ——
     * 命令面板（Ctrl+P）会夺走焦点 ⇒ 记录 `window.blur/focus` 与 `visibilitychange` ✓，
     * 再看那一刻"块态"是预览还是源码 ✓ ⇒ 就能判定"闪回"发生在**失焦时**还是**面板关闭时** ✓。
     * 全部走 `registerDomEvent`（随插件卸载自动摘除 ✓，不留监听 ✗）。
     */
    this.registerDomEvent(window, 'focus', () => this.logSourceModeEvent('window.focus'))
    this.registerDomEvent(window, 'blur', () => this.logSourceModeEvent('window.blur'))
    this.registerDomEvent(document, 'visibilitychange', () => this.logSourceModeEvent(`visibilitychange(${document.visibilityState})`))
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.logSourceModeEvent('active-leaf-change')))
    this.addCommand({
      id: 'open-app',
      name: '打开爱记谱',
      callback: () => void this.openIjipuApp(),
    })
    /**
     * adj800（方案 B 的 **B1**，用户已裁决「B1 开工」）：把插件能力做成
     * **① 命令面板命令**（给人用）+ **② 公开 JS API**（给别的插件/脚本用）。
     *
     * 分层口径（见 `docs/CLI-AND-COMMAND-PLAN.md` §B2）：**纯 TS 能力**留在插件内直调引擎
     * （`api.ts` ✓ 不跨 iframe、无网络、**手机端也可用** ✓）；需要**应用**的能力（位图/PDF、
     * 音色库试听）留给 B2/B3 的嵌入版 RPC ✓。
     *
     * `api` 挂在插件实例上：`app.plugins.plugins['ijipu'].api`（`Object.freeze` + `apiVersion` ✓）。
     * 设置用**函数**读取 ⇒ 用户改设置后 API 立刻跟随，不出现"设置变了 API 还是旧的"✓。
     */
    this.api = createIjipuApi(() => this.settings)
    /**
     * adj807（B2）：**嵌入版 RPC**（postMessage）——只做"要用应用才有的能力"的通道 ✓。
     *  · 纯 TS 能力仍在 `api.ts` 直调引擎（不绕 iframe ✓）；
     *  · 本通道**默认关闭**（`allowExternalApi`），开着时也只认**方法白名单** ✓；
     *  · 来源校验：只接受"src 带本插件 token 的 iframe"那个窗口 ✓（与 `IJipuBridge` 同一口径 ✓）。
     */
    this.embedRpc = createEmbedRpc({
      app: this.app,
      isEnabled: () => this.allowExternalApi,
      getIframeWindow: () => {
        for (const f of Array.from(document.querySelectorAll('iframe'))) {
          if (f.src.includes('token=') && f.contentWindow !== null) return f.contentWindow
        }
        return null
      },
      renderSvg: (source, pageConfig) => this.api.renderSvg(source, pageConfig as Partial<PageConfig> | undefined),
      pluginVersion: this.manifest.version,
    })
    this.appRpc = createAppRequester({ isEnabled: () => this.allowExternalApi, getIframeWindow: () => this.embedRpcWindow() })
    this.registerCommands()
    /**
     * adj746（用户要求：「源码如果能够按我们应用的规范格式化就更好了」）：
     * 命令面板入口（手机上尤其有用——不必去点文件工具条）。
     * 只对**当前打开的 `.jps` 文件视图**生效；代码块里的谱面请在谱面工具条上点「↹ 格式化」。
     */
    this.addCommand({
      id: 'format-jps',
      name: '格式化当前 .jps 源码（应用规范）',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(IJipuFileView)
        if (!view) return false
        if (!checking) view.formatSource()
        return true
      },
    })
    /**
     * adj749d（用户要求）：「建议**自动格式化**，即取消预览区的格式化图标，与应用中一样，
     * 在**光标位置离开本行时对该行进行自动格式化**」。
     *
     * 实现走 Obsidian 的**公开 `Editor` API**（不加 `@codemirror/*` 依赖 —— 本项目的规矩是
     * "新增依赖必须先询问"，而这里完全用不着）：
     *  · 监听 `selectionchange`（光标移动的可靠信号）；
     *  · 取当前编辑器的**光标行号**，与上一次比较，**变化时格式化刚离开的那一行**；
     *  · 只对**我们借宿主编辑器打开的 `.jps`** 生效（页签上有 `ijipu-plain-source` 标记，
     *    由 `fileView.openInObsidianEditor` 打上）⇒ **绝不碰真正的 markdown 笔记**；
     *  · 用引擎的 `formatLine`（与应用编辑器逐行格式化**同一份实现**），行没变就不动（不产生无谓撤销项）。
     */
    this.registerDomEvent(document, 'selectionchange', () => this.autoFormatLeavingLine())
    /**
     * adj752（用户要求）：「给手机端的源码使用**应用里的源码高亮方案**，而不是 Markdown 的高亮」。
     * 注册 CM6 扩展：只对"借宿主编辑器打开的 `.jps` 页签"（带 `ijipu-plain-source` 标记）着色，
     * 规则来自引擎 `tokenizeJpsLine`（与应用编辑器同一份口径），配色用应用的 `--jp-hl-*` 两套值。
     */
    this.registerEditorExtension(jpsHighlightExtension)
    this.syncEmbedRibbon()

    /**
     * adj724b：**把"库里的 `.jps` 被改了"推给嵌入版**（用户口径：外部修改要能被发现并提示）。
     *
     * 注意：嵌入版**自己每次即时保存也会触发这个事件**。所以这里不做判断，
     * 一律推给应用，由应用**比对内容**决定要不要提示（内容一致 ⇒ 我们自己写的 ⇒ 不打扰）。
     */
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!this.embedEnabled) return
        if (!(file instanceof TFile) || file.extension !== JPS_EXTENSION) return
        this.bridge.broadcast('fileChanged', { path: file.path })
      }),
    )
  }

  /**
   * 链接点击：只有「未解析 + `.jps` + 文件确实不存在」才接管。
   *
   * 与 Obsidian 的跟随语义保持一致：**源码模式**（非实时预览）下要按住 Ctrl/Cmd 才跟随链接，
   * 这里同样要求修饰键——否则点一下链接想放光标，却把文件建出来了。
   */
  private onLinkClick(evt: MouseEvent): void {
    const el = evt.target as HTMLElement | null
    const a = el?.closest?.('a.internal-link') as HTMLAnchorElement | null
    if (!a || !a.classList.contains('is-unresolved')) return
    const inEditor = a.closest('.cm-editor') !== null
    const livePreview = a.closest('.is-live-preview') !== null
    if (inEditor && !livePreview && !evt.ctrlKey && !evt.metaKey) return
    const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? ''
    const plan = planJpsLinkCreate(href, this.linkSourcePath(a), (p) => this.app.vault.getAbstractFileByPath(p) !== null)
    if (!plan) return
    // 同步拦下这次点击（再异步建文件）：否则事件会继续冒泡到 Obsidian 的链接处理器
    evt.preventDefault()
    evt.stopPropagation()
    void (async () => {
      const file = await materializeJpsFile(this.app, plan.path)
      if (file) await this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file)
    })()
  }

  /** 链接所在笔记的路径（嵌入 `![[笔记]]` 里的链接要按**被嵌入那篇**的目录算） */
  private linkSourcePath(el: HTMLElement): string {
    const embed = el.closest('.internal-embed, .markdown-embed') as HTMLElement | null
    const src = embed?.getAttribute('src')
    if (src) return src.split('#')[0]
    return this.app.workspace.getActiveFile()?.path ?? ''
  }

  onunload(): void {
    // 插件卸载（禁用/重载）时兜底停止所有试听
    this.stopAll()
    // adj724b：把嵌入版偏好的最后一次改动立即落盘（防抖窗口内的改动别丢）
    this.flushEmbedKv()
    // adj724b：释放本地服务（不释放会占着端口直到 Obsidian 退出）
    void this.disposeEmbed()
  }

  /** 停止所有进行中的试听 */
  stopAll(): void {
    for (const stop of this.playStops) stop()
    this.playStops = []
  }

  // ───────────────────────── adj724b：嵌入版（完整 iJipu） ─────────────────────────

  /** 嵌入版是否启用（设置开关；未设置视为开，符合"装上就能用"的预期） */
  get embedEnabled(): boolean {
    return this.settings.embedIjuipu !== false
  }

  /**
   * adj741：**按需加载**嵌入版本地服务模块（`node:http`/`node:crypto` 只存在于桌面端）。
   *
   * 手机端直接返回 `null`（调用方据此回退到原生渲染）；桌面端只加载一次并记住模块，
   * 同时把 `SOUNDFONT_URL_PREFIX` 记下来供同步函数 `bankUrls()` 用（它不能 await）。
   */
  private embedServerModule: typeof import('./embed/server') | null = null
  /** adj741：设置页实例（手机端"打开音色库"要把它切到「说明」页签） */
  private settingsTab: IJipuSettingTab | null = null
  /** adj748：`restoreJpsPreview()` 的合并标记（布局事件会连续来好几次，一帧只处理一次） */
  private previewRestorePending = false
  /** adj749d：上一次的"文件:光标行"，用于判断"光标离开了哪一行"（自动格式化用） */
  private lastFormatLineKey: string | null = null

  /**
   * adj748：把"躺在 markdown **阅读模式**里的 `.jps`"换回本插件的**谱面预览**。
   *
   * 判据三件：① 该 leaf 是 markdown 视图；② 它的文件扩展名是 `jps`；③ 视图模式是 `preview`（阅读模式）。
   * 命中就 `leaf.openFile(file)` —— `.jps` 在本插件里注册为专用视图，于是自动换成谱面预览。
   * ⚠ 只在阅读模式下动作：源码模式是用户要的编辑态（`adj744`），绝不打扰，因此不会来回切。
   */
  private restoreJpsPreview(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view as unknown as { file?: TFile | null; getMode?: () => string }
      const file = view.file
      if (!file || file.extension !== JPS_EXTENSION) continue
      if (typeof view.getMode === 'function' && view.getMode() !== 'preview') continue
      void leaf.openFile(file)
    }
  }

  /**
   * adj741：打开本插件的设置面板并切到指定页签（手机端点"打开音色库"时用）。
   * 走 Obsidian 的 `app.setting.open()` + `openTabById`（这是官方入口；拿不到就静默跳过）。
   */
  openSettingsTab(tab: '嵌入版' | '说明'): void {
    const setting = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void }
    }).setting
    setting?.open()
    setting?.openTabById(this.manifest.id)
    this.settingsTab?.activate(tab)
  }
  /** adj741：从按需加载的模块里取到的音源路径前缀（`bankUrls()` 同步用） */
  private soundfontPrefix = 'soundbanks/'

  private async loadEmbedServer(): Promise<typeof import('./embed/server') | null> {
    if (!Platform.isDesktopApp) return null
    if (!this.embedServerModule) {
      this.embedServerModule = await import('./embed/server')
      this.soundfontPrefix = this.embedServerModule.SOUNDFONT_URL_PREFIX
    }
    return this.embedServerModule
  }

  /**
   * adj749d：**光标离开本行时自动格式化该行**（借宿主编辑器打开的 `.jps` 页签）。
   *
   * 与应用编辑器同款行为（应用里 `docStore` 在输入防抖后逐行格式化）。
   * 判据：① 当前编辑器所属文件扩展名是 `jps`；② 它的页签带 `ijipu-plain-source` 标记
   * （只有我们主动切过去的那个页签有）⇒ 不会误伤 markdown 笔记。
   *
   * adj774（用户要求）：「**jps 代码块**应同时应用自动格式化……与手机版 jps 文件的源码编辑模式一致」。
   * 于是再加一条路径：**markdown 笔记里**，光标离开的那一行若落在 ` ```jps ` 块的**正文**里，
   * 同样按引擎 `formatLine` 规范化 —— 三项能力（着色/错误提示/自动格式化）现在覆盖同一组行。
   * 其余 markdown 文本一律不碰（判据是"这一行确实在 jps 块正文内"，不是"文件里出现了 jps"）。
   */
  private autoFormatLeavingLine(): void {
    const view = this.app.workspace.activeEditor
    const editor = view?.editor
    const file = view?.file
    if (!editor || !file) return
    // 页签标记从**活动 leaf 的视图容器**上找（`MarkdownFileInfo` 上没有 containerEl）
    const leafView = this.app.workspace.activeLeaf?.view
    const marked = leafView?.containerEl.closest('.workspace-leaf')?.hasClass('ijipu-plain-source')
    const isOurJpsFile = file.extension === JPS_EXTENSION && marked === true
    const isMarkdown = !isOurJpsFile && file.extension === 'md'
    if (!isOurJpsFile && !isMarkdown) return
    const line = editor.getCursor().line
    const key = `${file.path}:${line}`
    if (this.lastFormatLineKey === null) {
      this.lastFormatLineKey = key
      return
    }
    if (this.lastFormatLineKey === key) return
    // 上一处光标所在行 = 刚离开的那一行（格式只影响该行；行号在格式化过程中不变）
    const prevLine = Number(this.lastFormatLineKey.slice(this.lastFormatLineKey.lastIndexOf(':') + 1))
    this.lastFormatLineKey = key
    if (!Number.isInteger(prevLine) || prevLine < 0 || prevLine >= editor.lineCount()) return
    if (isMarkdown) {
      /**
       * ⚠ 只在"这一行确实在 ```jps 块正文里"时才格式化。
       * 大文档下 `getValue()` + 扫描是 O(行数)，但只在**换行**时各跑一次（不是每键），可接受；
       * 超过阈值就不猜了（宁可少格式化，也不能让打字变卡）。
       *
       * adj774e（发布前自审发现的**数据安全**问题）：围栏扫描的口径是"**未闭合的围栏延伸到文末**"
       * （这样用户刚敲 ` ```jps ` 还没写收尾时，着色/错误提示就已经生效 —— 见 `jpsBlocks.ts`）。
       * 但这条口径若**直接用在自动格式化上**就危险了：用户忘了写收尾围栏时，后面**普通正文**
       * 也会被当成块内行 ⇒ `formatLine` 一规范化就可能**悄悄改写他的文字**（例如把连续空格并成一个）。
       *
       * 所以自动格式化**只认已闭合的块**：装饰（着色/错误提示）照旧覆盖未闭合块 —— 那反而是个有用的
       * 提示"你还没收尾"；而"真去改文件"这件事必须保守。
       */
      if (editor.getValue().length > 200_000) return
      const blocks = jpsBlockRanges(editor.getValue())
      const line = prevLine + 1
      const closedBlock = blocks.some((b) => b.fenceEnd !== null && line >= b.bodyStart && line <= b.bodyEnd)
      if (!closedBlock) return
    }
    const before = editor.getLine(prevLine)
    const after = formatLine(before)
    if (after === before) return
    // 只替换这一行（保留撤销栈；光标位置由编辑器自行映射）
    editor.setLine(prevLine, after)
  }

  /**
   * 取 iframe 要加载的 URL；**懒启动**本地服务。
   *
   * 并发调用共享同一次启动（`embedServerStarting`），避免两个页签同时打开时起两个服务。
   * 服务启动后把 token 与工作区根告知桥。
   *
   * adj741：手机端**没有** `node:http` ⇒ 这里直接返回 `null`（调用方回退原生预览），
   * 而不是让静态导入把整个插件拖垮。
   */
  async getEmbedUrl(): Promise<string | null> {
    if (!this.embedEnabled && this.embedServer === null) return null
    if (!Platform.isDesktopApp) return null
    if (!this.embedServerStarting) {
      const mod = await this.loadEmbedServer()
      if (!mod) return null
      this.embedServerStarting = mod
        .startEmbedServer({
          workletCode,
          // adj729：把插件目录里的音源文件按路径交给嵌入版应用（同一个文件，随文库同步）
          readSoundfont: (id) => this.readSoundfont(id),
        })
        .then((s) => {
          this.embedServer = s
          this.bridge.setToken(s.token)
          /**
           * 工作区根一律是 **`''`（文库根）**：宿主按"文库相对路径"读写，
           * 应用侧记录的 `path` 也存文库相对路径 ⇒ 两者同口径。
           * 设置里的「子目录」是**进入工作区后的初始目录**，由应用侧 `makeVaultWorkspaceRecord`
           * 的 `path` 表达（这样"换目录"仍是应用内的正常导航，不会把用户锁死在子目录里）。
           */
          this.bridge.setRoot('')
          return s
        })
        /**
         * adj775（用户报「点编辑开了页签，但没有嵌入版显示」）：**失败必须能被重试**。
         *
         * 此前失败会让 `embedServerStarting` 变成**一个永远 rejected 的 promise** ⇒
         * 此后每次 `await` 都抛同一个错，页签里永远空白，用户也没有任何补救手段。
         * 现在这里把错误记进诊断、把 `embedServerStarting` **清回 null**（下一次打开即重试），
         * 并把它转成"返回 null"（视图侧会画出可读提示 + 重试按钮，见 `embed/appView.ts`）。
         */
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e)
          /**
           * ⚠ 这里**不写 `console.error`**（adj776c 自审去掉）：
           * 社区审核对 `console.*` 会报警告，而这条信息已经由 `lastEmbedError` 承载 ——
           * 它就显示在「设置 → iJipu → **诊断**」页签的「嵌入版本地服务」一块里（点一下即复制），用户能直接贴回来。
           */
          this.lastEmbedError = msg
          this.embedServerStarting = null
          this.embedServer = null
          return null
        })
    }
    const s = await this.embedServerStarting
    return s ? s.url : null
  }

  /** adj775：最近一次嵌入版服务启动失败的原因（设置页「说明」里显示，方便用户/我定位） */
  lastEmbedError: string | null = null

  /**
   * adj863（T-3 定稿）：**最近一次实测到的墨迹盒**（由谱面面板在量到内容包围盒时写入）。
   *
   * 为什么存在插件上：导出/复制走的是**命令**路径（没有面板、没有 DOM 可量），而"导出谱面"
   * 恰恰需要**实测墨迹** ⇒ 只能读"最近一次实测值"。`source` 是**必须**的：换了文件就视为"没量到"，
   * 命令会**明确报错**，绝不拿别的谱的盒去裁 ✗（`E-2026-*` 那类"导出成一条横带"就是这么来的）。
   * `mode`（adj864）供「跟随视图」用：命令路径没有面板，只能按"这份谱最近是以哪种模式显示的"推断。
   * `pageW/pageH`（adj864）用于**跨环境一致性核对**：图片渲染在嵌入版应用里做，若两边页面设置不同，
   * 墨迹盒就落在另一套坐标系里 ⇒ 必须**明确拒绝**（见 `resolveRangeBox`），而不是裁出一张错位的图 ✗。
   */
  lastInk: { source: string; box: RangeBox; mode: 'page' | 'full' | 'score'; pageW: number; pageH: number } | null = null

  /**
   * adj863/adj864：解析本次导出/复制的**范围盒**。
   *
   * · 设置为 `page` ⇒ `box: null`（**不做任何裁剪**，与改动前逐字一致）；
   * · 设置为 `score` ⇒ 用引擎 `rangeBox()` 算盒（墨迹 ± 每边 2px + 两道闸）；
   * · 设置为 `view`（**跟随视图**）⇒ 面板自己在 `⋯ 更多 → 导出范围` 里选了它时，按**该面板当前模式**
   *   解析（谱面 ⇒ score，整页/满宽 ⇒ page）；命令路径没有面板 ⇒ 按"这份谱最近一次显示的模式"。
   *
   * `pane` 是**面板路径**专供：它手里有**刚量到的**墨迹盒与当前模式，比插件上那份缓存新鲜
   * （用户改了谱再立刻复制时，缓存可能已过期 ⇒ 宁可不用）。
   */
  resolveRangeBox(
    source: string,
    svgs: string[],
    pane?: { box: RangeBox | null; mode: 'page' | 'full' | 'score' },
  ): { box: RangeBox | null; error?: string } {
    const setting: ExportRangeSetting = this.settings.exportRange ?? DEFAULT_EXPORT_RANGE
    if (setting === 'page') return { box: null }
    const cached = this.lastInk !== null && this.lastInk.source === source ? this.lastInk : null
    const effective: 'page' | 'score' =
      setting === 'view' ? ((pane?.mode ?? cached?.mode) === 'score' ? 'score' : 'page') : setting
    if (effective === 'page') return { box: null }
    const page = readViewBoxOf(svgs[0] ?? '')
    /**
     * adj864：**跨环境一致性**先在前面 —— 墨迹盒是在**面板的配置**下量的，而图片渲染在**嵌入版应用**里做。
     * 两边页面设置不同（应用里选了 A5、插件里 A4）⇒ 盒落在另一套坐标系 ⇒ 裁出来必然错位 ✗。
     * 宁可明确拒绝，也不产出一张"看着像裁过、其实错位"的图。
     */
    if (cached !== null && page !== null && (Math.abs(cached.pageW - page[2]) > 1 || Math.abs(cached.pageH - page[3]) > 1)) {
      return {
        box: null,
        error:
          `预览与嵌入版的页面尺寸不一致（预览 ${Math.round(cached.pageW)}×${Math.round(cached.pageH)}，` +
          `嵌入版 ${Math.round(page[2])}×${Math.round(page[3])}）—— 请让两边的页面设置一致，或改用「导出页面」范围`,
      }
    }
    const ink = pane !== undefined ? pane.box : (cached?.box ?? null)
    const out = rangeBox({
      range: 'score',
      pageW: page?.[2] ?? 0,
      pageH: page?.[3] ?? 0,
      ink,
      pad: RANGE_PAD_DEFAULT,
    })
    if (!out.ok) return { box: null, error: out.reason ?? '量不到墨迹盒' }
    return { box: out.box }
  }

  /**
   * adj863：按**导出范围**设置把渲染产物的画布口径裁到所选范围（SVG 文本类出口用）。
   *
   * 失败（没量到墨迹 / 量得不可信）⇒ 回 `error`，**由调用方明确报错**（不静默退回整页 ✗）。
   */
  applyExportRange(
    source: string,
    svgs: string[],
    pane?: { box: RangeBox | null; mode: 'page' | 'full' | 'score' },
  ): { svgs: string[]; box: RangeBox | null; error?: string } {
    const r = this.resolveRangeBox(source, svgs, pane)
    if (r.error !== undefined) return { svgs, box: null, error: r.error }
    return { svgs: r.box === null ? svgs : svgs.map((s) => applyRangeToSvg(s, r.box as RangeBox)), box: r.box }
  }

  /**
   * adj864（T-5「复制」组）：**复制为图片**（PNG → 剪贴板）。
   *
   * 三件事：
   *  ① 渲染在**应用侧**完成（插件没有 canvas）——走既有的 `render.png` 通道，与 GUI 导出**同一套**；
   *  ② 范围按设置/面板算好，**把盒交给应用**（应用只 `applyRangeToSvg`，不重算几何 ✓）；
   *  ③ 插件侧补 **pHYs（DPI = 72 × scale）** 再写剪贴板 —— 否则 Word/微信按 96 DPI 兜底，
   *     把 2× 渲染的 A4 谱插成 12 英寸巨图 ✗（`engine/png.ts`）。
   *
   * 多页谱：剪贴板只能放一张 ⇒ **复制第一页**并如实说明（不假装复制了全部 ✗）。
   */
  async copyScoreImage(
    source: string,
    scale: number,
    pane?: { box: RangeBox | null; mode: 'page' | 'full' | 'score' },
  ): Promise<void> {
    if (this.appRpc === null) {
      new Notice('iJipu：嵌入版通道不可用（请先打开一次嵌入版 iJipu，再复制图片）', 8000)
      return
    }
    try {
      // 探活 + 取页宽（范围要用页面尺寸；这一步与「导出 PNG」同一套路）
      const probe = await this.appRpc.request<{ svgs: string[] }>('render.svg', { source }, 4000)
      const ranged = this.resolveRangeBox(source, probe.svgs, pane)
      if (ranged.error !== undefined) {
        new Notice(`iJipu：复制为图片失败 —— ${ranged.error}`, 8000)
        return
      }
      const params: Record<string, unknown> = { source, scale }
      if (ranged.box !== null) params.crop = ranged.box
      const res = await this.appRpc.request<{ pngs: string[] }>('render.png', params)
      const first = res.pngs[0]
      if (first === undefined) {
        new Notice('iJipu：复制为图片失败 —— 应用没有返回图片')
        return
      }
      const b64 = first.split(',')[1] ?? ''
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
      const dpi = dpiForScale(scale)
      const withDpi = insertPngPhys(bytes, dpi)
      await copyPngBytesToClipboard(withDpi)
      const pages = res.pngs.length
      new Notice(
        pages > 1
          ? `iJipu：已复制第 1 页图片（${scale}×，${dpi} DPI；这份谱共 ${pages} 页，其余请用「导出 PNG」命令）`
          : `iJipu：已复制图片（${scale}×，${dpi} DPI）`,
      )
    } catch (e) {
      new Notice(`iJipu：复制为图片失败 —— ${e instanceof Error ? e.message : String(e)}`, 8000)
    }
  }

  /**
   * adj864（T-5「复制」组）：复制**SVG 文本**到剪贴板（菜单入口与命令 `copy-jps-svg` 共用一份实现）。
   *
   * 范围同样生效：`score` 时裁到墨迹 ± 每边 2px（走的还是引擎那一份几何 ✓）。
   */
  async copyScoreSvg(
    source: string,
    pane?: { box: RangeBox | null; mode: 'page' | 'full' | 'score' },
  ): Promise<void> {
    const r = this.api.renderSvg(source)
    if (!r.ok) {
      new Notice(`iJipu：无法渲染 —— ${r.error ?? '未知原因'}`)
      return
    }
    const ranged = this.applyExportRange(source, r.svgs, pane)
    if (ranged.error !== undefined) {
      new Notice(`iJipu：导出范围「谱面」不可用 —— ${ranged.error}`, 8000)
      return
    }
    try {
      await navigator.clipboard.writeText(ranged.svgs.join('\n<!-- 分页 -->\n'))
      new Notice(`iJipu：已复制 ${ranged.svgs.length} 页 SVG 源码到剪贴板`)
    } catch (e) {
      new Notice(`iJipu：复制失败 —— ${e instanceof Error ? e.message : String(e)}`, 6000)
    }
  }

  /** adj864（T-5「复制」组）：复制**谱面源码**文本（`.jps` 原文，便于发给别人/存档） */
  async copyScoreSource(source: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(source)
      new Notice(`iJipu：已复制谱面源码（${source.length} 字符）`)
    } catch (e) {
      new Notice(`iJipu：复制失败 —— ${e instanceof Error ? e.message : String(e)}`, 6000)
    }
  }

  /**
   * adj864：设置**导出范围**（菜单「导出范围」组 = 设置页那一项，**同一个值**）。
   *
   * 为什么菜单里也要能改：用户是在"要复制/导出"的那一刻才关心口径 ⇒ 不该逼他离开谱面去设置页。
   */
  setExportRange(range: ExportRangeSetting): void {
    if (this.settings.exportRange === range) return
    this.settings.exportRange = range
    void this.saveSettings()
    const label = range === 'view' ? '跟随视图' : range === 'score' ? '导出谱面（墨迹 + 每边 2px）' : '导出页面（整页 + 留白）'
    new Notice(`iJipu：导出范围 = ${label}`)
  }

  /**
   * 同步版本的 URL（只读已启动的服务）。
   *
   * `.jps` 文件视图的 `render()` 是**同步**的（`TextFileView` 的既有约定），
   * 没法 `await` 服务启动 ⇒ 用这个：**已启动**就给 URL，没启动就触发一次启动并返回 `null`
   * （该次渲染回退到轻量渲染，服务就绪后用户再打开就是完整版）。
   */
  peekEmbedUrl(): string | null {
    if (this.embedServer) return this.embedServer.url
    void this.getEmbedUrl() // 预热：下次打开即完整版
    return null
  }

  /**
   * adj724b：**嵌入版的偏好/设置存储**（落在插件自己的 `data.json`）。
   *
   * 为什么不能只用浏览器的 `localStorage`：它按 **origin** 隔离，而嵌入页面的 origin 是
   * `http://127.0.0.1:<port>` —— 端口一变就是"另一个站点" ⇒ 设置读不回来
   * （用户实测：「嵌入版本的全局设置没有保存，ob 重启后恢复为默认」）。
   * 存进插件设置文件后，与端口/origin 彻底解耦（换电脑/换浏览器都不丢）。
   */
  private embedKv: Record<string, string> = {}
  private embedKvSaveTimer = 0

  /** 读一条（同步，供桥的 `kvGet` 用） */
  embedKvGet(key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.embedKv, key) ? this.embedKv[key] : undefined
  }

  /** 写一条（防抖落盘：设置面板连续改动时不要每次都写文件） */
  embedKvSet(key: string, value: string): void {
    if (key === '') return
    this.embedKv[key] = value
    this.scheduleEmbedKvSave()
  }

  embedKvRemove(key: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.embedKv, key)) return
    delete this.embedKv[key]
    this.scheduleEmbedKvSave()
  }

  /** 防抖 300ms 落盘（与 Obsidian 自身设置写入同一 `data.json`，不额外建文件） */
  private scheduleEmbedKvSave(): void {
    if (this.embedKvSaveTimer !== 0) window.clearTimeout(this.embedKvSaveTimer)
    this.embedKvSaveTimer = window.setTimeout(() => {
      this.embedKvSaveTimer = 0
      void this.saveSettings({ from: 'embedKv' })
    }, 300)
  }

  /** 立即落盘（插件卸载时调，别丢最后一次改动） */
  flushEmbedKv(): void {
    if (this.embedKvSaveTimer === 0) return
    window.clearTimeout(this.embedKvSaveTimer)
    this.embedKvSaveTimer = 0
    void this.saveSettings({ from: 'embedKv' })
  }

  /** 左侧栏图标：按设置开关显隐（Obsidian 的 `addRibbonIcon` 返回元素，直接 detach/append） */
  syncEmbedRibbon(): void {    if (this.embedEnabled) {
      if (!this.ribbonEl) {
        this.ribbonEl = this.addRibbonIcon('music', '打开爱记谱', () => void this.openIjipuApp())
        this.ribbonEl.addClass('ijipu-ribbon')
        // 开发/排错用：控制台直接看到服务地址，便于在浏览器里对照排查
        void this.getEmbedUrl().then((u) => {
          if (u) console.log(`[iJipu] 嵌入版服务已就绪：${u}`)
        })
      } else if (!this.ribbonEl.isConnected) {
        // 之前被移除过：重新挂回左侧栏（`addRibbonIcon` 只在首次创建元素）
        document.querySelector('.workspace-ribbon .side-dock-actions')?.appendChild(this.ribbonEl)
      }
    } else if (this.ribbonEl) {
      this.ribbonEl.detach()
    }
  }

  /** 打开「爱记谱」应用页签（已开则聚焦） */
  async openIjipuApp(): Promise<void> {
    await this.openIjipuFile(null)
  }

  /**
   * adj724b（用户要求）：按设置里的「打开 .jps 的方式」打开（`null` = 只开应用，不指定文件）。
   *
   * 用户原话：「在嵌入版页签中添加一个下拉列表选择，默认打开方式，添加以下几个打开方式选择：
   * ① 右侧栏 ② 新的页签 ③ 当前页签 ④ 默认应用；并实现相应的打开方式，**默认选择为右侧栏**」。
   *
   * @param sourceLeaf 从 `.jps` 文件视图路由过来时传**它自己那个 leaf**——
   *   "当前页签"要的就地替换靠它，而不是靠猜（见 `openEmbedLeaf` 的说明）。
   */
  async openIjipuFile(file: TFile | null, sourceLeaf: WorkspaceLeaf | null = null): Promise<void> {
    const mode = this.settings.embedOpenMode ?? DEFAULT_EMBED_OPEN_MODE
    // adj727：判据收敛到纯函数（同一口径也用于"嵌入区工具栏要不要保留那枚链接"）
    if (embedEditLeavesObsidian(mode)) {
      if (!file) return // 没指定文件时"默认应用"无从谈起（侧栏图标就是这种情况）
      if (!canOpenWithDefaultApp(this.app)) {
        new Notice('「默认应用」仅在桌面端可用；已改为在右侧栏打开')
        await this.openEmbedLeaf(file, 'right', sourceLeaf)
        return
      }
      await openWithDefaultApp(this.app, file.path)
      return
    }
    await this.openEmbedLeaf(file, mode, sourceLeaf)
  }

  /**
   * adj785（用户实测）：「手机端，嵌入 jps 文件 `![[xxx.jps]]` 时，预览区也会出工具条，
   * 但**编辑按钮不可用，点击没有响应**，建议**点击编辑时直接进到 jps 文件，并进入源码编辑状态**」。
   *
   * 原因：嵌入区的「编辑」走的是 `openIjipuFile()` ⇒ 手机端那条路只会弹
   * 「完整编辑器（嵌入版 iJipu）仅桌面端可用…」并返回 ⇒ 用户感受就是"点了没反应"。
   * 现在按用户建议：**打开该 `.jps` 文件（它自己的文件视图）并直接切到源码编辑**
   * —— 手机端就是"用 Obsidian 编辑器打开源码"（`IJipuView.toggleSource()` 内部按平台分派）。
   */
  async openJpsForSourceEdit(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf('tab')
    await leaf.openFile(file)
    const view = leaf.view as unknown as { toggleSource?: () => void }
    if (typeof view.toggleSource === 'function') view.toggleSource()
    this.app.workspace.revealLeaf(leaf)
  }

  /**
   * adj796（用户要求）：「**要有一个相对缜密的诊断方式，不要一直来回交互**，手机反馈诊断并不方便」。
   *
   * 所以这里做**一次点、给全信息**的完整报告：环境 + 当前活动面板的**滚动链路** + **工具条实物**
   * （在 DOM 哪里、内联样式、是否显示、坐标）+ 面板布局（影响滚动的那些计算值）+ 最近两条交互记录。
   *
   * 设计原则（都是为了"一轮定位"）：
   *  · **在同一时刻、对同一棵树取样** —— 不做多次交互，避免"两次快照对不上"；
   *  · 只输出**可判定的事实**（计算值/坐标/scrollHeight），不写主观描述；
   *  · 结果整段可复制（诊断页有按钮，且自动进剪贴板）。
   */
  buildDiagnosticsReport(): string {
    const lines: string[] = []
    const push = (s: string): void => void lines.push(s)
    const platform = Platform.isDesktopApp ? '桌面' : Platform.isMobileApp ? '手机' : '未知'
    push('【完整诊断报告】（一次取样；直接粘贴给开发者）')
    push(`插件 ${this.manifest.version}｜嵌入版 ${WEBAPP_META.appVersion}｜构建 ${BUILD_STAMP} @${GIT_COMMIT}`)
    push(`平台 ${platform}｜视口 ${window.innerWidth}×${window.innerHeight}｜DPR ${window.devicePixelRatio}`)
    push(`is-mobile 类 ${document.body.classList.contains('is-mobile') ? '有' : '无'}｜主题 ${document.body.classList.contains('theme-dark') ? 'dark' : 'light'}`)

    /** 取一个元素的"影响滚动/裁剪"的关键计算值 */
    const factsOf = (el: Element): string => {
      const cs = window.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const h = el as HTMLElement
      const name = (el.className || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.') || el.tagName.toLowerCase()
      return (
        `${name}[overflowY=${cs.overflowY} touchAction=${cs.touchAction} contain=${cs.contain} transform=${cs.transform === 'none' ? 'none' : 'yes'} ` +
        `height=${cs.height} flex=${cs.flex} scroll=${h.scrollHeight}/${h.clientHeight} rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}]`
      )
    }

    /** 当前活动的预览容器（优先 `.jps` 文件视图，其次代码块/嵌入里的面板） */
    const activeContainer =
      document.querySelector<HTMLElement>('.ijipu-file-view') ??
      document.querySelector<HTMLElement>('.ijipu-cm-host .ijipu-score') ??
      document.querySelector<HTMLElement>('.ijipu-embed .ijipu-score') ??
      document.querySelector<HTMLElement>('.ijipu-score')

    push('')
    push('— 滚动链路（从预览容器往上）—')
    if (!activeContainer) {
      push('（当前页面找不到本插件的预览容器：请先打开一份 `.jps` 或含 ` ```jps ` 的笔记）')
    } else {
      let el: HTMLElement | null = activeContainer
      let depth = 0
      while (el && depth < 12) {
        depth += 1
        push(`  ${factsOf(el)}`)
        el = el.parentElement
      }
      // 明确回答"到底有没有东西可滚、由谁滚"
      const scrollers: string[] = []
      let probe: HTMLElement | null = activeContainer
      let d2 = 0
      while (probe && d2 < 12) {
        d2 += 1
        const cs = window.getComputedStyle(probe)
        if (/auto|scroll/.test(cs.overflowY) && probe.scrollHeight > probe.clientHeight + 1) {
          scrollers.push((probe.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') || probe.tagName.toLowerCase())
        }
        probe = probe.parentElement
      }
      push(`  小结：可滚容器 = ${scrollers.length > 0 ? scrollers.join(' / ') : '（一个都没有 ⇒ 滚动不可能发生）'}`)
    }

    push('')
    push('— 工具条实物 —')
    const bars = Array.from(document.querySelectorAll<HTMLElement>('.ijipu-score-toolbar'))
    if (bars.length === 0) push('  （DOM 里没有工具条元素）')
    for (const el of bars) {
      const cs = window.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const parent = el.parentElement
      const where = parent === document.body ? 'document.body' : `容器内（父=${(parent?.className || '').split(/\s+/).slice(0, 2).join('.') || parent?.tagName}）`
      push(
        `  ${where}｜面板id=${el.dataset.ijipuPane ?? '?'}｜revealed=${el.hasClass('is-revealed') ? 'Y' : 'N'}` +
          `｜userHidden=${el.hasClass('is-user-hidden') ? 'Y' : 'N'}｜visibility=${cs.visibility} opacity=${cs.opacity} position=${cs.position}` +
          `｜rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}｜inline=${el.getAttribute('style') ?? '（无）'}`,
      )
    }

    push('')
    push('— 面板布局 —')
    const pane = document.querySelector<HTMLElement>('.ijipu-score')
    if (pane) push(`  ${factsOf(pane)}`)
    const svgs = document.querySelector<HTMLElement>('.ijipu-svgs')
    if (svgs) push(`  ${factsOf(svgs)}`)

    push('')
    push('— 最近交互记录 —')
    push(`  工具条：${this.lastToolbarInfo ?? '（无）'}`)
    push(`  点击/滚动：${this.lastToolbarClick ?? '（无）'}`)
    push(`  裁剪：${this.lastCropInfo ?? '（无）'}`)
    push(`  嵌入版服务：${this.lastEmbedError ?? '（无错误）'}`)

    push('')
    push('— 插件自身位置（adj855；定位"我更新的目录 ≠ Obsidian 加载的目录"）—')
    push(`  插件目录 manifest.dir = ${this.manifest.dir ?? '（未知）'}｜id=${this.manifest.id}｜版本=${this.manifest.version}`)
    push('  （若该目录不是 D:\\蜗居笔记\\悟乐居杂记\\.obsidian\\plugins\\ijipu ⇒ 说明你库里还有副本在被加载 ✓）')

    push('')
    push('— 嵌入版服务产物自检（adj847；**若显示"（本次取样后才取回，请再点一次生成并复制）"就再点一次** ✓）—')
    push(`  ① 自报家门：${this.embedHelloInfo ?? '**未收到 ✗**（桥没执行到安装，或嵌入视图没重开 ⇒ 请关掉嵌入版视图再打开一次，然后重载插件）'}`)
    push(
      `  ② 服务端产物：${this.embedServeInfo ?? '（本次取样后才取回，请再点一次「生成并复制」即可看到结果 ✓）'}`,
    )

    push('')
    push('— 嵌入版 iframe 候选（用于定位「未在 N 秒内应答」）—')
    {
      const frames = Array.from(document.querySelectorAll('iframe'))
      if (frames.length === 0) push('  （页面里没有 iframe ⇒ 嵌入版确实没打开过）')
      const chosen = this.embedRpcWindow()
      for (let i = 0; i < frames.length; i += 1) {
        const f = frames[i]
        const src = f.src === '' ? '(空)' : f.src.replace(/^https?:\/\//, '').slice(0, 60)
        const win = f.contentWindow
        const same = win !== null && win === chosen ? '**← 插件会发给它**' : ''
        // 能否读到 iframe 内部（同源才可读；读不到不影响 postMessage ✓，但能佐证托管方式）
        let probe = '未知'
        try {
          const doc = win?.document
          probe = doc === undefined || doc === null ? '不可读(跨源?)' : `可读,readyState=${doc.readyState}`
        } catch {
          probe = '不可读(跨源)'
        }
        const visible = f.offsetWidth > 0 && f.offsetHeight > 0 ? '可见' : '隐藏/零尺寸'
        push(`  #${i + 1} ${visible}｜src=${src}｜contentWindow=${win === null ? '空' : '有'}｜内部=${probe} ${same}`)
      }
      push(`  嵌入版服务错误：${this.lastEmbedError ?? '（无错误）'}｜总开关 allowExternalApi=${this.allowExternalApi ? '开' : '关'}`)
    }

    push('')
    push('— 嵌入版服务**实际发出的**产物是否含桥（adj847 ✓）—')
    /**
     * adj847（用户实测：探针仍不通 ✗，而报告构建是 `@f059a55a` ✓）：
     * 需要分辨两种可能 ——
     *  (a) iframe 里跑的还是**旧的应用 JS**（嵌入视图没真正重载 ✗）；
     *  (b) 顶层安装仍未生效 ✗。
     * 做法：**直接向嵌入版本机服务取一次 HTML** ✓，看**服务端正在发的**那份产物里
     * 有没有桥的关键字（`__ijipuAppResponse` ✓）与体积 ✓ ——
     * 有 ⇒ (a)（**重开嵌入视图**即可 ✓）；没有 ⇒ 产物没更新成功 ✗。
     */
    push(
      (() => {
        const win = this.embedRpcWindow()
        const frames = Array.from(document.querySelectorAll('iframe'))
        const url = frames.map((f) => f.src).find((s) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(s)) ?? ''
        if (url === '') return '  （取不到嵌入版 URL ⇒ 没打开过嵌入版）'
        return `  目标：${url.replace(/^https?:\/\//, '').slice(0, 60)}｜窗口=${win === null ? '无' : '有'}｜` +
          '（下面这次取回是**异步**的，稍后本报告末尾会补一行结果 ✓）'
      })(),
    )
    void (async () => {
      try {
        const frames = Array.from(document.querySelectorAll('iframe'))
        const url = frames.map((f) => f.src).find((s) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(s)) ?? ''
        if (url === '') return
        const html = (await requestUrl(url)).text
        /**
         * adj853：加一个**新版嵌入产物独有**的标记 —— `Obsidian 桥已安装`（adj852 才有的日志串 ✓）。
         * 用它回答"**插件此刻内存里到底是不是新产物**"✓：
         *  · 是 ✓ ⇒ 插件已换产物 ✓（那"没有安装日志"就是安装仍没执行 ✗ ⇒ 把安装再前移 ✓）；
         *  · 否 ✗ ⇒ 插件**仍在发旧产物** ⇒ 只需**真正重载插件** ✓（我重建后必须重载 ✓）。
         */
        this.embedServeInfo =
          `取回 ${html.length} 字符｜桥关键字=$${html.includes('__ijipuAppResponse') ? '是 ✓' : '否 ✗'}` +
          `｜**新版 ASCII 标记 bridge-installed**=${html.includes('bridge-installed') ? '**是 ✓（服务端已在发新产物）**' : '**否 ✗（服务端仍在发旧产物！）**'}` +
          `｜html 头部=${html.slice(0, 40).replace(/\s+/g, ' ')}`
      } catch (e) {
        this.embedServeInfo = `取回失败：${e instanceof Error ? e.message : String(e)}`
      }
    })()

    push('')
    push('— 源码态事件序列（最近 12 条；用于定位"按 Ctrl+P 闪回预览"）—')
    if (this.sourceModeLog.length === 0) push('  （还没记录到事件：先在 jps 代码块源码态按一次 Ctrl+P 再回来）')
    for (const l of this.sourceModeLog) push(`  ${l}`)
    return lines.join('\n')
  }

  /**
   * adj728（用户要求）：**打开嵌入版 iJipu 的「设置 → 音色库」**。
   *
   * 用途：插件那条"试听失败"提示上的按钮。音源（GeneralUser GS，32MB）自动下载在部分网络
   * 不可达，唯一出路是**手动下载 + 导入**，而导入入口在嵌入版应用的「设置 → 音色库」里
   * （面板上还有「打开下载页」按钮与三步引导）。
   *
   * 时序：与 `openFile` 同一条约束 —— **iframe 装好监听（`ready`）才推事件**，否则会丢。
   * 所以这里先把应用开起来（必要时等它 ready），再推 `openSoundbankSettings`。
   */
  async openEmbedSoundbank(): Promise<void> {
    /**
     * adj741（手机端 P0）：手机端没有嵌入版 ⇒ 这里改为**打开插件设置** ——
     * 「说明」页签里新加了「音色库（高保真试听的音源）」入口（导入 `.sf2` + 显示就位状态），
     * 否则手机用户点了"打开音色库"会什么都没发生。
     */
    if (!Platform.isDesktopApp) {
      this.openSettingsTab('说明')
      return
    }
    /**
     * adj776b：桌面端但**嵌入版开关关着** ⇒ 和手机端同一处置（打开设置里的「说明」页签）。
     * 这里有个真实场景：试听失败提示上的按钮就是调本方法的 —— 开关关着时若还去开嵌入版视图，
     * 用户会看到一个写着"未启用"的死页签；改成直接把他送到能解决问题的那一页。
     */
    if (!this.embedEnabled) {
      this.openSettingsTab('说明')
      new Notice('「使用嵌入版 iJipu（完整应用）」当前是关闭的 ⇒ 已打开设置里的「说明」页（含音色库入口）。', 6000)
      return
    }
    await this.openIjipuFile(null)
    // 只推给**已 ready**的帧；这一轮一个都没推出去（应用还在启动）就过 400ms 再试，最多三次
    const push = (attempt = 0): void => {
      if (!this.bridge) return
      const sent = this.bridge.openSoundbankSettings()
      if (!sent && attempt < 3) window.setTimeout(() => push(attempt + 1), 400)
    }
    window.setTimeout(() => push(), 200)
  }

  /**
   * adj724b：按设置把嵌入版开在**右侧边栏 / 新页签 / 当前页签**；给了 `file` 就打开那份 `.jps`。
   *
   * ## `sourceLeaf`：从文件视图路由过来时，把**它自己那个 leaf** 交进来
   *
   * 这是本方法最关键的参数。用户实测「当前页签没生效」说明：
   * 靠 `getMostRecentLeaf()` / `getLeaf(false)` 去**猜**"当前页签"不可靠——
   * Obsidian 的 leaf 调度、以及"右栏是否已有 iJipu 页签"都会改变结果。
   *
   * 而点 `.jps` 的真实语义是确定的：**Obsidian 为它创建了一个文件视图页签**。于是：
   *  · 「当前页签」⇒ **就地替换那个 leaf**（它正是用户点开的页签，最符合预期）；
   *  · 「新页签」  ⇒ 另开一个，并把那个中间页签**关掉**；
   *  · 「右侧栏」  ⇒ 在右栏开，并把那个中间页签**关掉**。
   *
   * 不给 `sourceLeaf`（例如点侧栏图标打开应用）时才退回 `getLeaf(...)` 的猜法。
   */
  async openEmbedLeaf(
    file: TFile | null,
    mode: EmbedOpenMode = DEFAULT_EMBED_OPEN_MODE,
    sourceLeaf: WorkspaceLeaf | null = null,
  ): Promise<void> {
    /**
     * adj741（手机端 P0）：嵌入版完整编辑器依赖本地 HTTP 服务 ⇒ **只在桌面端可用**。
     * 手机端给一句明确提示后返回（而不是让 `setViewState` 指向一个没注册的视图类型）。
     */
    if (!Platform.isDesktopApp) {
      new Notice('完整编辑器（嵌入版 iJipu）仅桌面端可用；手机端请直接看谱面预览与试听。')
      return
    }
    /**
     * adj776b（上一条用户报障的同族缺口）：**开关关着时任何入口都不该开出一个"死页签"**。
     *
     * 用户报的是文件视图的「编辑」，但同一个坑还有别的入口（例如"试听失败 → 打开音色库设置"
     * 走的就是 `openIjipuFile(null)`）。这里在**唯一的下层出口**兜住：未启用就不建视图，
     * 只给一句能照着做的提示。调用方若要"更贴心的落点"（如音色库 ⇒ 打开设置说明页）自行先处理。
     */
    if (!this.embedEnabled) {
      new Notice(
        '「使用嵌入版 iJipu（完整应用）」当前是关闭的 ⇒ 没打开嵌入版。' +
          '要使用完整编辑器：设置 → iJipu → 嵌入版 → 打开该开关。',
        6000,
      )
      return
    }
    const { workspace } = this.app
    /**
     * "开在哪里"由**纯函数**决定（`embed/openPlan.ts`）——这样它可被直接断言，
     * 而不是像此前那样只能对 `main.ts` 做**字符串匹配**（脆、且注释里写同样的字会误判）。
     */
    const plan = planEmbedTarget(mode, sourceLeaf !== null)
    /**
     * adj724b：**决策日志**。
     *
     * 用户实测反复"没生效"时，日志是唯一能看清"到底选了哪个 leaf"的手段——
     * 这个环境里我无法运行 Obsidian，只能靠这条日志把运行时事实带回来。
     */
    console.info(
      `[iJipu] 打开方式=${mode} 来源页签=${sourceLeaf ? sourceLeaf.getViewState().type : '（无）'}` +
        ` ⇒ 动作=${plan.kind} detachSource=${plan.detachSource}`,
    )
    let target: WorkspaceLeaf | null
    if (plan.kind === 'replace-source') {
      // 「当前页签」：
      //  · 由文件视图路由而来 ⇒ 就地替换**它自己**那个 leaf（语义确定，最符合预期）；
      //  · 否则取**主编辑区最近使用的** leaf。
      //    ⚠ 不能用 `getLeaf(false)`：它的语义是"返回一个**可导航的既有 leaf**"，
      //      当 iJipu 已占着右栏 leaf 时它会**优先返回那个**（用户实测踩到）。
      target = sourceLeaf ?? workspace.getMostRecentLeaf(workspace.rootSplit) ?? workspace.getLeaf(false)
      if (!sourceLeaf && !target) return
    } else if (plan.kind === 'right-sidebar') {
      target = workspace.getRightLeaf(false) ?? workspace.getLeaf('tab')
      workspace.rightSplit?.expand()
    } else {
      target = workspace.getLeaf('tab')
    }
    if (!target) return

    /**
     * 切到目标 leaf 并**直接驱动视图**打开文件。
     *
     * 早先的做法是把路径塞进 `pendingOpenPaths` 并靠 `ViewState.state` 里的令牌让
     * `onOpen()` 去取——但那依赖"`setViewState()` 会重建视图"这个不成立的假设：
     * **复用同一个 leaf 时 Obsidian 不会重建视图**，`onOpen` 不再跑 ⇒ 令牌没人读 ⇒
     * 表现为"只展开了右栏/切了页签，应用里没打开文件"（用户实测）。
     */
    const isSameLeaf = sourceLeaf !== null && target === sourceLeaf
    await target.setViewState({ type: VIEW_TYPE_IJIPU_APP, active: true })
    await workspace.revealLeaf(target)
    if (file) {
      const view = target.view as unknown as { openFile?: (path: string) => void | Promise<void> }
      if (typeof view.openFile === 'function') {
        await view.openFile(file.path)
      } else {
        // 兜底：视图实现变了（拿不到 `openFile`）⇒ 退回令牌机制
        const token = `ijipu-${++this.leafSeq}`
        this.pendingOpenPaths.set(token, file.path)
        await target.setViewState({ type: VIEW_TYPE_IJIPU_APP, active: true, state: { openToken: token } })
      }
    }
    /**
     * 关掉中间页签（Obsidian 因 `registerExtensions` 为 `.jps` 必然创建的那个）。
     * 放在**最后**、且与"目标 leaf"分开判断：这一步此前因调度顺序没生效，
     * 用户看到的现象是"多余页签还在 / 像开在新页签"。
     */
    if (plan.detachSource && !isSameLeaf && sourceLeaf) {
      console.info(`[iJipu] 打开方式=${mode}：已在新位置打开，关闭中间页签（${sourceLeaf.getViewState().type}）`)
      sourceLeaf.detach()
    } else if (isSameLeaf) {
      console.info(`[iJipu] 打开方式=${mode}：就地替换来源页签（不关）`)
    }
  }

  /** 释放嵌入版服务（关掉开关 / 卸载插件时） */
  async disposeEmbed(): Promise<void> {
    const s = this.embedServer
    this.embedServer = null
    this.embedServerStarting = null
    if (s) await s.dispose()
  }

  /** 登记/注销一个试听停止函数（供 active-leaf-change 与卸载时统一停止） */
  registerPlay(stop: () => void): void {
    this.playStops.push(stop)
  }

  unregisterPlay(stop: () => void): void {
    this.playStops = this.playStops.filter((f) => f !== stop)
  }

  /** 内置 worklet 的 Blob URL（供试听时 addModule） */
  getWorkletUrl(): string {
    return this.workletUrl
  }

  /** adj729：音色库文件的存储层（插件目录；见 `bankFile.ts` 的说明） */
  getBankFiles(): BankFileStore | null {
    return this.bankFiles
  }

  /** adj729：音色库文件的路径（诊断/设置页显示用；未初始化时给空串） */
  soundfontPath(id: string): string {
    return this.bankFiles?.pathOf(id) ?? ''
  }

  /** adj729：把服务端的音源 URL 交给嵌入版应用（见 `BridgeHost.bankUrls`） */
  bankUrls(): Record<string, string> {
    const base = this.embedServer?.url
    if (!base) return {}
    const out: Record<string, string> = {}
    // adj741：前缀来自按需加载的服务模块（桌面端已加载时才有真值；手机端恒走不到这里）
    for (const lib of HQ_LIBRARIES) out[lib.id] = `${base}${this.soundfontPrefix}${lib.id}.sf2`
    return out
  }

  /** adj729：嵌入版应用要的音源字节（服务端按路径读插件目录里的文件；读不到给 null） */
  async readSoundfont(id: string): Promise<Buffer | null> {
    const ab = await this.bankFiles?.read(id)
    return ab ? Buffer.from(ab) : null
  }

  /**
   * adj729（用户要求）：**由插件导入音源文件**（嵌入版应用里点「导入音色文件」时走这里）。
   *
   * 为什么不让应用把字节发过来：SF2 有 32 MB，`postMessage` 传 ArrayBuffer 要 base64，
   * 慢且吃内存。插件在 Obsidian 主窗口里弹一次文件选择器、直接写进插件目录最省。
   * 导入后写进插件目录 ⇒ **随文库一起走**（用户口径），应用随后从这个 URL 取用。
   */
  async importSoundfont(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
    if (!this.bankFiles) return { ok: false, error: '插件未就绪' }
    return this.bankFiles.importFromPicker(id)
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, await this.loadData())
    /**
     * adj724b：取出嵌入版的偏好/设置表（应用侧 `localStorage` 的替身）。
     * 单独一个键存着，避免与 `IJipuSettings` 的字段混在一起（那是个平铺对象）。
     */
    const raw = (this.settings as { embedKv?: unknown }).embedKv
    this.embedKv = raw && typeof raw === 'object' ? ({ ...(raw as Record<string, string>) } as Record<string, string>) : {}
  }

  /**
   * 保存插件设置。
   *
   * @param opts.from 调用方标识：`'settingsTab'` = 「设置 → iJipu」页签自己改的。
   *   adj631（用户报"预览页面的设置与 设置-iJipu 里的设置项不同步"）：
   *   别处（谱面预览对话框「保存为插件默认」）改完设置后，**让开着的设置页签就地重画**，
   *   否则那一页还停在旧值上、看起来两边不一致；页签自己改的不重画——会打断正在输入的控件焦点。
   */
  async saveSettings(opts?: { from?: 'settingsTab' | 'embedKv' }): Promise<void> {
    /**
     * adj724b：把嵌入版偏好表一并落盘。放在 `this.settings` 的一个专用键下，
     * 不污染 `IJipuSettings` 的平铺字段（那些是插件自己的渲染设置）。
     */
    ;(this.settings as { embedKv?: Record<string, string> }).embedKv = this.embedKv
    await this.saveData(this.settings)
    // 设置面板改动后广播：打开中的谱面即时按新设置重渲染（此前要重开笔记才生效）
    this.events.trigger(SETTINGS_CHANGED)
    // 嵌入版存储的落盘**不触发**设置页重画（那是插件设置，跟它无关，重画会打断输入焦点）
    if (opts?.from !== 'settingsTab' && opts?.from !== 'embedKv') this.settingsRefresh?.()
  }

  /** 登记/注销「设置 → iJipu」页签的重画回调（页签 `display()` 时登记、`hide()` 时注销） */
  registerSettingsRefresh(fn: (() => void) | null): void {
    this.settingsRefresh = fn
  }

  /**
   * adj724b：「谱面」视图的**裁剪实况**（最近一次渲染写回，供设置页显示）。
   *
   * 为什么要有：裁剪依赖运行时的 `getBBox()` 量取，而我无法在本地复现 Obsidian 宿主环境。
   * 把「页面尺寸 → 裁剪后尺寸 / 是否退回边距兜底」显示在设置页，用户一句话就能区分
   * 「代码没生效（多为未重新构建）」与「裁剪生效但仍有空白」。
   * 内存字段即可——它是运行期诊断，不需要持久化。
   */
  lastCropInfo: string | null = null

  /**
   * adj740（用户报「插件的预览区左上工具条在**编辑视图**下还是不可见，只能在阅读视图下可见」）：
   * **预览工具条为什么没显示**的实测快照。
   *
   * 为什么需要它：工具条浮在谱面块**外侧**，而宿主在悬停时会给若干层祖先套 `overflow: hidden`
   * （`app.css` 里 `.cm-embed-block:hover{overflow:hidden}` 是最外层那一条）。到底**哪一层**在裁、
   * 或者**根本没触发显示**，只有在真机的实时预览 DOM 里量得出来 —— 我在本地没有 Obsidian 宿主，
   * 所以把实时预览的祖先链、逐层的 `overflow`/`contain`、以及工具条与裁剪区的几何关系记下来，
   * 用户截一张设置页的图就能定位（与 `lastCropInfo` 同一套路）。
   *
   * 内存字段即可——运行期诊断，不持久化。
   */
  lastToolbarInfo: string | null = null
  /**
   * adj777：「点击预览区显/隐工具条」的**诊断**（显示在设置页「说明」里）。
   * 用户报「点击预览区无显/隐」时，这条能一眼回答"插件到底有没有收到这次点击、命中了哪个元素"——
   * 分清"事件没到"和"到了但状态判断错"，比猜快得多。
   */
  lastToolbarClick: string | null = null

  /**
   * adj725d：**SVG 走的是哪条解析路径**（最近一次渲染写回）——`'xml'` / `'html-fallback（…）'`。
   *
   * 为什么要记：Obsidian 的 `sanitizeHTMLToDom`（DOMPurify）会剥掉 `dominant-baseline`
   * 等 SVG 属性（详见 `scorePane.ts` 的 `svgToDom()`），所以插件改走 `DOMParser`；
   * 但只要有一次回退到 HTML 解析，就等于那个属性又丢了 ⇒ 真机验证要断言"每次都是 XML"。
   */
  lastSvgParse: string | null = null

  /** 由内嵌 worklet 代码构造 Blob URL（不再依赖插件目录单独文件；供 audioWorklet.addModule） */
  private makeWorkletUrl(): string {
    try {
      const blob = new Blob([workletCode], { type: 'application/javascript' })
      return URL.createObjectURL(blob)
    } catch {
      return ''
    }
  }
}

/** 取代码块行区间（阅读模式/某些视图下可能为 null 或抛错——统一包一层） */
function safeSectionInfo(
  ctx: { getSectionInfo: (el: HTMLElement) => MarkdownSectionInformation | null },
  el: HTMLElement,
): MarkdownSectionInformation | null {
  try {
    return ctx.getSectionInfo(el)
  } catch {
    return null
  }
}

/**
 * 一个 ```jps 代码块的渲染组件。
 *
 *  - **随 frontmatter 与插件设置变化即时重渲染**（Obsidian 不会因 frontmatter 变化重跑代码块处理器）
 *  - **「⚙ 排版」保存时把新源码写回该代码块**：优先走编辑器 `replaceRange`（保留撤销栈、光标），
 *    否则用 `vault.process` 做整文件事务写（阅读模式可用）
 *  - **adj725：块右上角的 `</>` 把光标送回这段源码**（见 `revealSource`）——编辑交给 Obsidian 自己
 */
class IJipuBlock extends MarkdownRenderChild {
  private pane: ScorePaneHandle | null = null

  constructor(
    private plugin: IJipuPlugin,
    private source: string,
    containerEl: HTMLElement,
    private sourcePath: string,
    private sectionInfo: () => MarkdownSectionInformation | null,
  ) {
    super(containerEl)
  }

  onload(): void {
    this.paint()
    // adj738：这里原来还监听 `metadataCache.on('changed')`（为了"改笔记 frontmatter 即时重渲染"）。
    // 笔记 frontmatter 那一层已删除 ⇒ 该监听没有用途（代码块内容变化时 Obsidian 自己会重跑处理器）。
  }

  onunload(): void {
    this.pane?.destroy()
    this.pane = null
  }

  /** 重画本代码块的谱面（设置变更由面板自行处理，这里只负责结构/源码变化） */
  private paint(): void {
    this.pane?.destroy()
    this.pane = null
    this.containerEl.empty()
    this.pane = mountScorePane({
      plugin: this.plugin,
      container: this.containerEl,
      getSource: () => this.source,
      writeSource: (next) => this.writeSource(next),
      /**
       * adj741（历史）原来这里写的是"`</>`（切回笔记源码）**只在桌面端给** —— 手机端由 Obsidian 自己的机制负责"。
       * adj777 已按用户实测推翻该口径（"手机端 jps 代码块上工具栏上无编辑按钮"）：按钮统一进工具条后，
       * **两端都要有**；`revealSource()` 本身只用跨平台 API
       * （`MarkdownView.setState` / `editor.setCursor` / `scrollIntoView` / `focus`）⇒ 手机端可用。
       */
      /**
       * adj777（用户实测）：「**手机端 jps 代码块上工具栏上无编辑按钮**」。
       *
       * 原来这里是 `...(Platform.isDesktopApp ? { onEditSource: … } : {})`，注释写着"手机端不传 ⇒
       * 面板不会挂这个按钮（触屏上"编辑此块"由 Obsidian 自己的机制负责）" —— 那是**旧的 `</>` 时代**的口径：
       * 那时按钮是块右上角那枚 `</>`。现在按钮已经统一进工具条（用户要求"三处工具条按钮统一为
       * 试听/排版/设置/视图/编辑"），**手机端也该有**（手机端切源码同样可用：`revealSource()` 只是
       * "切到笔记源码并把光标放进本块"，与平台无关）。
       */
      onEditSource: () => void this.revealSource(),
      /**
       * adj865（用户定稿的 `z`）：**块级缩放**从"开栏行的 info string"读（` ```jps z=150 `）。
       * 只有代码块传它 ⇒ 文件视图 / 嵌入保持既有行为（作用域见 `ScorePaneHost.zoom`）。
       */
      zoom: this.zoomOfBlock(),
    })
  }

  /**
   * adj865：取本代码块的**块级缩放** `z`（缺省 100 = 自然尺寸；`*` = 自适应栏宽）。
   *
   * 为什么读"开栏行"而不是正文：`z` 写在 info string（` ```jps z=150 `）—— 与项目既有分工一致：
   * **`# jps-config` = 谱面自身设置**（随谱走），**块级 `z=` = 与笔记配合的呈现**（这个块在笔记里怎么摆）。
   * 解析口径（含非法值/边界）只在 `jpsBlocks.zoomOfInfo` 一处，这里不重写一遍 ✗。
   *
   * ⚠ 已知待实测：Obsidian 对"语言名之后的 info string 变化"是否重跑代码块处理器，社区里有争议
   * （本插件走的是 `registerMarkdownCodeBlockProcessor`，**不是** markdown post-processor，未必受影响）。
   * 若用户实测"改了 `z=` 不刷新"，修法是监听编辑器变更并重画（本轮不做，先按标准行为实现）。
   */
  private zoomOfBlock(): number | 'auto' {
    const info = this.sectionInfo()
    if (!info) return 100
    const fence = info.text.split('\n')[info.lineStart] ?? ''
    return zoomOfInfo(fence)
  }

  /**
   * adj725（用户要求）：**切到笔记源码**，把光标放进本代码块。
   *
   * 用户口径：「切源码方式是在预览的笔记源码间切换，源码如图，不要再单独的 textarea」
   * ⇒ 不在预览里编辑（那是插件自己造的一套编辑器：样式、撤销栈、"打字跳回开头"都得自己兜），
   * 而是**切回笔记**，用 Obsidian 自带编辑器改。
   *
   * 实现等价于 Obsidian 自己那个「编辑此块」按钮（`EmbedWidget.addEditButton` → `selectElement`）：
   *  ① 阅读视图下先切到**实时预览**（`mode:'source', source:false`）——这是"预览 ↔ 笔记源码"的切换；
   *  ② 光标落到**首行源码**（`lineStart + 1`：`lineStart` 是 ```jps 那一行）；
   *  ③ 把整块滚进视野并聚焦 —— 光标在块内时，实时预览**原生**就会显示源码（含语法高亮、
   *     与其它代码块完全一致的编辑体验），光标移出块又自动回到谱面。
   *
   * ⚠ 顺序与"落两次"：切模式会让 CM6 重建 DOM，光标偶发不生效 ⇒ 同步落一次、
   * 下一帧再落一次（第二次是幂等的）。
   */
  private async revealSource(): Promise<void> {
    const info = this.sectionInfo()
    if (!info) {
      new Notice('无法定位这段源码的位置（请回到笔记的编辑视图重试）', 5000)
      return
    }
    const view = this.markdownViewOfNote()
    if (!view) {
      new Notice('这份笔记没有打开在任何可编辑的页签里', 5000)
      return
    }
    if (view.getMode() === 'preview') {
      // 阅读视图 → 实时预览（正是用户在界面上点「编辑」时 Obsidian 做的事）
      await view.setState({ mode: 'source', source: false }, { history: false })
    }
    const place = (): void => {
      const ed = view.editor
      const line = Math.min(info.lineStart + 1, ed.lastLine())
      ed.setCursor({ line, ch: 0 })
      ed.scrollIntoView({ from: { line: info.lineStart, ch: 0 }, to: { line: info.lineEnd, ch: 0 } }, true)
      ed.focus()
    }
    place()
    window.setTimeout(place, 0)
  }

  /** 找**这份笔记**的 MarkdownView（优先当前活动的那个；其次在页签里按路径找） */
  private markdownViewOfNote(): MarkdownView | null {
    const app = this.plugin.app
    const active = app.workspace.getActiveViewOfType(MarkdownView)
    if (active?.file?.path === this.sourcePath) return active
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view
      if (view instanceof MarkdownView && view.file?.path === this.sourcePath) return view
    }
    return null
  }

  /** 把新的代码块正文写回笔记 */
  private async writeSource(next: string): Promise<void> {
    const info = this.sectionInfo()
    if (!info) throw new Error('无法定位代码块位置（请在编辑视图中重试）')
    const app = this.plugin.app
    const body = next.replace(/\n+$/, '')
    // ① 编辑器可见（实时预览 / 源码模式）：替换块内文本，保留撤销栈
    const view = app.workspace.getActiveViewOfType(MarkdownView)
    if (view && view.file?.path === this.sourcePath) {
      view.editor.replaceRange(`${body}\n`, { line: info.lineStart + 1, ch: 0 }, { line: info.lineEnd, ch: 0 })
      this.source = body
      this.pane?.refresh()
      return
    }
    // ② 阅读模式等无编辑器场景：整文件事务写
    const file = app.vault.getAbstractFileByPath(this.sourcePath)
    if (!(file instanceof TFile)) throw new Error(`找不到文件：${this.sourcePath}`)
    await app.vault.process(file, (data) => replaceCodeBlockBody(data, info.lineStart, info.lineEnd, body))
    this.source = body
    this.pane?.refresh()
  }
}
