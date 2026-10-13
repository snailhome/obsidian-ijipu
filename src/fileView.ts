/**
 * fileView.ts — `.jps` 文件视图（插件启用后 Obsidian 把 .jps 识别为简谱文件）
 *
 * 行为：
 *  - 打开 `xxx.jps`（含从 `[[xxx.jps]]` 链接点进来）→ 渲染为简谱，工具条含试听/显示模式/⚙ 排版
 *    ⚠ adj923（用户 2026-10-13）起：**桌面端**点开时先按设置里的「打开方式」**直接进嵌入版 iJipu**
 *    （本页签让位 / 被关掉，见 `render()` 与 `embed/openPlan.ts` 的 `planJpsInitialView`）；
 *    手机端与笔记里的 `![[xx.jps]]` 内嵌**仍是**下面的轻量渲染（嵌入版只在桌面端注册）。
 *  - ⇄ 源码：可切到纯文本编辑（textarea，输入停 600ms 自动保存；也可 Ctrl+S 立即保存）
 *  - `![[xxx.jps]]` 嵌入：Obsidian 会把本视图嵌进笔记，自动切到紧凑形态（隐藏页数/编辑器）
 *  - 「⚙ 排版 → 保存到谱面」直接改写文件内容（`# jps-config` 行），与 iJipu 行为一致
 */
