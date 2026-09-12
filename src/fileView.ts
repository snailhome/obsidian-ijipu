/**
 * fileView.ts — `.jps` 文件视图（插件启用后 Obsidian 把 .jps 识别为简谱文件）
 *
 * 行为：
 *  - 打开 `xxx.jps`（含从 `[[xxx.jps]]` 链接点进来）→ 渲染为简谱，工具条含试听/显示模式/⚙ 排版
 *  - ⇄ 源码：可切到纯文本编辑（textarea，输入停 600ms 自动保存；也可 Ctrl+S 立即保存）
 *  - `![[xxx.jps]]` 嵌入：Obsidian 会把本视图嵌进笔记，自动切到紧凑形态（隐藏页数/编辑器）
 *  - 「⚙ 排版 → 保存到谱面」直接改写文件内容（`# jps-config` 行），与 iJipu 行为一致
 */
import { TextFileView, type WorkspaceLeaf } from 'obsidian'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import type IJipuPlugin from './main'

/** 视图类型（registerView/registerExtensions 用；同时用于嵌入形态判定） */
export const VIEW_TYPE_IJIPU = 'ijipu-jps-view'
/** 识别的扩展名（不带点） */
export const JPS_EXTENSION = 'jps'
/** 源码编辑自动保存延迟（ms） */
const AUTOSAVE_MS = 600

export class IJipuFileView extends TextFileView {
  private pane: ScorePaneHandle | null = null
  private saveTimer = 0
  /** 是否处于"源码编辑"态（默认看谱） */
  private editing = false

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: IJipuPlugin,
  ) {
    super(leaf)
  }

  getViewType(): string {
    return VIEW_TYPE_IJIPU
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'jps'
  }

  getIcon(): string {
    return 'music'
  }

  getViewData(): string {
    return this.data
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data
    if (clear) {
      this.pane?.destroy()
      this.pane = null
      this.editing = false
    }
    this.render()
  }

  clear(): void {
    this.pane?.destroy()
    this.pane = null
    this.contentEl.empty()
  }

  async onClose(): Promise<void> {
    if (this.saveTimer !== 0) window.clearTimeout(this.saveTimer)
    this.pane?.destroy()
    this.pane = null
  }

  /** 是否被嵌入在笔记里（`![[xxx.jps]]`）——嵌入形态用紧凑布局、不显示源码编辑器 */
  private get embedded(): boolean {
    return this.containerEl.closest('.internal-embed') !== null
  }

  private render(): void {
    const { contentEl } = this
    const embedded = this.embedded
    this.pane?.destroy()
    this.pane = null
    contentEl.empty()
    contentEl.addClass('ijipu-file-view')
    if (embedded) contentEl.addClass('ijipu-embedded-view')

    // —— 文件级工具条（嵌入形态只留标题）——
    const bar = contentEl.createDiv({ cls: 'ijipu-file-bar' })
    if (!embedded) {
      const toggle = bar.createEl('button', { cls: 'ijipu-btn', text: this.editing ? '📖 看谱' : '✎ 源码' })
      toggle.setAttr('title', this.editing ? '切回谱面视图' : '切到纯文本编辑（改动自动保存）')
      toggle.addEventListener('click', () => {
        this.editing = !this.editing
        this.render()
      })
      bar.createSpan({ cls: 'ijipu-page-label', text: this.file?.name ?? 'jps' })
    } else {
      bar.createSpan({ cls: 'ijipu-page-label', text: `♫ ${this.file?.basename ?? 'jps'}` })
    }

    // —— 源码编辑态 ——
    if (this.editing && !embedded) {
      const ta = contentEl.createEl('textarea', { cls: 'ijipu-source-editor' })
      ta.value = this.data
      ta.spellcheck = false
      ta.addEventListener('input', () => {
        this.data = ta.value
        this.scheduleSave()
      })
      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          void this.saveNow()
        }
      })
      ta.focus()
      return
    }

    // —— 谱面（共用面板：试听/显示模式/⚙ 排版/来源徽标）——
    const paneEl = contentEl.createDiv({ cls: 'ijipu-file-score' })
    this.pane = mountScorePane({
      plugin: this.plugin,
      container: paneEl,
      getSource: () => this.data,
      // .jps 文件自身没有笔记 frontmatter（其页面设置来自文件内的 # jps-config）
      getFrontmatter: () => null,
      writeSource: (next) => this.applySource(next),
      embedded,
    })
  }

  /** 「排版 → 保存到谱面」：改写视图数据并落盘，随后重画（新配置立即生效） */
  private applySource(next: string): void {
    this.data = next
    void this.saveNow()
    this.pane?.refresh()
  }

  private scheduleSave(): void {
    if (this.saveTimer !== 0) window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0
      void this.saveNow()
    }, AUTOSAVE_MS)
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer !== 0) {
      window.clearTimeout(this.saveTimer)
      this.saveTimer = 0
    }
    this.requestSave()
  }
}
