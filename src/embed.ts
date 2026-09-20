/**
 * embed.ts — `![[xxx.jps]]` 嵌入支持
 *
 * ## 宿主怎么处理嵌入（逐行核对 Obsidian 1.13.7 本体 obsidian.asar 得到）
 *
 * 嵌入的解析入口是 `EmbedRegistry.load(ctx)`，对每个 `![[…]]` 做的是：
 *
 *   ```js
 *   containerEl.empty()                                        // ① 先清空容器
 *   const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath)
 *   const creator = app.embedRegistry.getEmbedCreator(file)    // ② 按扩展名找 embed creator
 *   const comp = creator ? creator(ctx, file, subpath) : new FileEmbed(ctx, file, subpath)
 *   containerEl.addClass('is-loaded')
 *   ```
 *
 * `.jps` 原先**没有 embed creator**，于是 ② 走 `FileEmbed` 兜底：它给容器加
 * `file-embed mod-generic` 并塞一个"文件名占位块" —— 用户在笔记里看到的
 * 「一个未知的嵌入块，没有谱面」就是它；而它的 ① `empty()` 会顺手清掉我们先前渲染的谱面。
 *
 * ## 两种"抢渲染"的写法都失败过（记在这里，别再走回头路）
 *
 *  · **052c783**：MutationObserver「被覆盖就重挂」。判空写的是
 *    `container.querySelector('.ijipu-score')`（只查**后代**），而 `.ijipu-score` 恰恰加在容器
 *    **自身**上 → 永远判为"没挂上" → 自我重挂瞬间耗尽 5 次配额，等宿主真覆盖时已无机会。
 *  · **post-processor 里给容器打 `is-loaded`**（让宿主跳过）。机制本身没错，但实测仍出占位块。
 *    诊断日志暴露了原因：**同一个嵌入在真实环境里有两个容器** —— 一个 `<span class="internal-embed">`
 *    （markdown 解析产物，post-processor 能看到）和一个 `<div class="internal-embed" src="…">`
 *    （宿主/其它方直接交给 `EmbedRegistry.load` 的，**完全不经 post-processor**）。
 *    我们只标记得到看得到的那个，可见的那个照样落到 `FileEmbed` 兜底 → 占位块。
 *    教训：抢渲染都在赌"宿主随后不会再动这个容器"，而宿主手里另有入口。
 *
 * ## 现在的做法：把渲染权从宿主手里要过来
 *
 * 直接给 `.jps` **注册 embed creator**（Obsidian 自己的 Canvas / Bases 插件就是这么做的）：
 * ② 命中我们的 creator 后，宿主不再走 `FileEmbed` 兜底 —— 没有占位块、没有 `empty()`，
 * 而且**无论嵌入元素是谁创建的、走哪条入口**，宿主都得把渲染交给我们。
 *
 * 若 `app.embedRegistry` 不可用（更老的宿主），退回 post-processor 认领（打 `is-loaded`）作为兜底。
 */
import { Component, MarkdownRenderChild, TFile } from 'obsidian'
import type { App, MarkdownPostProcessorContext } from 'obsidian'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import { jpsLinkpath } from './sourceEdit'
import { JPS_EXTENSION } from './fileView'
import type IJipuPlugin from './main'

/**
 * 宿主给"没有 embed creator 的文件嵌入"准备的类（`FileEmbed` 加在容器上）。
 * 走 embed creator 后它不会出现；兜底认领时顺手清掉，免得残留宿主样式。
 */
const NATIVE_EMBED_CLASSES = ['file-embed', 'mod-generic']
/** 兜底认领的复查时间点（ms） */
const VERIFY_DELAYS_MS = [400, 1500]
/** 兜底认领的复查次数上限（防与宿主互相覆盖） */
const MAX_VERIFIES = 2

/** embed creator 拿到的上下文（Obsidian 内部结构；这里只声明用到的字段） */
type EmbedContext = {
  app: App
  containerEl: HTMLElement
  linktext: string
  sourcePath: string
}

/** embed creator：`(ctx, file, subpath) => Component`（宿主随后会调用其 `loadFile()`） */
type EmbedCreator = (ctx: EmbedContext, file: TFile, subpath: string) => Component

/** Obsidian 内部的 embed 注册表（未进 typings；Canvas / Bases 插件也走这条路径） */
type EmbedRegistryLike = {
  registerExtension?: (ext: string, creator: EmbedCreator) => void
  unregisterExtension?: (ext: string) => void
  isExtensionRegistered?: (ext: string) => boolean
}

/** 注册 `![[xxx.jps]]` 嵌入（在插件 onload 里调用） */
export function registerJpsEmbeds(plugin: IJipuPlugin): void {
  if (registerEmbedCreator(plugin)) return
  // 兜底（宿主没有 embedRegistry）：post-processor 认领 + 打 is-loaded 让宿主跳过这个嵌入
  plugin.registerMarkdownPostProcessor((el, ctx) => claimEmbedsIn(plugin, el, ctx))
}