import { Notice, Platform, TextFileView, type TFile, type WorkspaceLeaf } from 'obsidian'
import { formatJps } from '@ijipu/engine'
import { mountScorePane, type ScorePaneHandle } from './scorePane'
import { planJpsInitialView } from './embed/openPlan'
import { DEFAULT_EMBED_OPEN_MODE } from './types'
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
    if (lifted && appContainer) {
      // adj724b（社区审核）：用 style.removeProperty 还原（而不是写 `= ''`）
      appContainer.style.removeProperty('max-height')
    }
    lifted = false
  }
  /**
   * adj724b（社区审核）：**不再逐条写 `style.setProperty`**。
   *
   * 官方 lint 规则 `obsidianmd/no-static-styles-assignment` 要求样式走 CSS 类，
   * 因此把这一整组样式搬进 `styles.css` 的 `.ijipu-file-editing-fit`
   * （含原来必要的 `!important` —— 它要反制 Obsidian 本体对 `textarea` 的
   * `height/min-height/max-height` 规则，见下方注释）。这里只加类名。
   *
   * 唯一"逐次计算"的是高度：用 `setCssStyles()`（Obsidian 提供的 API，
   * 也是该规则建议的做法之一），不再直接碰 `style` 属性。
   */
  const applyFitStyles = (want: number, bottom: number): void => {
    contentEl.addClass('ijipu-file-editing-fit')
    contentEl.setCssStyles({ height: `${want}px` })
    if (ta) {
      ta.addClass('ijipu-source-editor-fit')
      // 高度按"可视区底 − 源码框顶 − 容器下内边距"实测（下一步测量前先复位，见 CSS 的 height:auto!important）
      const taTop = ta.getBoundingClientRect().top
      const padBottom = parseFloat(getComputedStyle(contentEl).paddingBottom) || 0
      const taH = Math.max(120, Math.round(bottom - taTop - padBottom))
      ta.setCssStyles({ height: `${taH}px` })
    }
  }
  const fit = () => {
    const bottom = visibleBottomY()
    const top = contentEl.getBoundingClientRect().top
    const want = Math.max(200, Math.round(bottom - top))
    // 宿主把容器裁得比可视区还矮（双重扣减）→ 临时解除上限，否则我们的高度会被祖先裁掉
    if (appContainer && !lifted && want > appContainer.clientHeight + 8) {
      appContainer.setCssStyles({ maxHeight: 'none' })
      lifted = true
    } else if (lifted && appContainer && want <= appContainer.clientHeight + 8) {
      restoreCap()
    }
    // adj408：**不再依赖 CSS 级联**。真机诊断（用户截图）显示：容器高度算对了（box=502 = 到键盘上沿），
    // 但里面的源码框（textarea）只有 118px、下面留一大片空白——用户看到的"多缩一个键盘高"就是这片空白。
    // 原因在 Obsidian 本体的 textarea 规则（已在 obsidian.asar 中确认存在）：
    //   `textarea { height: 100%; min-height: 50vh; max-height: 80vh }` / `textarea { height: 300px; max-height: 20vh }`
    // —— 这些 height/max-height 会盖掉 flex 撑高与我们的高度赋值（实测 118px 正是"设的下限 120 减边框"）。
    // 故对容器与源码框用**带 !important 的 CSS 类**反制，并在量高度前先让源码框 height:auto 复位。
    // adj409：**真凶是宿主的 padding-bottom**（诊断阶段已确认并修复）——容器高度已按可视区钉好，
    // 不需要宿主那段"键盘内边距"，CSS 类里把下内边距定回 8px。
    applyFitStyles(want, bottom)
  }
  const onVv = () => window.requestAnimationFrame(fit)
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
    // adj724b（社区审核）：样式集中在 CSS 类里 ⇒ 拆除时**移除类**即可（不再逐条 removeProperty）
    contentEl.removeClass('ijipu-file-editing-fit')
    ta?.removeClass('ijipu-source-editor-fit')
    contentEl.setCssStyles({ height: '' })
    ta?.setCssStyles({ height: '' })
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
  /** adj724b：嵌入的完整 iJipu（整页 `.jps` 时用；`![[xx.jps]]` 嵌入态不用） */
  private embedFrame: HTMLIFrameElement | null = null
  /**
   * adj724b：本页签是否已经把"打开这份谱"路由到设置指定的位置（记的是**文件路径**）。
   *
   * 视图会因保存/frontmatter 变化重画，而路由只能做一次——否则每存一次就再开一个新页签；
   * 但**换文件**时必须重新路由（记路径而不是布尔值，就是为了这个）。
   */
  private embedRoutedFor: string | null = null
  /**
   * adj923（用户要求 ②）：**"嵌入版不可用 ⇒ 退回轻量预览"的那个文件路径**。
   *
   * 桌面端点 `.jps` 现在直接按「打开方式」进嵌入版（不再先给预览）；但本地服务**可能起不来**
   * （端口被占 / 动态导入失败…）。那一步若失败，用户不该只剩一个写着"启动失败"的空页签——
   * 这里记下路径 ⇒ `render()` 见到它就把**轻量预览**画出来（这正是用户交代的"预览留作兜底"）。
   * 记**路径**而不是布尔值：换文件后要重新尝试进嵌入版。
   */
  private embedRouteFailedFor: string | null = null

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
    this.teardownEmbedFrame()
    this.pane?.destroy()
    this.pane = null
  }

  /** adj404：撤销源码态的键盘感知（还原 app-container 的 max-height 与内联高度） */
  private teardownHeightFit(): void {
    this.unfixHeight?.()
    this.unfixHeight = null
  }

  /**
   * adj749：**切换源码/谱面**（文件栏「📖 看谱」与谱面浮动工具条「编辑」共用一条路径）。
   * 手机端走宿主编辑器（`adj744`），桌面端走内联 textarea。
   */
  toggleSource(): void {
    if (Platform.isMobile) {
      this.openInObsidianEditor()
      return
    }
    this.editing = !this.editing
    this.render()
  }

  /**
   * adj746：**按应用规范格式化本文件**（引擎 `formatJps` —— 与应用编辑器同一份实现）。
   *
   * 行为口径：
   *  · 已经规范 ⇒ 只提示，不写盘（避免无意义的"文件已修改"）；
   *  · 有改动 ⇒ 写回并**立即保存**（与源码编辑态一样走 `saveNow`），随后重画（若在谱面态，排版同步刷新）。
   */
  formatSource(): void {
    const next = formatJps(this.data)
    if (next === this.data) {
      new Notice('源码已是应用规范格式（无需改动）', 3000)
      return
    }
    this.data = next
    void this.saveNow()
    if (this.editing) {
      this.render()
    } else {
      this.render()
    }
    new Notice('已按应用规范格式化源码（音符/小节线空格、替谱段、描述头属性）', 4000)
  }

  /** 是否被嵌入在笔记里（`![[xxx.jps]]`）——嵌入形态用紧凑布局、不显示源码编辑器 */
  private get embedded(): boolean {
    return this.containerEl.closest('.internal-embed') !== null
  }

  /**
   * adj744：**把当前页签切到 Obsidian 自己的编辑器**（手机端「✎ 源码」走这条）。
   *
   * 为什么借 markdown 视图：Obsidian 没有"用内置编辑器打开任意文本文件"的公开 API，
   * 而 `MarkdownView` 的 `onLoadFile` 走的是 `TextFileView`（不校验扩展名）⇒
   * `setViewState({ type: 'markdown', state: { file, mode: 'source', source: true } })`
   * 就能让 `.jps` 在宿主编辑器里以**源码模式**打开（`source: true` = 纯源码，不是实时预览）。
   *
   * ⚠ 版本差异风险：万一宿主拒开（视图类型没变），**下一帧自动回退**到内联 textarea
   * （`this.editing = true` + 重画），保证"编辑源码"这条功能不会因此消失。
   */
  private openInObsidianEditor(): void {
    const file = this.file
    if (!file) return
    /**
     * adj744b（用户反馈「会被以 Markdown 的语法高亮」）：给**这个页签**打个标记 ——
     * `styles.css` 据此把 markdown 着色中和成纯文本（`.workspace-leaf.ijipu-plain-source`）。
     * 标记打在 **leaf 元素**上而不是本视图容器上：视图会被换掉，leaf 才是稳定的那个。
     */
    const leafEl = this.containerEl.closest('.workspace-leaf')
    leafEl?.addClass('ijipu-plain-source')
    const mutate = this.leaf as unknown as {
      setViewState?: (state: { type: string; state?: unknown; active?: boolean }) => Promise<void>
    }
    if (typeof mutate.setViewState !== 'function') {
      this.editing = true
      this.render()
      return
    }
    void mutate
      .setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: true }, active: true })
      .catch(() => undefined)
    /**
     * 回退判据（adj749 修）：**这个 leaf 现在装的还是不是本视图** ——
     * 换成了宿主的 markdown 编辑器就说明切成功；仍是本视图 ⇒ 宿主拒开 ⇒ 退回内联 textarea。
     * ⚠ 不能用"按钮还在不在 DOM 里"判断：调用方可能是浮动工具条上的按钮，
     * 那个按钮本来就随面板重建/销毁，与"视图有没有被换掉"无关（会误判成"拒开"）。
     */
    window.requestAnimationFrame(() => {
      if (this.leaf.view !== this) return
      this.editing = true
      this.render()
    })
  }

  private teardownEmbedFrame(): void {
    if (!this.embedFrame) return
    this.plugin.bridge.detach(this.embedFrame)
    this.embedFrame = null
  }

  /**
   * adj724b（用户要求）：「点击 ob 左侧文件列表的 `.jps` 文件时，**不要再出**那个
   * 『「xxx」已在爱记谱（嵌入版）中打开 / 当前打开方式见…』的页签，**直接在 ijipu 打开即可**」。
   *
   * 做法：先按设置把文件路由到该去的地方，**等它成功打开后，把这个中间页签关掉**
   * （`leaf.detach()`）。于是用户看到的只有"文件直接在 iJipu 里打开了"，不留多余页签。
   *
   * 两种**不关**的情况：
   *  · 方式是「**当前页签**」⇒ 路由会**替换掉这个页签本身**（它变成了编辑器），不能关；
   *  · 路由失败/未就绪 ⇒ 关掉会让用户什么都看不到，此时保留本页签（含「用源码视图编辑」）。
   *
   * 本方法只对**同一个文件**执行一次（`embedRoutedFor` 记路径）：视图因保存/frontmatter
   * 变化重画时不该反复跳；但换文件时必须重新路由。
   *
   * @param needEmbed adj923（用户要求 ②）：本次路由**要靠嵌入版**（把本页签让位给嵌入版视图）。
   *   此时先探一次"嵌入版能不能用"（`getEmbedUrl()`），**起不来就退回轻量预览**而不是留一个空白/报错页签
   *   —— 用户交代的"预览留作兜底"就落在这里。默认 `false`（「编辑」那条老路径自己已经查过开关）。
   */
  private routeToIjipu(file: TFile, needEmbed = false): void {
    if (this.embedRoutedFor === file.path) return
    this.embedRoutedFor = file.path
    /**
     * 异步执行：`render()` 是同步的，而 `openIjipuFile()` 要 await（服务启动 / 页签状态）。
     * 也让本视图先把"正在打开…"画出来——路由失败时用户至少知道发生了什么，而不是一片空白。
     */
    window.setTimeout(() => {
      void (async () => {
        // 先把可能存在的编辑落盘（交给 iJipu 打开的是磁盘上的内容）
        try {
          await this.saveNow()
        } catch {
          /* 保存失败不阻塞打开 */
        }
        /**
         * adj923（用户要求 ②）：**嵌入版不可用 ⇒ 兜底画轻量预览**。
         *
         * `getEmbedUrl()` 在"开关关着"与"服务起不来（端口被占 / 动态导入失败）"两种情况下
         * 都会给出 `null`（失败时还会把原因记进 `lastEmbedError`，见 `main.ts`）。
         * 这一步必须**在换视图之前**问：换过去之后本页签可能已被 detach（新页签/右栏档），
         * 再想退回预览就没地方退了。
         */
        if (needEmbed) {
          const url = await this.plugin.getEmbedUrl().catch(() => null)
          if (!url) {
            this.embedRouteFailedFor = file.path
            this.render()
            new Notice(
              '嵌入版 iJipu 暂时不可用 ⇒ 已在 Obsidian 里显示谱面预览；' +
                '原因见「设置 → iJipu → 诊断」页签的「嵌入版本地服务」（点一下即复制）。',
              8000,
            )
            return
          }
        }
        /**
         * ⚠ **把 `this.leaf` 交给插件**——这是"当前页签"能生效的关键。
         *
         * 用户实测「设为当前页签时，点击文件列表未在打开页签中打开」：根因是我此前让插件用
         * `getMostRecentLeaf()` / `getLeaf(false)` 去**猜**"当前页签"，而 Obsidian 的 leaf 调度
         * （以及右栏是否已有 iJipu 页签）都会让猜测落空。
         *
         * 但点 `.jps` 的语义是确定的：**这个文件视图页签就是用户点开的那个**。
         * 于是「当前页签」= 就地替换它（不关），其余方式 = 另开并把这个中间页签关掉——
         * 关不关由插件按模式统一决定（见 `openEmbedLeaf`），这里不再自己判断。
         */
        await this.plugin.openIjipuFile(file, this.leaf)
      })()
    }, 0)
  }

  /**
   * adj773：原 `renderEmbedPlaceholder()`（把整页 `.jps` 直接换成"嵌入版 iJipu 的 iframe + 中转提示"）
   * **已删除** —— 用户要求"点击 `.jps` 一律先显示预览，PC 与手机端一致"。要用嵌入版编辑，
   * 点工具条最右的「编辑」即可（桌面端走 `plugin.openIjipuFile` ⇒ 独立的嵌入版页签）。
   *
   * ⚠ adj923（用户 2026-10-13 要求 ②）**推翻了 adj773 的"PC 也先给预览"**：桌面端点 `.jps`
   * 现在按「打开方式」**直接进嵌入版**（手机端与 `![[xx.jps]]` 内嵌仍是轻量预览）。
   * 但"另一个 renderEmbedPlaceholder"没有回来 —— 那种写法（本页签里自己塞 iframe）会造成
   * **两个地方同时显示同一份谱**（本页签 + 目标页签），所以这里只画一句占位、随后把页签
   * 交给插件的路由（见 `render()` 顶部与 `planJpsInitialView`）。
   */

  private render(): void {
    const { contentEl } = this
    const embedded = this.embedded
    /**
     * adj923（用户要求 ②）：**这次打开该长什么样**由纯函数决定（`planJpsInitialView`）——
     * 桌面端按「打开方式」直进嵌入版；手机端 / 内嵌 / 开关关着 ⇒ 沿用原来的轻量预览。
     * 抽成纯函数是为了能在冒烟里逐条断言这四个条件（含手机端与另三档"没变"）。
     */
    const initialView = planJpsInitialView({
      mode: this.plugin.settings.embedOpenMode ?? DEFAULT_EMBED_OPEN_MODE,
      isDesktop: Platform.isDesktopApp,
      embedded,
      embedEnabled: this.plugin.embedEnabled,
    })
    /** 嵌入版起不来过（`embedRouteFailedFor`）⇒ 不再重试，直接走兜底预览 */
    const embedViable =
      initialView === 'embed' &&
      this.file !== null &&
      !this.editing &&
      this.embedRouteFailedFor !== this.file.path
    /**
     * adj744b：本视图重新渲染 ⇒ 那个页签**不再**是"纯文本源码态"（视图已切回谱面）
     * ⇒ 把中和 Markdown 着色的标记摘掉，免得影响以后在这个页签里打开的 markdown 笔记。
     */
    this.containerEl.closest('.workspace-leaf')?.removeClass('ijipu-plain-source')
    this.teardownHeightFit() // adj404：重画前先还原上一次源码态的键盘感知
    this.pane?.destroy()
    this.pane = null
    this.teardownEmbedFrame()
    contentEl.empty()
    contentEl.addClass('ijipu-file-view')
    if (embedded) contentEl.addClass('ijipu-embedded-view')

    /**
     * adj724b：**整页打开 `.jps` 时用完整 iJipu 编辑器**（用户要求：
     * 「ob 内的 jps 文件可以直接使用内部的 ijipu 打开，就不用再安装一套外部的桌面端了」）。
     *
     * 两种形态**分工明确**：
     *  · **整页页签**（双击 `.jps`）⇒ 按**设置里的打开方式**走（默认"右侧栏"）；
     *  · **`![[xx.jps]]` 笔记内嵌** ⇒ **保持原来的轻量预览**（笔记里塞一个完整编辑器既难看也没必要）。
     *
     * 打开方式由设置决定（右栏/新页签/当前页签/默认应用）⇒ 本页签不再自己渲染 iframe，
     * 只显示一句说明（否则会出现"两个地方同时显示同一份谱"）。
     * 关掉「使用嵌入版 iJipu」设置即整体回到旧的轻量渲染（可回退）。
     */
    /**
     * adj773（用户要求 1）：「点击 OB 左侧文件列表的 `.jps`，PC 端与手机端表现不一致，
     * **建议以手机端为准，点击 `.jps` 文件显示预览**」。
     *
     * 原来桌面端在这里直接把整页交给"嵌入版 iJipu"（iframe + 本机服务）⇒ 与手机端不一致。
     * 现在**两端一致：一律先给原生预览**；要用嵌入版编辑就点工具条最右的「编辑」
     * （桌面端 `onEdit` ⇒ 嵌入版；手机端 ⇒ 宿主编辑器源码模式，分派见 `scorePane` 的编辑按钮）。
     * 设置项 `embedIjuipu` 仍生效：它决定「编辑」能不能走嵌入版（关掉即退回源码编辑）。
     *
     * ⚠ adj923（用户 2026-10-13 要求 ②）：**上面这条"PC 也先给预览"已被推翻** ——
     * 「点击 ob 左侧的文件管理器里的 `.jps` 文件，对于 **PC 端**，建议还是**直接用嵌入版 iJipu 打开**，
     * 而不是先预览 jps 文件再其它操作」。现在桌面端按「打开方式」直进嵌入版；
     * **手机端与 `![[xx.jps]]` 内嵌一行没动**（仍是轻量预览）。分派见 `planJpsInitialView()`。
     */

    /**
     * adj923：**让位给嵌入版**（桌面端按打开方式路由）——
     * 这里只画一句可读的占位：路由做完后本页签要么被换成嵌入版视图（当前页签档）、
     * 要么被关掉（右栏/新页签档）。⚠ 不在这里塞 iframe：那会造成"两个地方同时显示同一份谱"。
     * 占位也不能省：服务启动要时间，没有它用户会看到一片空白（adj775 那类"点了没反应"）。
     */
    if (embedViable && this.file) {
      const bar = contentEl.createDiv({ cls: 'ijipu-file-bar' })
      bar.createSpan({ cls: 'ijipu-page-label', text: this.file.name })
      const hint = contentEl.createDiv({ cls: 'ijipu-web-hint' })
      hint.createDiv({ text: `正在用嵌入版 iJipu 打开「${this.file.basename}」…` })
      hint.createDiv({
        cls: 'ijipu-web-hint-sub',
        text: '打开方式见「设置 → iJipu → 嵌入版 → 打开 .jps 的方式」；打不开时这里会自动退回谱面预览。',
      })
      this.routeToIjipu(this.file, true)
      return
    }

    // —— 文件级工具条（嵌入形态只留标题）——
    const bar = contentEl.createDiv({ cls: 'ijipu-file-bar' })
    if (!embedded) {
      /**
       * adj749（用户报，手机端：「会因外延的工具条而遮住一半的源码、格式化按钮」）：
       * **按钮按状态分家** ——
       *  · **源码态**（看的是文本，浮动工具条不存在）：文件栏给「📖 看谱」+「⌥ 格式化」；
       *  · **预览态**（谱面浮动工具条在，手机端还常显）：文件栏**只留文件名**，
       *    「源码 / 格式化」交给浮动工具条（见 `mountScorePane` 的 `onToggleSource` / `onFormat`）
       *    ⇒ 两者不再叠在一起。
       *
       * 源码态的按钮实现（adj744 起手机端走宿主编辑器）：
       *  手机端「✎ 源码」= 把当前页签切到 Obsidian 自己的编辑器（markdown 视图 + 源码模式），
       *  键盘/换行/撤销栈/字号/滚动全由宿主负责；桌面端仍是内联 textarea。
       *  ⚠ 借 `setViewState({type:'markdown'})` 打开非 md 文件属"借宿主编辑器"：万一宿主拒开
       *    （版本差异），下一帧发现视图没切走 ⇒ 自动回退到 textarea。
       */
      if (this.editing) {
        const toggle = bar.createEl('button', { cls: 'ijipu-btn', text: '📖 看谱' })
        toggle.setAttr('title', '切回谱面视图')
        toggle.addEventListener('click', () => this.toggleSource())
        const fmtInEdit = bar.createEl('button', { cls: 'ijipu-btn', text: '⌥ 格式化' })
        fmtInEdit.setAttr('title', '按应用规范格式化源码（音符/小节线空格、歌词里的 {tp … } 段、描述头属性）')
        fmtInEdit.addEventListener('click', () => this.formatSource())
      }
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
      writeSource: (next) => this.applySource(next),
      embedded,
      /**
       * adj749（用户报，手机端）：「手机端 jps 文件预览视图下，会因外延的工具条而遮住一半的
       * 源码、格式化按钮，这个情况可以考虑把这两个按钮放在工具条上」——
       * 采纳：**预览态**把「源码 / 格式化」交给**谱面浮动工具条**（手机端它常显，位置也固定），
       * 文件栏只留文件名 ⇒ 两者不再重叠；**源码态**（没有浮动工具条）则在文件栏里给「看谱 / 格式化」。
       */
      onToggleSource: () => this.toggleSource(),
      onFormat: () => this.formatSource(),
      /**
       * adj773（用户要求 3a）：桌面端「编辑」⇒ **用嵌入版 iJipu 打开编辑**（手机端不走这条，
       * 由 `scorePane` 的编辑按钮按平台分派到 `onToggleSource` ⇒ 宿主编辑器源码模式）。
       *
       * 直接复用 `routeToIjipu()`：它已经做了两件关键事 —— **先 saveNow() 落盘**再交给嵌入版，
       * 以及**把 `this.leaf` 交出去**（「设为当前页签」时才能就地替换这个文件视图页签）。
       * 它内部有"同一文件只路由一次"的守卫（`embedRoutedFor`）⇒ 这里**先重置**，让每次点「编辑」都生效。
       */
      onEdit: this.file
        ? () => {
            const f = this.file
            if (!f) return
            /**
             * adj776（用户实测）：「PC 端点击工具条的编辑时，还是无法打开嵌入版 ijipu，提示**嵌入版未启用**」。
             *
             * 根因：设置里「使用嵌入版 iJipu（完整应用）」被关掉时，`getEmbedUrl()` 会**直接返回 null**
             * （第一条提前返回），而「编辑」按钮此前**不看这个开关**、照样打开嵌入版视图
             * ⇒ 用户得到一个写着"未启用"的**死页签**，点按钮的意图（编辑）完全没被满足。
             *
             * 现在：开关关着 ⇒ **退回源码编辑**（就是手机端那条路径：用宿主编辑器 + iJipu 着色/错误提示/
             * 自动格式化），并用 Notice 说明"想用完整编辑器去哪里开开关"。这样按钮在任何设置下都有意义。
             */
            if (!this.plugin.embedEnabled) {
              new Notice(
                '「使用嵌入版 iJipu（完整应用）」当前是关闭的 ⇒ 已改用 Obsidian 编辑器编辑源码。' +
                  '想用完整编辑器：设置 → iJipu → 嵌入版 → 打开该开关。',
                6000,
              )
              this.toggleSource()
              return
            }
            this.embedRoutedFor = null
            this.routeToIjipu(f)
          }
        : undefined,
      // adj（用户要求）：.jps 文件视图知道自己的文件 ⇒ 工具栏显示「应用打开」
      // （桌面端才显示；打开前先 saveNow 把未落盘的编辑刷下去）。`file` 可能为 null ⇒ 不传则不显示。
      filePath: this.file?.path,
      beforeOpenExternal: () => this.saveNow(),
    })

    /**
     * adj923（用户要求 ②）：「打开方式 = **默认应用**」时，这个页签**留着预览**，同时把文件交给
     * 系统默认程序（`defaultApp` 是"离开 Obsidian"，本站内没有嵌入版实例可给）。
     *
     * 为什么预览留着而不是关掉页签：这一步是 Obsidian 因 `registerExtensions` 必然创建的页签，
     * 关掉它用户在本站内就什么都没有了；而系统程序是另一个进程、"多开"不成立 ⇒ 留着对用户有用。
     * 只对**同一个文件**路由一次（`embedRoutedFor` 守卫在 `routeToIjipu` 里，反复重画不会再拉起外部程序）。
     */
    if (initialView === 'preview+external' && this.file && !this.editing) {
      this.routeToIjipu(this.file)
    }
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
