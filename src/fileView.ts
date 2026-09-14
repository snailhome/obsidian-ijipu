/**
 * fileView.ts — `.jps` 文件视图（插件启用后 Obsidian 把 .jps 识别为简谱文件）
 *
 * 行为：
 *  - 打开 `xxx.jps`（含从 `[[xxx.jps]]` 链接点进来）→ 渲染为简谱，工具条含试听/显示模式/⚙ 排版
 *  - ⇄ 源码：可切到纯文本编辑（textarea，输入停 600ms 自动保存；也可 Ctrl+S 立即保存）
 *  - `![[xxx.jps]]` 嵌入：Obsidian 会把本视图嵌进笔记，自动切到紧凑形态（隐藏页数/编辑器）
 *  - 「⚙ 排版 → 保存到谱面」直接改写文件内容（`# jps-config` 行），与 iJipu 行为一致
 */
import { Platform, TextFileView, type WorkspaceLeaf } from 'obsidian'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import type IJipuPlugin from './main'

/**
 * adj404：手机端源码框「键盘感知」——把源码框钉在**真正看得见的区域**里。
 *
 * 问题（用户实测）：输入法未打开时满屏正确；一打开输入法，源码框比可视区**还矮一个键盘的高度**。
 * 根因是宿主的键盘策略在真机上**双重扣减**：
 *   - Android WebView 随键盘缩小布局视口（adjustResize）→ `100vh` 已经不含键盘；
 *   - Obsidian 又用它自己的变量再扣一次：
 *     `body.is-mobile .app-container { max-height: calc(100vh - var(--keyboard-height)) }`
 *     （而 `body.is-mobile { height: 100vh }` 说明它假定布局视口**不**随键盘变化；
 *       键盘动画期间 `body.is-mobile.keyboard-animating .app-container { max-height: 100vh }`
 *       先不扣、动画结束后再扣 —— 这正是"缩两次"的来源）。
 * 于是 `.app-container` = 屏高 − 2×键盘高，我们的 `height:100%` 继承了这个过矮的高度。
 *
 * 做法：绕开继承链，直接按 `visualViewport` 实测：
 *   ① 需要时临时解除 `.app-container` 的 max-height（否则我们的高度会被祖先裁掉）；
 *   ② 容器高度 = 可视区底 − 容器顶（键盘打开时底边正好落在键盘上沿）；
 *   ③ 键盘收起 / 视图切走 / 关闭时全部还原，不留副作用。
 * 只在移动端挂载（`Platform.isMobile`），桌面端行为完全不变。
 *
 * @returns 清理函数（务必在重画/关闭时调用）
 */
function fitEditorToVisibleArea(contentEl: HTMLElement): () => void {
  if (!Platform.isMobile) return () => {}
  const vv = window.visualViewport
  if (!vv) return () => {}
  const appContainer = contentEl.closest('.app-container') as HTMLElement | null
  let prevMaxHeight: string | null = null
  let lifted = false
  const restoreCap = () => {
    if (lifted && appContainer) appContainer.style.maxHeight = prevMaxHeight ?? ''
    lifted = false
  }
  const fit = () => {
    const visibleBottom = vv.offsetTop + vv.height
    const top = contentEl.getBoundingClientRect().top
    const want = Math.max(200, Math.round(visibleBottom - top))
    // 宿主把容器裁得比可视区还矮（真机上的双重扣减）→ 临时解除上限
    if (appContainer && !lifted && want > appContainer.clientHeight + 8) {
      prevMaxHeight = appContainer.style.maxHeight
      appContainer.style.maxHeight = 'none'
      lifted = true
    } else if (lifted && appContainer && want <= appContainer.clientHeight + 8) {
      restoreCap()
    }
    contentEl.style.height = `${want}px`
  }
  const onVv = () => requestAnimationFrame(fit)
  vv.addEventListener('resize', onVv)
  vv.addEventListener('scroll', onVv)
  fit()
  return () => {
    vv.removeEventListener('resize', onVv)
    vv.removeEventListener('scroll', onVv)
    restoreCap()
    contentEl.style.height = ''
  }
}

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
  /** adj404：源码态「键盘感知」清理函数（切走/关闭时必须调用，避免留下 app-container 副作用） */
  private unfixHeight: (() => void) | null = null

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
    this.teardownHeightFit()
    this.pane?.destroy()
    this.pane = null
    this.contentEl.empty()
  }

  async onClose(): Promise<void> {
    if (this.saveTimer !== 0) window.clearTimeout(this.saveTimer)
    this.teardownHeightFit()
    this.pane?.destroy()
    this.pane = null
  }

  /** adj404：撤销源码态的键盘感知（还原 app-container 的 max-height 与内联高度） */
  private teardownHeightFit(): void {
    this.unfixHeight?.()
    this.unfixHeight = null
  }

  /** 是否被嵌入在笔记里（`![[xxx.jps]]`）——嵌入形态用紧凑布局、不显示源码编辑器 */
  private get embedded(): boolean {
    return this.containerEl.closest('.internal-embed') !== null
  }

  private render(): void {
    const { contentEl } = this
    const embedded = this.embedded
    this.teardownHeightFit() // adj404：重画前先还原上一次源码态的键盘感知
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
      // adj402：源码态容器**不自己滚动**（滚动交给 textarea）——此前「容器 overflow:auto」与
      // 「textarea min-height:240px + flex:1」两套机制叠加，移动端键盘弹出/工具栏出现时会
      // 表现为"缩一次又缩一次"，且收缩后填不满可用空间。加这个类由 CSS 关掉容器滚动。
      contentEl.addClass('ijipu-file-editing')
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
      // adj404：钉住「可视区域」——真机上宿主（WebView + Obsidian）会双重扣减键盘高度，
      // 导致源码框比可视区矮一截；这里按 visualViewport 实测并（必要时）临时解除祖先上限
      this.unfixHeight = fitEditorToVisibleArea(contentEl)
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