/**
 * 给 `.jps` 注册 embed creator。成功返回 true。
 * 命中后宿主不再走 `FileEmbed` 兜底 —— 这是"没有占位块、谱面不被清掉"的根本保证。
 */
function registerEmbedCreator(plugin: IJipuPlugin): boolean {
  const registry = (plugin.app as unknown as { embedRegistry?: EmbedRegistryLike }).embedRegistry
  if (!registry?.registerExtension) return false
  try {
    if (registry.isExtensionRegistered?.(JPS_EXTENSION)) {
      // 上一轮插件卸载没清干净：先摘掉再注册（registerExtension 对已注册扩展名会抛错）
      registry.unregisterExtension?.(JPS_EXTENSION)
    }
    registry.registerExtension(JPS_EXTENSION, (ctx, file) => new JpsEmbedComponent(plugin, ctx, file))
    plugin.register(() => registry.unregisterExtension?.(JPS_EXTENSION))
    return true
  } catch {
    return false
  }
}

/** 兜底路径：找出本段里的 `.jps` 嵌入并认领 */
function claimEmbedsIn(plugin: IJipuPlugin, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
  for (const emb of Array.from(el.querySelectorAll<HTMLElement>('.internal-embed[src]'))) {
    const linkpath = jpsLinkpath(emb.getAttribute('src') ?? '')
    if (!linkpath) continue
    claim(plugin, emb, linkpath, ctx)
  }
}

/** 认领一个 `.jps` 嵌入：打上 `is-loaded`（让宿主跳过）→ 清掉占位内容 → 挂载谱面面板 */
function claim(
  plugin: IJipuPlugin,
  emb: HTMLElement,
  linkpath: string,
  ctx: MarkdownPostProcessorContext,
): void {
  // 已挂好且面板还在（含 Live Preview 的 DOM 回收复用）→ 不重复挂载
  if (emb.dataset.ijipuEmbed === 'mounted' && emb.dataset.ijipuPainted === '1') return
  if (emb.dataset.ijipuEmbed === 'mounting') return
  emb.dataset.ijipuEmbed = 'mounting'
  claimContainer(emb)
  ctx.addChild(new JpsEmbed(plugin, emb, linkpath, ctx.sourcePath))
}

/**
 * 接管容器：`is-loaded` 是关键 —— 嵌入解析用 `:not(.is-loaded)` 选择器，打上它宿主就跳过这个嵌入。
 */
function claimContainer(emb: HTMLElement): void {
  emb.addClass('is-loaded')
  emb.addClass('ijipu-embed')
  emb.removeClass(...NATIVE_EMBED_CLASSES)
  emb.empty()
}

/**
 * 一块嵌入区域的渲染宿主：**只负责**"把这份 .jps 画进这个容器"。
 * 谁来调用它（embed creator 还是 post-processor 认领）与它无关，两条路共用同一套渲染。
 */
class JpsEmbedHost {
  private pane: ScorePaneHandle | null = null
  private source = ''
  private file: TFile | null = null
  private mounting = false

  constructor(
    private plugin: IJipuPlugin,
    private container: HTMLElement,
    private linkpath: string,
    private sourcePath: string,
    /** 已由宿主解析好的文件（embed creator 路径直接给） */
    private known: TFile | null = null,
  ) {}

  /** 当前渲染的谱面文件（供 vault 变更监听与"打开"用） */
  get target(): TFile | null {
    return this.file
  }

  /** 容器里是否已经有我们画好的面板（含"找不到文件/渲染失败"的提示态） */
  get painted(): boolean {
    return this.container.dataset.ijipuPainted === '1'
  }

  /** 正在读盘/挂载中 */
  get busy(): boolean {
    return this.mounting
  }

