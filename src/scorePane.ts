/**
 * scorePane.ts — 谱面面板：**代码块 / .jps 文件视图 / ![[x.jps]] 嵌入** 共用的渲染与交互
 *
 * 抽出来的原因：这三种入口需要完全一致的行为（试听色块、显示模式、排版辅助虚线、来源徽标、
 * 页面设置、frontmatter/设置变更即时重渲染、渲染失败提示），各写一份必然漂移。
 *
 * 工具条两枚图标按钮（与 iJipu 顶栏一致）：
 *  · **排版**（田字格）＝ 开关**排版辅助虚线**，显示后可**拖动虚线**调边距/行距，
 *    松手即写回谱面源码的 `# jps-config`（与 iJipu「拖动结束即持久化」一致）；
 *  · **页面设置**（滑杆）＝ 打开对话框按字段精确设值（字体/字号等不可拖项）。
 *
 * 渲染管线与 iJipu 应用一致：`resolvePageConfig`（含源内 # jps-config）→ `layoutScore`
 * → `renderScoreToSvg`；试听走 `@ijipu/engine` 的 `buildPlaySequence` + SpessaSynth。
 */
import { Menu, Notice, sanitizeHTMLToDom } from 'obsidian'
import { writeJpsConfig, mergeConfigEdits, dragDelta, clamp, formatJps, type PageConfig } from '@ijipu/engine'
import { renderScoreFull, playScore, type PlayheadSeg } from './render'
import { instrumentColorMap, playheadBaseOf, playheadPosIn, trackKeysOf, type PlayheadPos } from './playhead'
import { resolvePageConfig } from './config'
import { ConfigDialog } from './configDialog'
// adj631：「保存为插件默认」要按"本次真正改动过的项"写入（changedDefs）+ 等于引擎默认则不存（isDefaultValue）
import { changedDefs, isDefaultValue } from './defs'
import { layoutIcon, modeIcon, settingsIcon, linkIcon, playIcon, stopIcon, appOpenIcon, sourceIcon } from './icons'
import { canOpenWithDefaultApp, openUrlExternally, openWithDefaultApp } from './openExternal'
import { computeGuideLines, cropRectFor, guideLimits, guidePlacement, type GuideLine } from './guides'
import { GUIDES_CHANGED, SETTINGS_CHANGED } from './main'
import type IJipuPlugin from './main'

type ViewMode = 'page' | 'full' | 'score'
const MODE_LABEL: Record<ViewMode, string> = { page: '整页', full: '满宽', score: '谱面' }
/** 三种显示模式的含义（按钮悬停提示用——图标只表意，文字补足准确含义） */
const MODE_HINT: Record<ViewMode, string> = {
  page: '完整一页（含页边距），宽度撑满内容区',
  full: '谱面撑满笔记宽度（不留页面左右留白）',
  score: '裁掉页边距、只显示内容区（默认；四周留 2px）',
}
/**
 * adj725：宿主 widget 容器（**只在实时预览里**有；阅读模式下 `el` 直接是 `.block-language-jps`）。
 * 挂在它上面的 `ijipu-cm-host` 类只为放开悬停时的 `overflow: hidden`（见 styles.css）。
 *
 * adj742（用户诊断截图：编辑视图里却判成"阅读视图/其他"）：实测发现**代码块**在实时预览里的容器
 * 未必带 `.cm-embed-block`（嵌页面板才有那个类，代码块常用 `.cm-preview-code-block`）——
 * 于是 `closest('.cm-embed-block')` 返回 `null` ⇒ 宿主类从未打上、诊断行也判错宿主。
 * 现在两个都认（`closest()` 支持选择器列表）。
 */
const CM_EMBED_BLOCK = '.cm-embed-block, .cm-preview-code-block'
/** 与 iJipu 应用一致的播放色块配色与定位（adj452：抽到 playhead.ts 纯函数，可单测） */

export type ScorePaneHost = {
  plugin: IJipuPlugin
  /** 渲染容器（挂载时会被清空） */
  container: HTMLElement
  /** 当前源码（.jps 全文 / 代码块正文） */
  getSource: () => string
  /**
   * adj749：**切换源码 / 谱面**（`.jps` 文件视图才给）。
   *
   * 为什么要放到浮动工具条上：手机端浮动工具条**常显**，而文件栏原本也在同一位置 ⇒
   * 用户实测「会因外延的工具条而遮住一半的源码、格式化按钮」。现在按状态分家：
   * **预览态**这两个动作在浮动工具条上（本面板），**源码态**在文件栏上。
   */
  onToggleSource?: () => void
  /** adj749：**按应用规范格式化源码**（引擎 `formatJps`；文件视图与代码块都可用） */
  onFormat?: () => void
  /** 把新源码写回（「排版」拖拽结束 / 「页面设置」保存到谱面时调用）；不提供则无写回入口 */
  writeSource?: (next: string) => void | Promise<void>
  /** 嵌入模式：更紧凑（隐藏页数标签等） */
  embedded?: boolean
  /**
   * 嵌入模式下的谱面名（显示在工具栏**右端**，前置链接图标，点击打开该 .jps）。
   * 插件接管 `![[x.jps]]` 的 `.internal-embed` 后，宿主原本那个"点开文件"的占位块不再出现，
   * 由这里补回入口；容器窄时只留图标（见 styles.css 的 @container 规则）。
   */
  embedTitle?: string
  /** 点击嵌入标题时调用（打开被嵌入的 .jps 文件） */
  onOpenFile?: () => void
  /**
   * 当前谱面所属的**磁盘文件**（库内相对路径，如 `曲谱集/小星星.jps`）。
   *
   * `.jps` 文件视图与 `![[x.jps]]` 嵌入**有**（它们对应一个真实文件）；
   * 代码块没有"自己的文件"⇒ 不传。有值且处于**桌面端**时，工具栏显示「应用打开」按钮
   * （用户要求：手机端不出现）——点它用系统默认应用（`.jps` 关联的 iJipu 桌面版）打开去编辑。
   */
  filePath?: string
  /**
   * 「应用打开」之前的**落盘钩子**：先把未保存的编辑写进文件，再交给外部应用。
   * 不提供就只在"已经落盘"的状态下打开（嵌入模式的写回是即时的，故嵌入可以不传）。
   */
  beforeOpenExternal?: () => void | Promise<void>
  /**
   * adj724b（用户实测 #7 要求）：**用嵌入的 iJipu 编辑这份谱**。
   *
   * 提供它就显示「**编辑**」按钮（而不是「应用打开」）——用户的原话是
   * 「显示的工具栏里的『应用打开』按钮，现在文本应改为『编辑』，并使用嵌入版的 ijipu 来打开」。
   * 嵌入版的场景下不该再依赖外部桌面端。
   */
  onEdit?: () => void
  /**
   * adj725（用户要求）：**块右上角 `</>`「编辑源码」的落点**。
   *
   * 用户口径：「切源码方式是在预览的笔记源码间切换，源码如图，不要再单独的 textarea」
   * ⇒ 不在预览里再塞一个 textarea，而是**切回笔记、把光标放进这个代码块**，
   * 用 Obsidian 自带编辑器改（原生语法高亮、撤销栈、与别的代码块完全一致）。
   *
   * 只有 ` ```jps ` 代码块会传它（`.jps` 文件视图 / `![[x.jps]]` 嵌入有自己的「源码」，它们是文件、没有宿主笔记）。
   */
  onEditSource?: () => void
  /**
   * adj727（用户要求）：点上面那个「编辑」**会不会离开 Obsidian**
   * （= 设置里「打开 .jps 的方式」选了「默认应用」，见 `embed/openPlan.ts` 的
   * `embedEditLeavesObsidian`）。
   *
   * 它决定嵌入区工具栏右端那枚「打开谱面文件」链接留不留：
   *  · `false/未给`（右栏 / 新页签 / 当前页签）：链接是重复入口 ⇒ 有「编辑」时收掉；
   *  · `true`（默认应用）：站内打开 `.jps` 视图就只剩这枚链接 ⇒ 保留。
   */
  editLeavesObsidian?: boolean
}

export type ScorePaneHandle = {
  /** 卸下（停止试听/结束拖拽 + 清空容器 + 注销监听） */
  destroy: () => void
  /** 重新解析并重画（源码/插件设置变化时由宿主调用） */
  refresh: () => void
}

