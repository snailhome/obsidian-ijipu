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
 * 真机上宿主的键盘处理有两套机制，且**都可能出现**（这也是第一次只按 visualViewport 修、仍然失败的原因）：
 *  ① **视口自己缩**：Android WebView 随键盘缩小布局视口（adjustResize）→ `innerHeight` 与
 *     `visualViewport.height` 都变小；此时 `100vh` 已不含键盘。
 *  ② **视口不缩、由宿主原生侧告知**：Obsidian 把键盘高写进 `--keyboard-height`
 *     （`body.is-mobile .app-container { max-height: calc(100vh - var(--keyboard-height)) }`）。
 * 两者叠加时 `.app-container` = 屏高 − 2×键盘高，我们的 `height:100%` 继承了这个过矮的高度；
 * 键盘动画期间 `keyboard-animating` 先把上限放回 `100vh`、动画结束才扣，这就是"缩两次"的来源。
 * 而**只按 visualViewport 判定**在"视口不缩"的机器上量不到键盘（用户机上正是如此）→ 仍少一截。
 *
 * 做法：两个信号都取，算出"可视区底"在布局坐标系里的位置——
 *   visible = min(innerHeight, visualViewport 底) − max(0, 键盘高 − 视口已缩掉的部分)
 * 再把我们的容器钉成「visible − 容器顶」；需要时临时解除 `.app-container` 的 max-height
 * （否则我们设的高度会被祖先裁掉）。键盘收起 / 切走 / 关闭 / 重画时全部还原，桌面端不挂载。
 *
 * @returns 清理函数（务必在重画/关闭时调用）
 */
function fitEditorToVisibleArea(contentEl: HTMLElement, ta: HTMLTextAreaElement): () => void {
  if (!Platform.isMobile) return () => {}
  const appContainer = contentEl.closest('.app-container') as HTMLElement | null
  /** 无键盘时的布局视口高（观测到过的最大值；WebView 里除键盘/旋转外不会变） */
  let baseH = window.innerHeight
  let prevMaxHeight: string | null = null
  let lifted = false

  /** Obsidian 原生侧给的键盘高（无键盘时为 0） */
  const keyboardVar = (): number => {
    try {
      return parseFloat(getComputedStyle(document.body).getPropertyValue('--keyboard-height')) || 0
    } catch {
      return 0
    }
  }

  /** 可视区底（布局坐标 y）——兼容"视口自己缩"与"宿主告知键盘高"两种机制 */
  const visibleBottomY = (): number => {
    const layoutH = window.innerHeight
    if (layoutH > baseH) baseH = layoutH
    let visible = layoutH
    const vv = window.visualViewport
    if (vv) visible = Math.min(visible, vv.offsetTop + vv.height)
    const kb = keyboardVar()
    if (kb > 0) {
      const shrunk = Math.max(0, baseH - layoutH) // 视口已经缩掉的部分
      const missing = Math.max(0, kb - shrunk) // 还差多少没扣
      visible = Math.min(visible, layoutH - missing)
    }
    return visible
  }

  const restoreCap = () => {
    if (lifted && appContainer) appContainer.style.maxHeight = prevMaxHeight ?? ''
    lifted = false
  }
  const fit = () => {
    const bottom = visibleBottomY()
    const top = contentEl.getBoundingClientRect().top
    const want = Math.max(200, Math.round(bottom - top))
    // 宿主把容器裁得比可视区还矮（双重扣减）→ 临时解除上限，否则我们的高度会被祖先裁掉
    if (appContainer && !lifted && want > appContainer.clientHeight + 8) {
      prevMaxHeight = appContainer.style.maxHeight
      appContainer.style.maxHeight = 'none'
      lifted = true
    } else if (lifted && appContainer && want <= appContainer.clientHeight + 8) {
      restoreCap()
    }
    // adj408：**不再依赖 CSS 级联**。真机诊断（用户截图）显示：容器高度算对了（box=502 = 到键盘上沿），
    // 但里面的源码框（textarea）只有 118px、下面留一大片空白——用户看到的"多缩一个键盘高"就是这片空白。
    // 原因在 Obsidian 本体的 textarea 规则（已在 obsidian.asar 中确认存在）：
    //   `textarea { height: 100%; min-height: 50vh; max-height: 80vh }` / `textarea { height: 300px; max-height: 20vh }`
    // —— 这些 height/max-height 会盖掉 flex 撑高与我们的高度赋值（实测 118px 正是"设的下限 120 减边框"）。
    // 故对容器与源码框逐条用 inline + !important 反制（inline important 优先于任何样式表规则），
    // 高度也不再估算，而是**实测**：源码框顶（getBoundingClientRect）→ 可视区底。
    // adj409：**真凶是宿主的 padding-bottom**（诊断阶段已确认并修复，见脚本 `adj409` 提交）。
    // 容器高度已按可视区钉好，不需要宿主那段"键盘内边距" → 用 inline important 改回我们自己的 8px。
    contentEl.style.setProperty('padding-bottom', '8px', 'important')
    contentEl.style.setProperty('height', `${want}px`, 'important')
    contentEl.style.setProperty('display', 'flex', 'important')
    contentEl.style.setProperty('flex-direction', 'column', 'important')
    contentEl.style.setProperty('overflow', 'hidden', 'important')
    contentEl.style.setProperty('max-height', 'none', 'important')
    contentEl.style.setProperty('position', 'relative', 'important')
    if (ta) {
      // adj408：宿主有 `textarea { height:100%; min-height:50vh; max-height:20vh|80vh }`，会盖掉撑高与赋值
      ta.style.setProperty('flex', '0 0 auto', 'important')
      ta.style.setProperty('min-height', '0', 'important')
      ta.style.setProperty('max-height', 'none', 'important')
      ta.style.setProperty('height', 'auto', 'important') // 先复位，量出源码框真实顶部
      const taTop = ta.getBoundingClientRect().top
      const padBottom = parseFloat(getComputedStyle(contentEl).paddingBottom) || 0
      const taH = Math.max(120, Math.round(bottom - taTop - padBottom))
      ta.style.setProperty('height', `${taH}px`, 'important')
    }
  }
  const onVv = () => requestAnimationFrame(fit)
  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', onVv)
    vv.addEventListener('scroll', onVv)
  }
  // 视口不缩的机器上只有窗口 resize 会来（键盘高变化还会改 --keyboard-height，用定时兜底跟一下）
  window.addEventListener('resize', onVv)
  const timer = window.setInterval(fit, 500)
  fit()
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('resize', onVv)
    if (vv) {
      vv.removeEventListener('resize', onVv)
      vv.removeEventListener('scroll', onVv)
    }
    restoreCap()
    for (const prop of ['height', 'display', 'flex-direction', 'overflow', 'max-height', 'position', 'padding-bottom']) contentEl.style.removeProperty(prop)
    if (ta) {
      ta.style.removeProperty('height')
      ta.style.removeProperty('flex')
    }
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
      // adj404：钉住「可视区域」——真机上宿主（WebView + Obsidian）的键盘机制有两种，见函数头注释；
      // adj407：同时把真实数值打到下面的诊断行，便于真机定位"少一个键盘高"到底是哪一环
      ta.focus()
      // adj404/408/409：钉住「可视区域」——真机上宿主的键盘机制与样式都反制过了，见函数头注释
      this.unfixHeight = fitEditorToVisibleArea(contentEl, ta)
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