  /** 解析文件 → 读盘 → 挂面板 */
  async mount(): Promise<void> {
    const el = this.container
    const file =
      this.known ?? this.plugin.app.metadataCache.getFirstLinkpathDest(this.linkpath, this.sourcePath)
    if (!(file instanceof TFile)) {
      this.paintError(`⚠ 找不到谱面文件：${this.linkpath}`)
      return
    }
    this.file = file
    this.mounting = true
    let text: string
    try {
      text = await this.plugin.app.vault.cachedRead(file)
    } catch (e) {
      this.mounting = false
      this.paintError(`⚠ 读取谱面失败：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    // 注意：**不能**要求 containerEl.isConnected —— Live Preview 的 block widget
    // 就是先在脱离文档的容器里跑完 post-processors / 嵌入解析，再由 CodeMirror 插进文档。
    // 面板（含 SVG）是纯 DOM 构建，脱离文档照样搭得起来，随后跟容器一起进文档。
    this.source = text
    this.pane?.destroy()
    this.pane = null
    el.empty()
    el.addClass('ijipu-embed')
    try {
      this.pane = mountScorePane({
        plugin: this.plugin,
        container: el,
        getSource: () => this.source,
        getFrontmatter: () => null,
        embedded: true,
        // 嵌入区顶部显示谱面名（点击打开该 .jps）——接管后宿主不再提供这个入口
        embedTitle: file.basename,
        onOpenFile: () => {
          void this.plugin.app.workspace.getLeaf('tab').openFile(file)
        },
        // 「排版 → 保存到谱面」直接改写被嵌入的 .jps 文件
        writeSource: async (next) => {
          this.source = next
          await this.plugin.app.vault.modify(file, next)
        },
        // adj（用户要求）：嵌入模式也对应一个真实文件 ⇒ 工具栏显示「应用打开」（仅桌面端）；
        // 嵌入的写回（writeSource）是即时的，故不必额外刷盘
        filePath: file.path,
      })
      el.dataset.ijipuPainted = '1'
    } catch (e) {
      // 渲染抛错时容器已被清空 —— 别让用户只看到一片空白
      this.paintError(`⚠ 渲染失败：${e instanceof Error ? e.message : String(e)}`)
    }
    this.mounting = false
  }

  /** 该 .jps 内容变了：重新读盘并重画（保留显示模式等面板状态） */
  async reload(): Promise<void> {
    if (!this.file) return
    try {
      this.source = await this.plugin.app.vault.cachedRead(this.file)
    } catch {
      return
    }
    this.pane?.refresh()
  }

  destroy(): void {
    this.pane?.destroy()
    this.pane = null
    // 撤掉"已画好"标记：该元素若被宿主回收复用，下次认领会重新挂
    delete this.container.dataset.ijipuPainted
  }

  /** 在容器里给出可见的错误提示（比一片空白强） */
  private paintError(text: string): void {
    this.container.empty()
    this.container.createDiv({ cls: 'ijipu-error', text })
    this.container.dataset.ijipuPainted = '1'
  }
}

/**
 * embed creator 返回的组件。
 * 宿主流程：`component = creator(ctx, file, subpath)` → `ctx.addChild(component)` → `await component.loadFile()`。
 */
class JpsEmbedComponent extends Component {
  private host: JpsEmbedHost

  constructor(
    private plugin: IJipuPlugin,
    ctx: EmbedContext,
    file: TFile,
  ) {
    super()
    ctx.containerEl.addClass('ijipu-embed')
    this.host = new JpsEmbedHost(plugin, ctx.containerEl, ctx.linktext, ctx.sourcePath, file)
  }

  onload(): void {
    // 「排版/设置」写回、或在别处编辑了该 .jps → 嵌入区跟着刷新
    this.registerEvent(
      this.plugin.app.vault.on('modify', (f) => {
        const target = this.host.target
        if (target && f.path === target.path) void this.host.reload()
      }),
    )
  }

  onunload(): void {
    this.host.destroy()
  }

  /** 宿主在 `addChild` 之后立即调用（返回值会被 await） */
  loadFile(): Promise<void> {
    return this.host.mount()
  }
}

/**
 * 兜底路径用的渲染组件（宿主没有 embedRegistry 时）：
 * `MarkdownRenderChild` 随所在段落卸载而清理。
 */
class JpsEmbed extends MarkdownRenderChild {
  private host: JpsEmbedHost
  private timers: number[] = []
  private verifies = 0

  constructor(
    private plugin: IJipuPlugin,
    containerEl: HTMLElement,
    linkpath: string,
    sourcePath: string,
  ) {
    super(containerEl)
    this.host = new JpsEmbedHost(plugin, containerEl, linkpath, sourcePath)
  }

  onload(): void {
    void this.host.mount()
    this.registerEvent(
      this.plugin.app.vault.on('modify', (f) => {
        const target = this.host.target
        if (target && f.path === target.path) void this.host.reload()
      }),
    )
    for (const d of VERIFY_DELAYS_MS) this.timers.push(window.setTimeout(() => void this.verify(), d))
  }

  onunload(): void {
    for (const t of this.timers) window.clearTimeout(t)
    this.timers = []
    this.host.destroy()
  }

  /** 兜底复查：容器里没有我们画好的东西（被宿主清空/替换）时，重新认领并挂载 */
  private verify(): void {
    if (!this.containerEl.isConnected || this.host.busy) return
    if (this.host.painted) return
    if (this.verifies >= MAX_VERIFIES) return
    this.verifies++
    claimContainer(this.containerEl)
    void this.host.mount()
  }
}