/**
 * adj725d：把引擎产出的 SVG 字符串转成 DOM —— **优先走 XML 解析，不直接交给 `sanitizeHTMLToDom`**。
 *
 * ## 为什么（用户报「小节序号数字偏上，未在方框正中」的根因，已在本机 `obsidian.asar` 里查实）
 * Obsidian 的 `sanitizeHTMLToDom()` 底层是 **DOMPurify**（`app.js` 里
 * `function cC(e){return document.importNode(aC.sanitize(e,lC),!0)}`，配置只有
 * `FORBID_TAGS/ADD_TAGS/ADD_ATTR/FORBID_ATTR` 那几项），而 DOMPurify 的 **SVG 属性白名单**
 * **不含 `dominant-baseline`** —— 白名单里有 `alignment-baseline`、`baseline-shift`、`text-anchor`、
 * `writing-mode`… 但全文只有 HTML→SVG 的**属性名映射表**里出现过它（`dominantBaseline:"dominant-baseline"`），
 * 白名单里一次都没有。⇒ 属性被**剥掉** ⇒ 所有靠它做"字符中心对齐"的文本退回字母基线：
 *  · 小节序号（框内数字整体偏上，用户截图即此）
 *  · 增时线 `-` 的居中
 *  · 段层括号等
 * 应用侧（iJipu）不经 DOMPurify，所以**只有插件**有这个问题 —— 这也是"应用看着正常、插件偏上"的原因。
 *
 * ## 做法与安全
 * `DOMParser` 解析 `image/svg+xml`：属性原样保留，且内容是我们引擎自己的输出
 * （零外部输入、零脚本；引擎文本一律经 `xmlEsc` 转义），不经过 innerHTML。
 * **解析失败（SVG 不是合法 XML）时回退 `sanitizeHTMLToDom`** —— 宁可丢一个属性，也不能整块不渲染。
 * `plugin.lastSvgParse` 记录走了哪条路，验证脚本据此断言"每次都是 XML"。
 */
function svgToDom(svg: string, plugin: IJipuPlugin): DocumentFragment {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc.documentElement
    if (root && root.nodeName.toLowerCase() === 'svg' && !doc.querySelector('parsererror')) {
      const frag = createFragment()
      frag.appendChild(doc.importNode(root, true))
      plugin.lastSvgParse = 'xml'
      return frag
    }
    plugin.lastSvgParse = 'html-fallback（XML 解析失败）'
  } catch {
    plugin.lastSvgParse = 'html-fallback（XML 解析抛错）'
  }
  return sanitizeHTMLToDom(svg)
}

