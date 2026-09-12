import { Events, MarkdownRenderChild, MarkdownView, Plugin, TFile, type MarkdownSectionInformation } from 'obsidian'
import { IJipuSettingTab } from './settings'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import { registerJpsEmbeds } from './embed'
import { IJipuFileView, JPS_EXTENSION, VIEW_TYPE_IJIPU } from './fileView'
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

    // 切换笔记时自动结束所有试听（避免试听继续却失去控制）
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.stopAll()))
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

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
    // 设置面板改动后广播：打开中的谱面即时按新设置重渲染（此前要重开笔记才生效）
    this.events.trigger(SETTINGS_CHANGED)
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
