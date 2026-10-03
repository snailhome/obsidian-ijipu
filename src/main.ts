import { Events, Keymap, MarkdownRenderChild, MarkdownView, Plugin, TFolder, TFile, type MarkdownSectionInformation } from 'obsidian'
import { IJipuSettingTab } from './settings'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import { registerJpsEmbeds } from './embed'
import { IJipuFileView, JPS_EXTENSION, VIEW_TYPE_IJIPU } from './fileView'
import { createJpsFile, consumeJpsLinkCreate, materializeJpsFile, planJpsLinkCreate, registerJpsFileCreator, unregisterJpsFileCreator, NEW_JPS_TEMPLATE } from './newFile'
import { replaceCodeBlockBody } from './sourceEdit'
import type { IJipuSettings } from './types'
// @ts-ignore esbuild 以 text loader 把 worklet 内联为字符串（main.js 单文件自包含，无需插件目录单独 worklet）
import workletCode from '../spessasynth_processor.min.js'

/** 插件内事件广播：设置面板保存后触发，打开中的谱面据此即时重渲染 */
export const SETTINGS_CHANGED = 'settings-changed'
/** 插件内事件广播：「排版辅助虚线」开关变化（所有面板同步） */
export const GUIDES_CHANGED = 'guides-changed'

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
  /** 插件内事件广播（当前用于设置变更 → 打开中的谱面即时重渲染） */
  readonly events = new Events()
  /** 「排版辅助虚线」是否显示（与 iJipu 顶栏「排版」按钮同一个开关；所有面板共享、不落盘） */
  showGuides = false
  /** 所有进行中试听的停止函数（切换笔记/卸载时统一停止） */
  private playStops: (() => void)[] = []
  /** 内置 SpessaSynth worklet URL（worklet 代码内联进 main.js → Blob URL，随插件单文件分发） */
  private workletUrl = ''
  /** adj631：「设置 → iJipu」页签的"就地重画"回调（别处改了插件设置时保持两边显示一致） */
  private settingsRefresh: (() => void) | null = null

  /** 切换排版辅助虚线（显示后可拖动虚线调边距/行距），并通知所有面板重画 */
  toggleGuides(): boolean {
    this.showGuides = !this.showGuides
    this.events.trigger(GUIDES_CHANGED)
    return this.showGuides
  }

  async onload(): Promise<void> {
    await this.loadSettings()
    this.workletUrl = this.makeWorkletUrl()
    this.addSettingTab(new IJipuSettingTab(this.app, this))

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
  }

  /** 停止所有进行中的试听 */
  stopAll(): void {
    for (const stop of this.playStops) stop()
    this.playStops = []
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

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, await this.loadData())
  }

  /**
   * 保存插件设置。
   *
   * @param opts.from 调用方标识：`'settingsTab'` = 「设置 → iJipu」页签自己改的。
   *   adj631（用户报"预览页面的设置与 设置-iJipu 里的设置项不同步"）：
   *   别处（谱面预览对话框「保存为插件默认」）改完设置后，**让开着的设置页签就地重画**，
   *   否则那一页还停在旧值上、看起来两边不一致；页签自己改的不重画——会打断正在输入的控件焦点。
   */
  async saveSettings(opts?: { from?: 'settingsTab' }): Promise<void> {
    await this.saveData(this.settings)
    // 设置面板改动后广播：打开中的谱面即时按新设置重渲染（此前要重开笔记才生效）
    this.events.trigger(SETTINGS_CHANGED)
    if (opts?.from !== 'settingsTab') this.settingsRefresh?.()
  }

  /** 登记/注销「设置 → iJipu」页签的重画回调（页签 `display()` 时登记、`hide()` 时注销） */
  registerSettingsRefresh(fn: (() => void) | null): void {
    this.settingsRefresh = fn
  }

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
    // 笔记 frontmatter 变化（Properties 面板编辑 / 直接改 YAML）→ 即时重渲染
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file) => {
        if (file.path === this.sourcePath) this.paint()
      }),
    )
  }

  onunload(): void {
    this.pane?.destroy()
    this.pane = null
  }

  /** 重画本代码块的谱面（设置变更由面板自行处理，这里只负责 frontmatter / 结构变化） */
  private paint(): void {
    this.pane?.destroy()
    this.pane = null
    this.containerEl.empty()
    this.pane = mountScorePane({
      plugin: this.plugin,
      container: this.containerEl,
      getSource: () => this.source,
      getFrontmatter: () => this.plugin.app.metadataCache.getCache(this.sourcePath)?.frontmatter ?? null,
      writeSource: (next) => this.writeSource(next),
    })
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