/** 挂载一个谱面面板（详见文件头说明） */
export function mountScorePane(host: ScorePaneHost): ScorePaneHandle {
  const { plugin, container } = host
  let stopPlay: (() => void) | null = null
  let rafId = 0
  let rafPending = false
  // —— 面板级状态（跨重画保持）——
  let paneMode: ViewMode = 'score'
  let modeBeforeGuides: ViewMode = 'page'
  /** 拖拽中的草稿配置（拖完写回源码后清空） */
  let draft: PageConfig | null = null
  /** 当前拖拽的 window 监听清理函数 */
  let endDragListeners: (() => void) | null = null
  /**
   * adj725：**块右上角 `</>` 按钮**（`host.onEditSource` 有值时才建）。
   *
   * 放在 `paint()` 之外的理由与工具条同源：显隐由容器上的 pointer 事件驱动，
   * 而 `paint()` 每次都会把容器清空重建 —— 变量必须能跨重画指向**当前那一个**按钮。
   */
  let editSourceBtn: HTMLElement | null = null
  /**
   * adj725b：**"还没量到内容盒"时挂着的 ResizeObserver**。
   * 声明在 `paint()` 之外：重画与 `destroy()` 都要能一次性断掉它们（旧 svg 已经被丢弃）。
   */
  const cropObservers = new Set<ResizeObserver>()
  /**
   * adj725：挂载时给宿主 widget 容器加的类（`.cm-embed-block`）。
   * 记下来是为了 `destroy()` 时能原样摘掉，不去动别的插件/别的块。
   */
  let hostWidgetEl: HTMLElement | null = null

  /**
   * adj740：被我们加了「放开裁剪」类的祖先元素（销毁时逐个摘掉，不去污染宿主的 DOM）。
   * 这些类是我们唯一允许写在**别人元素**上的东西，所以必须记全、必须能干净撤销。
   */
  const noClipEls = new Set<HTMLElement>()

  /**
   * adj725（用户要求）：**工具条浮到谱面块外侧** ⇒ 实时预览下会被宿主的 `overflow: hidden` 裁掉。
   *
   * Obsidian 的 `app.css` 里有 `.cm-embed-block:hover { overflow: hidden }`（悬停时才加），
   * 而工具条**正是悬停才显示** ⇒ 不处理的话它在实时预览里"永远看不见"（阅读模式没这层容器，没事）。
   * 做法：只给承载本面板的那个 widget 容器加一个类，由 styles.css 放开裁剪（不碰别人的块）。
   *
   * adj737（用户报「阅读模式才显示工具条与 `</>`，**编辑模式不显示**」）：**这个类必须能重打**。
   * 旧实现只在挂载时打一次，而实时预览里 CM6 会**复用/重建**块容器（滚动、重新排版、光标进出块都会）
   * ⇒ 我们的面板被挪到**新的**块元素里，旧元素上的类留在原地 ⇒ 悬停时宿主那条 `overflow: hidden`
   * 重新把浮在块外的工具条**整条裁掉**（`</>` 同时退回主题色，在白纸上等于看不见）。
   * 现在 `revealToolbar(true)` 每次都会再确认一遍（本函数是幂等的：同类同名直接返回）。
   */
  const markHostWidget = (): void => {
    const widget = container.closest(CM_EMBED_BLOCK)
    if (!(widget instanceof HTMLElement)) return
    if (widget === hostWidgetEl) {
      // 同一个元素：类可能被宿主重建 DOM 时带走（`class` 属性被覆盖）⇒ 缺了就补
      if (!widget.hasClass('ijipu-cm-host')) widget.addClass('ijipu-cm-host')
      return
    }
    // 面板被挪进了**新的**块元素 ⇒ 老元素上的类要摘掉（不去动别人的块）
    hostWidgetEl?.removeClass('ijipu-cm-host')
    widget.addClass('ijipu-cm-host')
    hostWidgetEl = widget
  }

  /**
   * adj740（用户报「编辑视图下工具条还是不可见」）：**把所有"会裁剪"的祖先逐层放开**（滚动容器除外）。
   *
   * 为什么不能只处理 `.cm-embed-block`：实时预览里我们的面板外面还有一整套 CM6 容器
   * （`.cm-editor > .cm-scroller > .cm-content > .cm-line > .cm-embed-block`），
   * 任何一层 `overflow: hidden/clip` 都能把浮在块外的工具条裁掉；而**到底哪一层在裁**，
   * 只有真机 DOM 量得出来。做法：
   *  · 从面板往上走到 `.cm-editor`（含）为止（**不走更外层**，免得动到 Obsidian 的编辑器骨架）；
   *  · 逐层取计算样式的 `overflow`/`overflow-y`，是 `hidden`/`clip` 就加 `ijipu-cm-noclip` 类放开；
   *  · ⚠ **滚动容器绝不放开**（判据：`scrollHeight > clientHeight + 1`）—— 放开它会直接破坏编辑器滚动；
   *  · 顺手把实测结果写成一行诊断（见 `noteToolbar`），用户截图即可定位。
   */
  const exemptClippingAncestors = (): string[] => {
    const facts: string[] = []
    /**
     * adj743：**从 `container` 自己开始量**（用户诊断里工具条"命中自身却看不见" ⇒ 必须检查
     * 它的直接父元素 `.ijipu-score` 有没有把它裁掉/压掉）。
     */
    let el: HTMLElement | null = container
    let depth = 0
    while (el && depth < 8) {
      depth += 1
      const isEditorRoot = el.hasClass('cm-editor')
      const cs = window.getComputedStyle(el)
      const clips = /hidden|clip/.test(cs.overflowY) || /hidden|clip/.test(cs.overflowX)
      /**
       * adj742（用户诊断截图：`.view-content` 被误判成"非滚动容器"从而被放开）：
       * **滚动容器要按"设计意图"认，而不是按当前是否溢出**（内容不多时 `scrollHeight === clientHeight`
       * ⇒ 旧判据会漏判 ⇒ 我们就把真正的滚动容器放开了）。
       * 判据：任一轴的计算 `overflow` 是 `auto`/`scroll` ⇒ 它天生就是滚动容器，**绝不动它**。
       */
      const scrollByDesign = /auto|scroll/.test(cs.overflowY) || /auto|scroll/.test(cs.overflowX)
      const name = el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') || el.tagName.toLowerCase()
      /**
       * adj743（安全收紧）：**只放开 `.cm-*` 那一族宿主层**（本插件的宿主 widget 与 CM6 的容器），
       * **绝不动** `.view-content` / `.workspace-leaf` 这类**宿主的骨架** ——
       * 上一轮把 `.view-content` 的 `overflow` 改成 `visible`，等于替宿主改滚动/裁剪骨架，
       * 风险远大于收益（而且诊断显示工具条本来就落在它的可视区内，并不需要放开）。
       */
      const isCmLayer = el.hasClass('cm-editor') || el.className.includes('cm-')
      /**
       * adj745（用户诊断决定性一击）：`![[xxx.jps]]` 嵌入那条路上，宿主的 `.internal-embed`
       * 带 **`contain: paint`** —— 它把**框外的一切裁掉**，而工具条按用户要求正浮在框外上方
       * ⇒ 每次都被裁。`contain: paint` **不体现在 `overflow` 上**，所以前几轮一直在改 `overflow`
       * 都没打中。归属：`ijipu-embed` / `ijipu-score` / `block-language-jps` 都是**我们自己加**的类
       * ⇒ 可以安全地把它们的 `contain` 降级为 `layout style`（保住性能收益，去掉裁剪）。
       * ⚠ 宿主的骨架（`.view-content` / `.workspace-leaf` / 别人的 `.internal-embed`）一律不动。
       */
      const isOurs = el.hasClass('ijipu-embed') || el.hasClass('ijipu-score') || el.hasClass('block-language-jps')
      const canTouch = isCmLayer || isOurs
      if (clips) {
        // 不动它的理由（为空 = 该放开）——写成变量而不是嵌套三元，免得模板字符串里套引号
        const whyNot = scrollByDesign ? '是滚动容器' : canTouch ? '' : '是宿主骨架'
        if (whyNot !== '') {
          facts.push(`${name}:裁剪但（${whyNot}）不动它`)
        } else {
          if (!el.hasClass('ijipu-cm-noclip')) el.addClass('ijipu-cm-noclip')
          noClipEls.add(el)
          facts.push(`${name}:裁剪→已放开`)
        }
      }
      /**
       * adj745：`contain` 里的 `paint` / `strict` / `content` 都会**裁剪**（`strict` 与 `content`
       * 还包含尺寸包含）⇒ 对我们自己的元素降级成 `layout style`（不裁、仍隔离布局与样式计算）。
       */
      if (canTouch && /paint|strict|content/.test(cs.contain)) {
        if (!el.hasClass('ijipu-cm-nocontain')) el.addClass('ijipu-cm-nocontain')
        noClipEls.add(el)
        facts.push(`${name}:contain=${cs.contain}→改为 layout style`)
      }
      /**
       * adj742：`overflow` 之外还有几种"照样裁/照样盖"的机制，它们**不体现在 overflow 上** ——
       * 用户那句诊断里工具条 `opacity/visibility` 都正常却看不见，问题多半就在这几项上，
       * 所以这里把它们**逐层记下来**（先诊断、再决定动不动它）。
       */
      const extra: string[] = []
      if (cs.contain && cs.contain !== 'none') extra.push(`contain=${cs.contain}`)
      if (cs.contentVisibility && cs.contentVisibility !== 'visible') extra.push(`content-visibility=${cs.contentVisibility}`)
      if (cs.transform && cs.transform !== 'none') extra.push('transform')
      if (cs.isolation && cs.isolation === 'isolate') extra.push('isolation:isolate')
      if (cs.zIndex !== 'auto' && cs.position !== 'static') extra.push(`z-index=${cs.zIndex}`)
      if (extra.length > 0) facts.push(`${name}:${extra.join(',')}`)
      if (isEditorRoot) {
        facts.push('到 .cm-editor 为止')
        break
      }
      el = el.parentElement
    }
    return facts
  }

  /**
   * adj740：把"工具条为什么看不见"的实测快照写进 `plugin.lastToolbarInfo`（设置页显示）。
   * 记的是**用户真正关心的三件事**：宿主是哪一类（阅读视图 / 实时预览）、有没有触发显示、
   * 以及裁剪链上每一层发生了什么 + 工具条与裁剪区的几何关系。
   */
  const noteToolbar = (phase: string, facts: string[], toolbarEl: HTMLElement): void => {
    const d = new Date()
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    const stamp = `${hh}:${mm}:${ss}`
    /**
     * adj742：**命中测试**（用户诊断截图证明"样式正常却看不见"⇒ 必须回答"那个点上到底是谁"）。
     * 下一帧再量：`is-revealed` 的类刚加上，样式表要等一次重排；`elementFromPoint` 按**当前**绘制结果回答。
     */
    window.requestAnimationFrame(() => {
      const rect = toolbarEl.getBoundingClientRect()
      const score = container.getBoundingClientRect()
      const cx = Math.round(rect.left + rect.width / 2)
      const cy = Math.round(rect.top + rect.height / 2)
      const hit = cx > 0 && cy > 0 ? document.elementFromPoint(cx, cy) : null
      const hitDesc = hit
        ? toolbarEl.contains(hit)
          ? '命中工具条自身 ✓'
          : `命中**别的元素**：${hit.tagName.toLowerCase()}.${String(hit.className).split(/\s+/).slice(0, 2).join('.')}`
        : '命中空白（该点不在视口内，或已被裁掉）'
      const inViewport = cy >= 0 && cx >= 0 && cy <= window.innerHeight && cx <= window.innerWidth
      const cs = window.getComputedStyle(toolbarEl)
      /**
       * adj743（用户诊断："命中工具条自身 ✓"却仍看不见）：命中测试只能证明"那个点上最上层是它"，
       * **证明不了它肚子里有东西**。所以这里把工具条**内部**也量出来：
       * 子元素个数、首个按钮的 `display/visibility` 与尺寸、以及 `innerText` 是否为空
       * （空 ⇒ 是个透明空盒子 ⇒ 多半是容器查询把里面的按钮/文字全隐了）。
       */
      const kids = Array.from(toolbarEl.children) as HTMLElement[]
      const first = kids[0]
      const firstCs = first ? window.getComputedStyle(first) : null
      const firstRect = first?.getBoundingClientRect()
      const kidDesc =
        kids.length === 0
          ? '子元素 0 个（**空盒子**）'
          : `子元素 ${kids.length} 个；首个=${first.tagName.toLowerCase()}.${String(first.className).split(/\s+/).slice(0, 2).join('.')}` +
            ` display=${firstCs?.display} visibility=${firstCs?.visibility}` +
            ` ${Math.round(firstRect?.width ?? 0)}×${Math.round(firstRect?.height ?? 0)}`
      const text = (toolbarEl.innerText ?? '').replace(/\s+/g, ' ').trim()
      plugin.lastToolbarInfo =
        `${stamp} · ${phase}` +
        `｜宿主=${container.closest(CM_EMBED_BLOCK) ? '实时预览' : '阅读视图/其他'}` +
        `｜显示类=${toolbarEl.hasClass('is-revealed') ? '有' : '无'}` +
        `｜样式 opacity=${cs.opacity} visibility=${cs.visibility} position=${cs.position}` +
        ` bg=${cs.backgroundColor}` +
        `｜工具条 ${Math.round(rect.width)}×${Math.round(rect.height)} @(${Math.round(rect.left)},${Math.round(rect.top)})` +
        `｜谱面块 @(${Math.round(score.left)},${Math.round(score.top)})` +
        `｜视口内=${inViewport ? '是' : '否'}` +
        `｜命中测试@(${cx},${cy})：${hitDesc}` +
        `｜内容：${kidDesc}｜innerText=${text.length > 0 ? `「${text.slice(0, 40)}」` : '**空**'}` +
        (facts.length > 0 ? `｜祖先链：${facts.join(' → ')}` : '｜祖先链：无裁剪层')
    })
  }

  const stopRuntime = (): void => {
    stopPlay?.()
    stopPlay = null
    cancelAnimationFrame(rafId)
  }

  /**
   * adj652（用户要求）：谱面文本里的**链接**（引擎把 URL 包成 `a.jp-link`，如 `S:` 谱尾说明里的官网）
   * 点击 → 用系统浏览器打开。
   *
   * 挂在 `container` 上（**委托**）而不是每个 `<a>` 上：`paint()` 每次都 `container.empty()` 重建 SVG，
   * 挂在容器上只需注册一次。先 `preventDefault`：不让 SVG 自己的 `target="_blank"` 抢着走
   * （Electron 下它的行为不可靠，见 `openExternal.ts` 的说明）。
   */
  container.addEventListener('click', (evt) => {
    const link = (evt.target as Element | null)?.closest?.('a.jp-link')
    if (!link) return
    evt.preventDefault()
    evt.stopPropagation()
    void openUrlExternally(link.getAttribute('data-href') ?? link.getAttribute('href') ?? '')
  })

  /** 全量重画（工具条 + 谱面 + 辅助虚线）；拖拽期间按帧节流 */
  const paint = (): void => {
    stopRuntime()
    // adj725b：上一轮挂的补量观察器盯着的是即将被丢弃的 svg ⇒ 先全部断掉
    for (const ro of cropObservers) ro.disconnect()
    cropObservers.clear()
    container.empty()
    container.addClass('ijipu-score')
    if (host.embedded) container.addClass('ijipu-embedded')
    markHostWidget()

    const source = host.getSource()
    // adj738：优先级 = 默认 < 插件设置 < 源内 `# jps-config`（笔记 frontmatter 那一层已删除）
    const resolved = resolvePageConfig(source, plugin.settings)
    const cfg = draft ?? resolved.config
    const { svgs, layout: layoutMaybe, error, warnings, errorIssues } = renderScoreFull(source, cfg)

    if (error || !layoutMaybe) {
      // adj394：错误也给出「正确写法」（引擎 hint）——不只告诉用户哪里错了
      const errBox = container.createDiv({ cls: 'ijipu-error', text: `⚠ 简谱解析失败：\n${error ?? '无排版结果'}` })
      for (const e of errorIssues ?? []) {
        if (e.hint) errBox.createDiv({ cls: 'ijipu-hint', text: `正确写法：${e.hint}` })
      }
      return
    }
    // adj394：告警（warning 级）不阻断渲染，但要在谱面下方看得见——
    // 此前插件把任何 errors 都当致命（`errors.length > 0`），一条告警就整页不渲染
    if (warnings && warnings.length > 0) {
      const warnBox = container.createDiv({ cls: 'ijipu-warn' })
      const head = warnBox.createDiv({ cls: 'ijipu-warn-head', text: `⚠ ${warnings.length} 条语法告警（不影响显示）` })
      const list = warnBox.createEl('ul', { cls: 'ijipu-warn-list' })
      for (const w of warnings) {
        const li = list.createEl('li', { cls: 'ijipu-warn-item' })
        li.createSpan({ cls: 'ijipu-warn-text', text: w.text })
        // adj394：告警下方给出正确语法规则（引擎 hint，含最小示例）
        if (w.hint) li.createSpan({ cls: 'ijipu-hint', text: `正确写法：${w.hint}` })
      }
      let open = false
      list.toggleClass('is-open', open)
      head.onclick = () => {
        open = !open
        list.toggleClass('is-open', open)
      }
      head.setAttr('title', '点击展开/收起告警明细（含正确写法）')
    }
    // 收窄为常量：闭包（虚线层/拖拽）里也要用，TS 不会跨函数保留 null 判定
    const layout = layoutMaybe

    // —— 工具条 ——
    // 注：「谱面自带设置 N 项」不再占工具栏位置 —— 移到「设置」对话框里（见 ConfigDialog）
    const toolbar = container.createDiv({ cls: 'ijipu-score-toolbar' })
    /**
     * adj724b（用户要求）：**工具条默认隐藏，鼠标移到谱面上才显示**。
     *
     * 为什么：Obsidian「导出为 PDF」会把渲染出来的 DOM 一起导出 ⇒ 工具栏（试听/排版/设置/谱面）
     * 会出现在导出的文件里，而它属于**操作界面**、不该进成果。
     *
     * 实现要点（三条都不能少，CSS 见 styles.css 的 `.ijipu-score-toolbar`）：
     * ① **`visibility: hidden`（不是只降透明度）**：隐藏时**不绘制**（导出里不会出现）、
     *    也**不进入 Tab 焦点顺序** —— 只降 `opacity` 的话这两条都不成立。
     * ② **移动端常显**：触屏没有 hover，隐藏后就再也点不到按钮了（CSS 里排除 `.is-mobile`）。
     * ③ **键盘可达**：隐藏时不可聚焦 ⇒ 由容器级 `keydown` 唤醒（见下面 `onKeyDown`）。
     *
     * adj725：块右上角的 `</>` 按钮与工具条**共用这一套显隐**（`is-revealed`）——
     * 两处都是"操作界面"，导出时都该消失，行为也该一致。
     */
    const revealToolbar = (on: boolean): void => {
      // adj737：**先**确认宿主块被标了类再显示 —— 否则悬停那一下正好被宿主的
      // `.cm-embed-block:hover { overflow: hidden }` 裁掉（实时预览里块容器会被 CM6 换掉，类会丢）
      if (on) {
        markHostWidget()
        // adj740：再逐层放开**所有**会裁剪的祖先（滚动容器除外），并把实测快照记进设置页诊断
        noteToolbar('指针进入/键盘唤醒（显示工具条）', exemptClippingAncestors(), toolbar)
      }
      toolbar.toggleClass('is-revealed', on)
      editSourceBtn?.toggleClass('is-revealed', on)
    }
    const onPointerMove = (e: PointerEvent): void => {
      // 说明：`.ijipu-score` 区在窄栏里可能几乎占满，故不做区域判定，只认"指针在谱面容器内移动"；
      // 移动端由 CSS 常显兜底，这里不重复判断。
      if (e.pointerType === 'touch') return
      revealToolbar(true)
    }
    const onPointerLeave = (): void => {
      // 焦点仍在工具条内（键盘操作中）→ 不收起，避免"正在用却被藏掉"
      if (toolbar.contains(document.activeElement)) return
      revealToolbar(false)
    }
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerleave', onPointerLeave)
    /**
     * 键盘可达性的**真正入口**：工具条隐藏时 `display:none` ⇒ **不可聚焦**，`focusin` 等不到 Tab。
     * 故在容器层面监听 `keydown`：只要焦点在谱面容器内、用户敲了键，就把工具条显示出来
     * （此后 Tab 便能进入其中的按钮）。这是纯键盘用户的唯一入口。
     */
    const onKeyDown = (): void => revealToolbar(true)
    container.addEventListener('keydown', onKeyDown)
    // 焦点进出工具条时同步（指针用户用鼠标移入/移出时的兜底）
    toolbar.addEventListener('focusin', () => revealToolbar(true))
    toolbar.addEventListener('focusout', () => {
      if (!toolbar.contains(document.activeElement)) revealToolbar(false)
    })
    plugin.register(() => {
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerleave', onPointerLeave)
      container.removeEventListener('keydown', onKeyDown)
    })
    if (!host.embedded) toolbar.createSpan({ cls: 'ijipu-page-label', text: `${svgs.length} 页` })
    // adj738：工具条这里原来还有一枚「frontmatter 覆盖 N 项」徽标 —— 笔记 frontmatter 层已删除，
    // 值只可能来自「插件设置」或「源内 # jps-config」两种来源（后者在「⚙ 设置」对话框里列出自带项）。

    // —— 试听（播放/停止 + RAF 驱动色块跟随，与 iJipu 一致）——
    let playing: { cancel: () => void; totalMs: number; track: PlayheadSeg[] } | null = null
    let playStart = 0
    // 试听按钮：图标 + 文字（窄容器里文字由 @container 规则隐藏，只留图标）
    const playBtn = toolbar.createEl('button', { cls: 'ijipu-play' })
    const playIconEl = playBtn.createSpan({ cls: 'ijipu-btn-icon' })
    const playLabel = playBtn.createSpan({ cls: 'ijipu-btn-label', text: '试听' })
    /** 切换试听按钮的「图标 + 文字 + 悬停说明」（三者必须同步换，否则窄容器下会显示错） */
    const setPlayState = (isPlaying: boolean): void => {
      playIconEl.empty()
      playIconEl.appendChild(isPlaying ? stopIcon(15) : playIcon(15))
      playLabel.setText(isPlaying ? '停止' : '试听')
      playBtn.setAttr('title', isPlaying ? '停止试听' : '试听这一份谱（可边听边看高亮色块）')
    }
    setPlayState(false)
    const svgEls: SVGSVGElement[] = []

    const clearPlayBlock = (): void => {
      for (const svgEl of svgEls) svgEl.querySelectorAll('.ijipu-play-block').forEach((el) => el.remove())
    }

    /** 与 iJipu PreviewPane.playheadPosOf 完全一致：按拍段定位整曲行色块（每组独立；多声部各行） */

    /**
     * 绘制一个色块（adj452）：颜色优先取**声部角色**（`playVoice`：bz 伴奏蓝 / dsb 下层绿 /
     * dsb 上层红），否则按**音色**着色（与 iJipu 应用 `playheadBaseOf` 同一规则）。
     */
    const addBlock = (pageIndex: number, pos: PlayheadPos, colorMap: Map<string, number>): void => {
      const svgEl = svgEls[pageIndex]
      if (!svgEl) return
      const color = playheadBaseOf(pos, colorMap)
      // adj724b（社区审核）：用 Obsidian 全局 createSvg 取代 document.createElementNS（prefer-create-el）
      const rect = createSvg('rect')
      rect.setAttribute('class', 'ijipu-play-block')
      rect.setAttribute('x', String(pos.x))
      rect.setAttribute('width', String(Math.max(1, pos.width)))
      rect.setAttribute('y', String(pos.yTop))
      rect.setAttribute('height', String(Math.max(1, pos.yBottom - pos.yTop)))
      rect.setAttribute('fill', `${color}0.32)`)
      rect.setAttribute('stroke', `${color}0.5)`)
      rect.setAttribute('stroke-width', '1')
      svgEl.appendChild(rect)
    }

    const stopPlayFn = (): void => {
      playing?.cancel()
      playing = null
      cancelAnimationFrame(rafId)
      clearPlayBlock()
      setPlayState(false)
      plugin.unregisterPlay(stopPlayFn)
    }

    const tick = (): void => {
      const currentMs = performance.now() - playStart - 200 // 与 iJipu 一致的 200ms 起播延迟
      const noteSize = cfg.note_size ?? 13
      const track = playing?.track ?? []
      clearPlayBlock()
      if (currentMs > 0 && track.length) {
        // adj452：按 (页, 曲行, 声部, 音色, 声部角色) **逐组建色块**——与 iJipu 应用同规则：
        // 多声部各声部一块；重叠区（bz 伴奏 / dsb 上下层）在同一曲行里同时发声也各有各的块
        // （旧实现"每个曲行只取一个当前拍段"只画得出一块，且高度用硬编码、不按音色配色）。
        const colorMap = instrumentColorMap(track)
        for (const [key, segs] of trackKeysOf(track)) {
          const pageIndex = Number(key.split('|')[0])
          if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= svgEls.length) continue
          const pos = playheadPosIn(segs, currentMs, pageIndex, noteSize)
          if (pos) addBlock(pageIndex, pos, colorMap)
        }
      }
      const total = playing?.totalMs ?? 0
      if (currentMs >= total) {
        clearPlayBlock()
        playing = null
        setPlayState(false)
        plugin.unregisterPlay(stopPlayFn)
        return
      }
      rafId = window.requestAnimationFrame(tick)
    }

    stopPlay = stopPlayFn

    playBtn.addEventListener('click', () => {
      if (playing) {
        stopPlayFn()
        return
      }
      void playScore(source, cfg, {
        hqVoice: plugin.settings.hqVoice,
        workletUrl: plugin.getWorkletUrl(),
        // adj729：音源优先从**插件目录**里的文件取（下载/导入过就随文库一起走）
        bankFiles: plugin.getBankFiles(),
      })
        .then((r) => {
          if (!r) {
            setPlayState(false)
            return
          }
          playing = r
          playStart = performance.now()
          setPlayState(true)
          cancelAnimationFrame(rafId)
          rafId = window.requestAnimationFrame(tick)
          plugin.registerPlay(stopPlayFn)
        })
        .catch((e) => {
          setPlayState(false)
          /**
           * adj728（用户要求）：「无法下载音色库的提示显示时间不长，应有个按钮链接用户打开全局的音色库」
           * ⇒ 试听失败不再只弹一条 6 秒的 `Notice`，而是**带一个按钮**：
           * 点它打开嵌入版 iJipu 的「设置 → 音色库」（音源自动下载在部分网络不可达，
           * 那里能**手动下载 + 导入**：面板上有「打开下载页」与三步引导）。
           * `timeout = 0` 表示**不自动消失**——几秒读完再点按钮，本来就做不到。
           */
          const msg = e instanceof Error ? e.message : String(e)
          const notice = new Notice(`试听失败：${msg}`, 0)
          const btn = notice.noticeEl.createEl('button', { cls: 'ijipu-notice-action', text: '打开音色库设置' })
          btn.setAttr('type', 'button')
          btn.addEventListener('click', () => {
            notice.hide()
            void plugin.openEmbedSoundbank()
          })
        })
    })

    // —— 排版（田字格）：开关"排版辅助虚线"，显示后可拖动虚线调边距/行距 ——
    const guidesBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-guides-btn' })
    guidesBtn.setAttr(
      'title',
      plugin.showGuides
        ? '排版：隐藏辅助虚线（虚线可直接拖动调整边距/行距）'
        : '排版：显示辅助虚线（拖动虚线调整边距/行距，松手即写入谱面设置；自动切到整页视图）',
    )
    guidesBtn.appendChild(layoutIcon(15))
    guidesBtn.createSpan({ cls: 'ijipu-btn-label', text: '排版' })
    guidesBtn.classList.toggle('is-active', plugin.showGuides)
    guidesBtn.addEventListener('click', () => {
      const on = plugin.toggleGuides()
      if (on) {
        // 边距在「谱面（裁掉边距）」模式下看不见，故显示虚线时切到整页视图，关闭后恢复
        modeBeforeGuides = paneMode
        if (paneMode === 'score') paneMode = 'page'
      } else if (paneMode !== modeBeforeGuides) {
        paneMode = modeBeforeGuides
      }
      paint()
    })

    // —— 页面设置（滑杆）：对话框按字段精确设值（字体/字号等不可拖项） ——
    if (host.writeSource) {
      /**
       * adj749（用户报，手机端：「会因外延的工具条而遮住一半的源码、格式化按钮，
       * 可以考虑把这两个按钮放在工具条上」）：**预览态把这两个动作收进浮动工具条**。
       * 工具条在手机端常显（`.is-mobile` 规则）⇒ 随时可点；文件栏在预览态只剩文件名，不再重叠。
       */
      if (host.onToggleSource) {
        const srcBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-source-btn' })
        // adj749b（用户要求）：**按钮名统一为「编辑」**（不再叫"源码"）—— 与 `</>` 的语义一致，
        // 用户看到的就是"编辑这份谱的源码"这一个动作。
        srcBtn.setAttr('title', '编辑源码（手机上用 Obsidian 的编辑器，源码模式）')
        srcBtn.appendChild(sourceIcon(15))
        srcBtn.createSpan({ cls: 'ijipu-btn-label', text: '编辑' })
        srcBtn.addEventListener('click', () => host.onToggleSource?.())
      }
      if (host.onFormat) {
        const fmtBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-format-btn' })
        fmtBtn.setAttr('title', '按应用规范格式化源码（音符/小节线空格、歌词里的 {tp … } 段、描述头属性）')
        fmtBtn.appendChild(layoutIcon(15))
        fmtBtn.createSpan({ cls: 'ijipu-btn-label', text: '格式化' })
        fmtBtn.addEventListener('click', () => host.onFormat?.())
      } else {
        /**
         * adj746：代码块宿主没有 `onFormat` 时，仍保留"就地格式化"（它自己有 `getSource`/`writeSource`）。
         */
        const fmtBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-format-btn' })
        fmtBtn.setAttr('title', '按应用规范格式化源码（音符/小节线空格、歌词里的 {tp … } 段、描述头属性）')
        fmtBtn.appendChild(layoutIcon(15))
        fmtBtn.createSpan({ cls: 'ijipu-btn-label', text: '格式化' })
        fmtBtn.addEventListener('click', () => {
          const before = host.getSource()
          const next = formatJps(before)
          if (next === before) {
            new Notice('源码已是应用规范格式（无需改动）', 3000)
            return
          }
          void host.writeSource?.(next)
          new Notice('已按应用规范格式化源码', 4000)
        })
      }
      const cfgBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-config-btn' })
      cfgBtn.setAttr('title', '页面设置：按字段精确设值（字体/字号/行距/渲染开关；可保存到谱面或存为插件默认）')
      cfgBtn.appendChild(settingsIcon(15))
      cfgBtn.createSpan({ cls: 'ijipu-btn-label', text: '设置' })
      cfgBtn.addEventListener('click', () => {
        new ConfigDialog(plugin.app, {
          current: resolved.config,
          // 「谱面自带设置 N 项」不再挂工具栏，改写进对话框（含具体是哪几项、值是什么）
          sourceFields: resolved.sourceFields,
          sourceValues: resolved.config as unknown as Record<string, unknown>,
          onApply: (target, next) => {
            if (target === 'plugin') {
              /**
               * adj631（用户报"预览页面的设置与 设置-iJipu 里的设置项不同步"）：
               * 「保存为插件默认」**只写本次在对话框里真正改动过的项**。
               *
               * 此前是把**整份草稿**写进插件设置，而草稿初值是"这份谱的**生效值**"
               * （含笔记 frontmatter 与源码 `# jps-config`）⇒ 点一下就把**本谱专属的值**变成**全库默认**：
               * 「设置 → iJipu」随即显示出一堆你从没在那里设过的值、别的笔记观感也跟着变。
               * 现在与 iJipu 应用"只固化用户改动"（`mergeConfigEdits`）同一口径：
               *  · 与打开对话框那一刻不同的字段才写；等于引擎默认的**从插件设置里移除**（保持稀疏）；
               *  · 一项都没动 ⇒ 明确提示，不写任何东西。
               */
              const bag = plugin.settings as unknown as Record<string, unknown>
              const src = next as unknown as Record<string, unknown>
              const changed = changedDefs(resolved.config, next)
              if (changed.length === 0) {
                new Notice('对话框里没有改动——插件默认未变（要改本库默认请直接改，或先改动再保存）', 4000)
                return
              }
              for (const def of changed) {
                const k = def.key as string
                if (isDefaultValue(def, src[k])) delete bag[k]
                else bag[k] = src[k]
              }
              void plugin
                .saveSettings()
                .then(() => new Notice(`已保存为插件默认：${changed.length} 项（对未自带设置的谱生效）`))
              return
            }
            // adj480：两个去向的口径**与应用对齐**——
            //  · 'score'（默认）：只写**本次改动**（`mergeConfigEdits`，基线 = 对话框打开时的生效配置）——
            //    插件设置 / frontmatter 带来的值不会被顺手烧进谱面（否则"改一处、全库统一变"的能力就没了）；
            //  · 'score-full'（随谱固化）：把**与引擎默认不同的全部生效项**写进谱面（差量模式 + 生效配置
            //    = 只多写"真正影响外观"的那些项），供"复制给他人也一模一样"。
            //    此前用的是 mode:'full'（连与默认相同的项也写 ≈ 900 字符），现已收敛为差量口径。
            const baseline = resolved.config
            const payload = target === 'score-full' ? next : mergeConfigEdits(host.getSource(), baseline, next)
            void Promise.resolve(host.writeSource?.(writeJpsConfig(host.getSource(), payload)))
              .then(() => {
                new Notice(
                  target === 'score-full'
                    ? '已随谱固化：与默认不同的全部设置都写进了 # jps-config（复制给他人显示一致）'
                    : '已写入谱面 # jps-config（只记录本次改动、与默认不同的项）',
                )
                paint()
              })
              .catch((e) => new Notice(`写入谱面失败：${e instanceof Error ? e.message : String(e)}`, 6000))
          },
        }).open()
      })
    }

    /**
     * adj725（用户要求）：**块右上角的 `</>`「编辑源码」**。
     *
     * 用户口径：「切源码方式是在预览的笔记源码间切换，源码如图，不要再单独的 textarea」
     * + 「编辑切换如图的右上角方式」⇒ 形态照抄 Obsidian 给块自己挂的「编辑此块」
     * （`lucide-code-2` 图标、落在块的右上角、悬停才显），点它**切回笔记源码**。
     *
     * 三件事必须成对：
     *  ① **只负责"去哪儿编辑"**：真正的编辑在笔记里由 Obsidian 自带编辑器完成
     *     （原生语法高亮、撤销栈、与别的代码块完全一致）；插件不再往预览里塞 textarea。
     *  ② **与工具条共用悬停显隐**（`is-revealed`）：同属操作界面，导出笔记时都该消失。
     *  ③ 实时预览里 Obsidian **自己**也会给代码块挂一个同款按钮（`EmbedWidget.addEditButton`，
     *     见 app.css 的 `.embed-actions`）。两个叠在同处会难看 ⇒ **下一帧**若发现宿主已挂，
     *     就撤掉自己的（此刻按钮还没显形，用户看不到这一帧）。阅读模式没有那层 widget ⇒ 保留我们的。
     */
    if (host.onEditSource) {
      /**
       * ⚠ 用 **div**（而不是 `<button>`）：宿主的 app.css 给 `button` 统一套了
       * `background-color: var(--interactive-normal)` 与一个输入框高度（实测按钮被撑成 30px、
       * 深色底 —— 与 Obsidian 自己那个 `</>` 的外观不一致）。Obsidian 的 `.embed-action` 本身就是
       * **div**，这里照它做；键盘可达性用 `role="button"` + Enter/Space 自己补。
       */
      const btn = container.createDiv({ cls: 'ijipu-edit-source-btn' })
      btn.setAttr('role', 'button')
      btn.setAttr('tabindex', '0')
      btn.setAttr('aria-label', '编辑这段源码')
      btn.setAttr('title', '编辑这段源码（切到笔记源码，改动即时生效）')
      btn.appendChild(sourceIcon(15))
      const act = (): void => host.onEditSource?.()
      btn.addEventListener('click', act)
      btn.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        act()
      })
      editSourceBtn = btn
      /**
       * adj737（用户报「阅读模式才显示 `</>`，编辑模式不显示」）：**只在真的找到宿主那枚按钮时才让位**。
       *
       * 旧实现只看 `.embed-actions`（宿主给"块操作"预留的**容器**）在不在 ⇒ 容器在、里面的按钮却可能
       * 不在（转引用的 `![[x.jps]]`、或该主题/版本下不给代码块挂按钮）⇒ 我们把**自己那枚**撤了，
       * 屏幕上就**什么也没有**（用户看到的正是这个）。现在要求"容器里确实有 `.edit-block-button`"才撤。
       */
      window.setTimeout(() => {
        const host = container.closest(CM_EMBED_BLOCK)
        const hostBtn = host?.querySelector('.embed-actions .edit-block-button, .edit-block-button')
        if (hostBtn instanceof HTMLElement) {
          btn.remove()
          if (editSourceBtn === btn) editSourceBtn = null
        }
      }, 0)
    }

    // —— 显示模式：下拉列表（整页 / 满宽 / 谱面）——
    // 用普通按钮 + Obsidian 的 Menu，而**不是**原生 <select>：
    //  · 原生 select 会给下拉箭头预留内边距、宽度收不紧（在嵌入容器等上下文里还会参与布局，
    //    导致按钮比"图标 + 文字 + 箭头"宽一截）；
    //  · 它的弹层底色/文字色由平台决定，深色主题下会变成浅底浅字。
    // 自绘这三部分后宽度严格等于内容，菜单则完全跟随主题配色（且自带当前项勾选）。
    const modeWrap = toolbar.createEl('button', { cls: 'ijipu-mode-select-wrap' })
    modeWrap.setAttr('type', 'button')
    modeWrap.setAttr('aria-label', '显示模式')
    modeWrap.setAttr('aria-haspopup', 'menu')
    const modeIconEl = modeWrap.createSpan({ cls: 'ijipu-mode-icon' })
    modeIconEl.appendChild(modeIcon(paneMode, 15))
    const modeTextEl = modeWrap.createSpan({ cls: 'ijipu-mode-text', text: MODE_LABEL[paneMode] })
    modeWrap.createSpan({ cls: 'ijipu-mode-caret', text: '▼' })
    modeWrap.addEventListener('click', () => {
      const rect = modeWrap.getBoundingClientRect()
      const menu = new Menu()
      for (const mode of Object.keys(MODE_LABEL) as ViewMode[]) {
        menu.addItem((item) =>
          item.setTitle(MODE_LABEL[mode]).setChecked(paneMode === mode).onClick(() => setMode(mode)),
        )
      }
      // 按按钮下沿对齐展开（鼠标点、键盘 Enter 都适用）
      menu.showAtPosition({ x: rect.left, y: rect.bottom })
    })

    // —— 「编辑」（用户要求，adj724b 改名并改行为）：优先用**嵌入的完整 iJipu**打开 ——
    // 用户原话：「工具栏里的『应用打开』按钮，现在文本应改为『编辑』，并使用嵌入版的 ijipu 来打开」。
    //  · 有 `onEdit` ⇒ 显示「编辑」（走嵌入版 iJipu 的应用页签）；
    //  · 否则退回旧行为「应用打开」（桌面端用系统默认应用打开；手机端/代码块不出现）。
    /**
     * adj726/727（用户要求）：「**有了编辑按钮之后，就不再需要「打开谱面文件」的链接**」；
     * adj727 再细化一层：**仅当「编辑」本身就留在 Obsidian 内**（右侧栏 / 新页签 / 当前页签）才收掉链接 ——
     * 那时链接是重复入口；若「编辑」会把文件交给**系统默认应用**（离开 Obsidian），
     * 链接仍是"在站内打开 `.jps` 视图"的唯一入口 ⇒ 保留（判据见 `embed/openPlan.ts` 的
     * `embedEditLeavesObsidian`，由宿主经 `host.editLeavesObsidian` 告知）。
     */
    const hasEditEntry = !!(host.onEdit && host.filePath)
    const keepEmbedLink = !hasEditEntry || host.editLeavesObsidian === true
    if (hasEditEntry) {
      const editBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-app-open-btn' })
      editBtn.setAttr('title', '用嵌入的爱记谱编辑')
      editBtn.setAttr('aria-label', '用嵌入的爱记谱编辑')
      editBtn.appendChild(appOpenIcon(15))
      editBtn.createSpan({ cls: 'ijipu-btn-label', text: '编辑' })
      editBtn.addEventListener('click', () => host.onEdit?.())
    } else if (host.filePath && canOpenWithDefaultApp(plugin.app)) {
      const appOpenBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-app-open-btn' })
      appOpenBtn.setAttr('title', '使用默认应用打开')
      appOpenBtn.setAttr('aria-label', '使用默认应用打开')
      appOpenBtn.appendChild(appOpenIcon(15))
      appOpenBtn.createSpan({ cls: 'ijipu-btn-label', text: '应用打开' })
      appOpenBtn.addEventListener('click', () => {
        const path = host.filePath as string
        void (async () => {
          try {
            await host.beforeOpenExternal?.()
          } catch (e) {
            // 落盘失败就别假装打开成功：说清楚，让用户先处理保存问题
            new Notice(`保存后再打开失败：${e instanceof Error ? e.message : String(e)}`, 6000)
            return
          }
          await openWithDefaultApp(plugin.app, path)
        })()
      })
    }

    // —— 工具栏右端：打开谱面文件（仅嵌入模式；容器窄时只留链接图标）——
    // adj726/727：有「编辑」且「编辑」留在站内时不再建；「编辑」会离开 Obsidian（默认应用）时保留。
    if (host.embedded && host.embedTitle && keepEmbedLink) {
      const link = toolbar.createEl('button', { cls: 'ijipu-embed-link' })
      link.setAttr('title', `打开谱面文件：${host.embedTitle}`)
      link.setAttr('aria-label', `打开谱面文件：${host.embedTitle}`)
      link.appendChild(linkIcon(15))
      link.createSpan({ cls: 'ijipu-embed-link-text', text: host.embedTitle })
      link.addEventListener('click', () => host.onOpenFile?.())
    }

    // adj738：这里原来两条提示都属"笔记 frontmatter 那一层"——
    // ①「未识别的 frontmatter 键」（含最近键名建议）；②「已不再随谱保存的设置」（编辑器偏好等旧键）。
    // 该层整体删除后，写错键的地方只剩**谱面源码里的 `# jps-config`**，而它的未知键由引擎侧
    // 的解析告警照常提示（见上面的 `warnings`），所以这里不再需要。
    if (plugin.showGuides) {
      container.createDiv({
        cls: 'ijipu-guide-hint',
        text: '排版：拖动虚线调整边距/行距（松手即写入谱面设置）',
      })
    }

    // —— 逐页插入 SVG + 辅助虚线 ——
    const svgWrap = container.createDiv({ cls: `ijipu-svgs ijipu-mode-${paneMode}` })
    svgs.forEach((svg, i) => {
      if (svgs.length > 1 && !host.embedded) {
        container.createDiv({ cls: 'ijipu-page-label', text: `第 ${i + 1} / ${svgs.length} 页` })
      }
      const wrap = svgWrap.createDiv({ cls: 'ijipu-page-svg' })
      /**
       * adj724b（社区审核）：**不要直接写 `innerHTML`**。
       * 官方两条规则：`Unsafe assignment to innerHTML`（error）与
       * `Do not write to DOM directly using innerHTML/outerHTML`（warning）——
       * 下面 `svgToDom()` 走 `DOMParser`，同样不碰 innerHTML。
       *
       * 内容来源：引擎自己画的 SVG（`renderScoreFull` 的输出），不是外部输入。
       */
      wrap.appendChild(svgToDom(svg, plugin))
      const svgEl = wrap.querySelector('svg') as SVGSVGElement | null
      if (!svgEl) return
      svgEls.push(svgEl)
      /**
       * adj724b：**插入 DOM 后立刻量一次真实内容包围盒**并记在元素上。
       *
       * 为什么要在这一刻量：`getBBox()` 要求元素已在渲染树里（刚 `sanitizeHTMLToDom` 出来的
       * 游离节点量不到）；而此刻**辅助虚线层还没加**（`addGuideLayer` 在后面），
       * 量到的就是纯谱面内容。缓存到 dataset，供 `applyViewBox('score')` 与切模式时复用。
       *
       * ⚠ adj725b：宿主（Obsidian）是**先建 DOM、再挂进文档**，所以我们这一刻常常仍在游离树上
       * —— 那就**不必量**（一定全是 0），交给 `scheduleCropRetry` 下一帧补量（见那里的长注释）。
       */
      const box = svgEl.isConnected ? measureContentBox(svgEl) : null
      if (box) {
        writeContentBox(svgEl, box)
      }
      // 不在这里 applyViewBox：此刻还是 'page' 模式（viewBox=整页），套上去纯属多余；
      // 真正的显示模式由下面的 setMode(paneMode) 统一下发（'score' 会用刚量到的内容盒裁剪）。
      if (plugin.showGuides) addGuideLayer(wrap, svgEl, i, cfg)
    })

    /**
     * adj724b（用户要求）：算出**真实内容包围盒**（"只显示有内容的部分，四周不留空白"）。
     *
     * ⚠ **不能用 `svgEl.getBBox()`**：引擎生成的第一层是整页白底
     * `<rect data-page-bg="1" width="100%" height="100%">`（见引擎 `render/index.ts` 的
     * adj629n 注释）—— `getBBox()` 会把白底一起算进去，结果永远等于整页大小。
     * ⇒ 这里**排除 `data-page-bg`**，对其余元素逐个取 `getBBox()` 求并集。
     *
     * 取并集（而不是只取内容 `<g>`）是为了稳妥：引擎的顶层结构可能变化（段层/替换谱层各自包 `<g>`），
     * 逐个求并集对"元素直接挂在 svg 下"和"包在若干 `<g>` 里"都成立。
     *
     * 返回 `null` 表示量不出来（无子元素 / 元素不可见 / 过程中报错）——调用方据此退回"按边距裁"。
     */
    function measureContentBox(svgEl: SVGSVGElement): { x: number; y: number; w: number; h: number } | null {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const child of Array.from(svgEl.children)) {
        const el = child as SVGGraphicsElement
        if (el.getAttribute('data-page-bg')) continue // 整页白底：不是"内容"
        if (typeof el.getBBox !== 'function') continue
        let b: DOMRect
        try {
          b = el.getBBox()
        } catch {
          continue // 未渲染/不可见元素取不到盒，跳过
        }
        if (!(b.width > 0) && !(b.height > 0)) continue
        if (b.x < x0) x0 = b.x
        if (b.y < y0) y0 = b.y
        if (b.x + b.width > x1) x1 = b.x + b.width
        if (b.y + b.height > y1) y1 = b.y + b.height
      }
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || x1 <= x0 || y1 <= y0) return null
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }

    /** 取元素上缓存的内容包围盒（`mountScorePane` 插入 DOM 后量过一次） */
    function contentBoxOf(svgEl: SVGSVGElement): { x: number; y: number; w: number; h: number } | null {
      const raw = svgEl.dataset.contentBox
      if (!raw) return null
      const [x, y, w, h] = raw.split(/\s+/).map(Number)
      if (![x, y, w, h].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0) return null
      return { x, y, w, h }
    }

    /** 把量到的内容盒写进 dataset（`applyViewBox` 与切模式都读它） */
    function writeContentBox(svgEl: SVGSVGElement, box: { x: number; y: number; w: number; h: number }): void {
      svgEl.dataset.contentBox = `${box.x} ${box.y} ${box.w} ${box.h}`
    }

    /**
     * adj735（用户问「设置-说明 里的这处是做什么用？没看明白」）：把裁剪诊断**写成一句人话 + 时间戳**。
     *
     * 这一行是给"谱面还是有 A4 那么大空白"这类问题定位用的运行期诊断（不需要用户操作），
     * 但旧文案是"页面内容包围盒：三次重试都没量到（元素始终不在渲染树里？）"——技术味太重、
     * 又没有任何时间信息 ⇒ 用户打开设置页看到它，既不知道这是什么、也不知道是不是"现在坏了"
     * （其实常常只是当时那一瞬没量到，随后补量已成功）。
     *
     * 现在统一经这里记录：`HH:MM:SS · 人话`，并且**成功/失败都说清后果**（失败也只是"这一瞬间"，
     * 会走补量；显示效果仍可用）。
     */
    function noteCrop(msg: string): void {
      const d = new Date()
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      const ss = String(d.getSeconds()).padStart(2, '0')
      plugin.lastCropInfo = `${hh}:${mm}:${ss} · ${msg}`
    }

    /**
     * adj725b：**量不到就下一帧再量**（量到了当场补裁剪）。
     *
     * 为什么非补不可 —— 这是"谱面模式还留一大片空白"的**真正根因**（用户 2026-10 再次截图复现）：
     * Obsidian 的代码块/widget 是**先把 DOM 建好、再挂进文档**（实时预览的 `initDOM` 建的是游离节点，
     * 阅读模式同理）⇒ 我们挂载那一刻元素**不在渲染树里**，`getBBox()` 一律返回 0
     * ⇒ `measureContentBox()` 返回 null ⇒ 只能退回"按边距裁"（= 整页去掉四边距，空白依旧）。
     *
     * ⚠ 本仓库的浏览器验证页此前把面板挂在**已连接**的容器里，所以怎么测都是好的 ——
     * 现在验证页里也加了"游离容器里挂载、随后才挂进文档"那一支（`out.detached`）。
     *
     * 重试窗口：下一帧 / +60ms / +300ms（宿主的挂载时机无法约定，三次足够且不至于一直重算）。
     * 元素已被重画（`isConnected === false`）就放弃 —— 那时新的 svg 有自己的重试。
     */
    function scheduleCropRetry(svgEl: SVGSVGElement, c: typeof cfg, attempt = 0): void {
      const delays = [0, 60, 300]
      const run = (): void => {
        if (!svgEl.isConnected) return
        const fresh = measureContentBox(svgEl)
        if (fresh) {
          writeContentBox(svgEl, fresh)
          // 只在这一支还处于「谱面」模式时重下 viewBox（用户可能已经切走了）
          if (paneMode === 'score') applyViewBox(svgEl, 'score', c)
          return
        }
        if (attempt + 1 < delays.length) scheduleCropRetry(svgEl, c, attempt + 1)
        else noteCrop('未量到内容盒（那一刻谱面还没进渲染树；已自动重试 3 次、并挂了 ResizeObserver 等它进树）')
      }
      if (delays[attempt] === 0) window.requestAnimationFrame(run)
      else window.setTimeout(run, delays[attempt])
    }

    /**
     * adj725b：**元素"进渲染树"这一刻补量**（比定时重试更可靠）。
     *
     * 宿主把游离 DOM 挂进文档时，元素的尺寸从 0 变成真实尺寸 ⇒ `ResizeObserver` 一定会被叫到，
     * 那就是"现在可以量 getBBox 了"的准确信号。定时重试（`scheduleCropRetry`）作为兜底，
     * 覆盖没有 `ResizeObserver` 的环境、以及"挂进去但尺寸恰好没变"的场景。
     */
    function observeUntilMeasured(svgEl: SVGSVGElement, c: typeof cfg): void {
      if (typeof ResizeObserver === 'undefined') return
      const ro = new ResizeObserver(() => {
        if (!svgEl.isConnected) return
        const box = measureContentBox(svgEl)
        if (!box) return
        ro.disconnect()
        cropObservers.delete(ro)
        writeContentBox(svgEl, box)
        if (paneMode === 'score') applyViewBox(svgEl, 'score', c)
      })
      cropObservers.add(ro)
      ro.observe(svgEl)
    }

    /** 按显示模式设置 viewBox（'score' 裁到**真实内容**，四周不留空白） */
    function applyViewBox(svgEl: SVGSVGElement, mode: ViewMode, c: typeof cfg): void {
      const orig = svgEl.dataset.origVb || svgEl.getAttribute('viewBox') || ''
      svgEl.dataset.origVb = orig
      if (mode === 'score') {
        const [, , w, h] = orig.split(/[\s,]+/).map(Number)
        const box = contentBoxOf(svgEl)
        /**
         * adj724b：**量到的盒必须真的比整页小**，否则视为"量取不可靠"退回边距兜底。
         *
         * 为什么要这道闸：`getBBox()` 在某些宿主/时机下可能把**整页白底**也算进来
         * （引擎第一层就是 `<rect data-page-bg width/height=100%>`），
         * 那时裁剪等于没裁 —— 现象正是"谱面还是有 A4 那么大空白"。
         * 容差取 2%：真实谱面不可能占满整页（上下各有边距），占满即说明量错了。
         */
        const shrunk = !!box && box.h < h * 0.98 && box.w < w * 0.98
        if (box && shrunk) {
          svgEl.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`)
          // 回传给插件，供设置页显示（运行期诊断；见 IJipuPlugin.lastCropInfo 的说明）
          noteCrop(
            `按墨迹裁剪 ${box.w.toFixed(0)}×${box.h.toFixed(0)}（整页 ${Math.round(w)}×${Math.round(h)}，高度只剩 ${((box.h / h) * 100).toFixed(0)}%）`,
          )
        } else {
          const ml = c.margin_left ?? 0
          const mt = c.margin_top ?? 0
          const mr = c.margin_right ?? 0
          const mb = c.margin_bottom ?? 0
          svgEl.setAttribute('viewBox', `${ml} ${mt} ${Math.max(1, w - ml - mr)} ${Math.max(1, h - mt - mb)}`)
          noteCrop(
            box
              ? `退回按边距裁剪（量到的盒几乎等于整页 ${Math.round(w)}×${Math.round(h)}，判定为量取不可靠）`
              : `退回按边距裁剪（没量到内容盒；正在等谱面进入渲染树后补量）`,
          )
          /**
           * adj725b：**"没量到"多半是元素还没进渲染树**（宿主先建后插）⇒ 两条补量路径同时挂上：
           * ① `ResizeObserver`（尺寸 0→真实那一刻）——准；② 定时重试 —— 兜底。
           * "量到的盒几乎等于整页"是**真的量到了**（可能是宿主的白底被算进来），重试没有意义。
           */
          if (!box) {
            observeUntilMeasured(svgEl, c)
            scheduleCropRetry(svgEl, c)
          }
        }
        svgEl.removeAttribute('width')
        svgEl.removeAttribute('height')
      } else {
        svgEl.setAttribute('viewBox', orig)
      }
    }

    function setMode(next: ViewMode): void {
      paneMode = next
      svgWrap.setAttribute('class', `ijipu-svgs ijipu-mode-${next}`)
      // 按钮上的文字、图标、悬停说明跟着走（图标三种形状见 icons.ts，与菜单项一一对应）
      modeTextEl.setText(MODE_LABEL[next])
      modeIconEl.empty()
      modeIconEl.appendChild(modeIcon(next, 15))
      modeWrap.setAttr('title', `显示模式：${MODE_LABEL[next]}（${MODE_HINT[next]}）`)
      for (const svgEl of svgEls) applyViewBox(svgEl, next, cfg)
    }

    /** 生成一页的辅助虚线层（可拖拽） */
    function addGuideLayer(wrap: HTMLElement, svgEl: SVGSVGElement, pageIndex: number, c: typeof cfg): void {
      const page = layout.pages[pageIndex]
      if (!page) return
      const layer = wrap.createDiv({ cls: 'ijipu-guide-layer' })
      const lines = computeGuideLines(layout, c, pageIndex)
      const boxW = svgEl.getBoundingClientRect().width || page.width
      const crop = cropRectFor(paneMode, c, page.width, page.height)
      for (const line of lines) {
        const { style, scale } = guidePlacement(line, crop, page.width, page.height, boxW)
        const el = layer.createDiv({
          cls: `ijipu-guide-line ${line.dir === 'v' ? 'ijipu-guide-h' : 'ijipu-guide-v'}${line.readonly ? ' is-readonly' : ''}${line.kind === 'segment' ? ' ijipu-guide-seg' : ''}`,
        })
        for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v)
        el.setAttr('title', line.title)
        if (line.readonly) continue
        el.addEventListener('mousedown', (e) => startGuideDrag(e, line, scale))
      }
    }

    /**
     * 拖动虚线：按下记初值 → 移动按 `dragDelta` 改草稿并即时重画 → 松手写回谱面源码
     * （与 iJipu 一致：拖动中不落盘，松手才持久化到 `# jps-config`）。
     */
    function startGuideDrag(e: MouseEvent, line: GuideLine, scale: number): void {
      if (line.readonly || !host.writeSource) return
      e.preventDefault()
      e.stopPropagation()
      endDragListeners?.()
      const base = draft ?? resolved.config
      /**
       * adj629q：段层虚线拖的是 `segmentRowGap.{bz,dsb,tp}`（**子对象**，与应用同口径）——
       * 读写都要落到子项上，否则会写出一个顶层 `segmentRowGap_bz` 字段（引擎不认）。
       */
      const segKey = line.key.startsWith('segmentRowGap_') ? line.key.slice('segmentRowGap_'.length) : null
      const startValue = segKey
        ? Number((base.segmentRowGap ?? {})[segKey as 'bz' | 'dsb' | 'tp'] ?? 0)
        : Number((base as unknown as Record<string, unknown>)[line.key] ?? 0)
      const startX = e.clientX
      const startY = e.clientY
      const [min, max] = guideLimits(line.key)
      const onMove = (ev: MouseEvent): void => {
        const delta = dragDelta({ key: line.key, dir: line.dir, invert: line.invert }, startX, startY, ev.clientX, ev.clientY, scale)
        const value = clamp(Math.round((startValue + delta) * 10) / 10, min, max)
        const cur = draft ?? base
        draft = (segKey
          ? { ...cur, segmentRowGap: { ...(cur.segmentRowGap ?? {}), [segKey]: value } }
          : { ...cur, [line.key]: value }) as typeof base
        schedulePaint()
      }
      const onUp = (): void => {
        endDragListeners?.()
        endDragListeners = null
        const finalCfg = draft
        draft = null
        if (!finalCfg) return
        // adj480：与应用同口径——只把**这次拖动的那个字段**并入源码层（`mergeConfigEdits`，
        // 基线 = 按下时的生效配置）。此前直接把"整份生效配置"交给差量写入，于是插件设置 /
        // frontmatter 带来的每个非默认项都会在拖动时被顺手烧进谱面。
        const payload = mergeConfigEdits(host.getSource(), base, finalCfg as PageConfig)
        const shown = segKey
          ? (finalCfg.segmentRowGap ?? {})[segKey as 'bz' | 'dsb' | 'tp']
          : (finalCfg as unknown as Record<string, unknown>)[line.key]
        void Promise.resolve(host.writeSource?.(writeJpsConfig(host.getSource(), payload)))
          .then(() => {
            new Notice(`排版已保存：${line.key} = ${String(shown)}`, 2500)
            paint()
          })
          .catch((err) => {
            new Notice(`保存失败：${err instanceof Error ? err.message : String(err)}`, 6000)
            paint()
          })
      }
      endDragListeners = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    /** 拖拽期间的按帧节流重画 */
    function schedulePaint(): void {
      if (rafPending) return
      rafPending = true
      window.requestAnimationFrame(() => {
        rafPending = false
        paint()
      })
    }

    // 初始显示模式
    setMode(paneMode)
  }

  // 插件设置 / 排版虚线开关变化 → 本面板重画
  const settingsRef = plugin.events.on(SETTINGS_CHANGED, () => paint())
  const guidesRef = plugin.events.on(GUIDES_CHANGED, () => paint())
  paint()

  return {
    /**
     * 宿主写回源码后（`IJipuBlock.writeSource`）会调它重画。
     *
     * adj725：这里**不再需要**"自己触发的保存就别重画"那层保护 —— 源码编辑已经交回笔记
     * （Obsidian 自己的编辑器），面板里不再有可被打断的输入框；重画永远是安全的。
     */
    refresh: () => paint(),
    destroy: () => {
      stopRuntime()
      endDragListeners?.()
      endDragListeners = null
      plugin.events.offref(settingsRef)
      plugin.events.offref(guidesRef)
      // adj725b：补量用的观察器要断开，否则会一直盯着已经被丢弃的 svg
      for (const ro of cropObservers) ro.disconnect()
      cropObservers.clear()
      // adj725：把挂到宿主 widget 容器上的类原样摘掉（那是宿主自己的元素，不留痕）
      hostWidgetEl?.removeClass('ijipu-cm-host')
      hostWidgetEl = null
      // adj740/745：逐层摘掉两类类（都不是我们的元素，必须不留痕）
      for (const el of noClipEls) {
        el.removeClass('ijipu-cm-noclip')
        el.removeClass('ijipu-cm-nocontain')
      }
      noClipEls.clear()
      container.empty()
    },
  }
}
