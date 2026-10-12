/**
 * scorePane.ts — 谱面面板：**代码块 / .jps 文件视图 / ![[x.jps]] 嵌入** 共用的渲染与交互
 *
 * 抽出来的原因：这三种入口需要完全一致的行为（试听色块、显示模式、排版辅助虚线、来源徽标、
 * 页面设置、frontmatter/设置变更即时重渲染、渲染失败提示），各写一份必然漂移。
 *
 * 工具条（adj862 / T-5 定稿）**固定 5 位**：`▶ 试听` / `☰ 排版` / `谱面·页面` / `✎ 编辑` / `⋯ 更多`：
 *  · **试听**＝播放/停止（边听边看高亮色块）；
 *  · **排版**（田字格）＝ 开关**排版辅助虚线**，显示后可**拖动虚线**调边距/行距，
 *    松手即写回谱面源码的 `# jps-config`（与 iJipu「拖动结束即持久化」一致）；
 *  · **谱面·页面**＝显示模式（整页 / 满宽 / 谱面）；
 *  · **编辑**＝按宿主与平台分派（笔记源码 / 宿主编辑器 / 嵌入版 iJipu，见下面那段）；
 *  · **⋯ 更多**＝低频入口（设置 / 格式化 / 打开…）——与**桌面右键**、**手机底部 Action Sheet**
 *    共用同一份菜单模型（`scoreMenu.ts` 的 `buildScoreMenu`）。
 *
 * 渲染管线与 iJipu 应用一致：`resolvePageConfig`（含源内 # jps-config）→ `layoutScore`
 * → `renderScoreToSvg`；试听走 `@ijipu/engine` 的 `buildPlaySequence` + SpessaSynth。
 */
import { Menu, Notice, Platform, sanitizeHTMLToDom } from 'obsidian'
import { writeJpsConfig, mergeConfigEdits, dragDelta, clamp, formatJps, type PageConfig } from '@ijipu/engine'
import { renderScoreFull, playScore, type PlayheadSeg } from './render'
// adj758（清单 B1）：色块的分组/定位/配色来自 **引擎**（应用与插件共用一份；此处只做绘制）
// adj764（清单 B6）：时间轴推进用引擎时钟（与应用共用"推进/暂停续播/取消/到点一次"的语义）
import { createPlaybackClock, instrumentColorMap, playheadBaseOf, playheadPosIn, trackKeysOf, type PlayheadPos } from '@ijipu/engine'
// adj863（T-3 定稿）：**范围**（整页 / 墨迹 ± 每边 N px）的唯一实现在引擎 —— 谱面视图的墨迹裁剪与
// 导出/复制的画布口径都消费它（本文件不再自带 `PAD = 2` 或退化闸的第二份副本）
import { rangeBox, minInkFor, RANGE_PAD_DEFAULT } from '@ijipu/engine'

/** adj764：起播延迟（与应用一致：前 200ms 不计入时间轴，避免"第一拍还没响、色块先动"） */
const PLAY_START_DELAY_MS = 200
import { resolvePageConfig } from './config'
import { ConfigDialog } from './configDialog'
// adj631：「保存为插件默认」要按"本次真正改动过的项"写入（changedDefs）+ 等于引擎默认则不存（isDefaultValue）
import { changedDefs, isDefaultValue } from './defs'
import { layoutIcon, modeIcon, settingsIcon, linkIcon, playIcon, stopIcon, appOpenIcon, formatIcon, editIcon, moreIcon } from './icons'
import { buildScoreMenu, scoreMenuIds, toolbarPolicy, type ScoreMenuActionId } from './scoreMenu'
import { canOpenWithDefaultApp, openUrlExternally, openWithDefaultApp } from './openExternal'
import { computeGuideLines, cropRectFor, guideLimits, guidePlacement, type GuideLine } from './guides'
import { GUIDES_CHANGED, SETTINGS_CHANGED } from './main'
import type IJipuPlugin from './main'
// adj873：导出范围的**缺省值**只有一处定义（`types.ts`）——菜单打勾 / 设置页 / 解析都读它
import { DEFAULT_EXPORT_RANGE } from './types'

type ViewMode = 'page' | 'full' | 'score'
const MODE_LABEL: Record<ViewMode, string> = { page: '整页', full: '满宽', score: '谱面' }
/**
 * 三种显示模式的含义（按钮悬停提示用——图标只表意，文字补足准确含义）。
 *
 * adj871（用户实测「切换视图预览区没有变化」）：原来这三句话对应的三种模式**几何完全一样**
 * （三条 CSS 规则都只是 `width: 100%`）⇒ 现在三句话对应**三种真的不同的几何**：
 *  · 整页 = 整页（含页边距）按 contain 放进**可视区**（宽和高都进视界，上下都看得见）；
 *  · 满宽 = 只有**宽度**进视界（高度超出就滚动）；
 *  · 谱面 = 墨迹包围盒 + 每边 2px（默认，`rangeBox` 口径）。
 */
const MODE_HINT: Record<ViewMode, string> = {
  page: '整页放进可视区（含页边距，上下都可见）',
  full: '只按宽度铺满容器（高度超出就滚动）',
  score: '只显示墨迹包围盒（每边留 2px，默认）',
}
/** adj871：整页拟合的**可见高度下限**（面板再矮也要留出能看的空间）与容器顶边以下的留白（px） */
const PAGE_FIT_MIN_H = 200
const PAGE_FIT_GAP = 24
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
   * adj865（T-5 后续，用户定稿的 `z`）：**块级缩放**。
   *
   * 用户口径（`docs/HANDOVER-CLI-AND-COMMAND-API.md` 二之七）：
   *  · 缺省 / `z=100` ⇒ **100%（自然尺寸）**：1 个 viewBox 单位 = 1 CSS px
   *    ⇒ 音符大小与页面视图**一致**，不再被拉伸放大；
   *  · `z=<数字>` ⇒ 百分比（`z=150` = 150%）；
   *  · **`z=*`** ⇒ **自适应笔记宽度**（= 本功能上线前的行为）。
   *
   * 作用域：**只有笔记里的 ```jps 代码块**会传它，因为"这个块在笔记里摆多大"是**与笔记配合的呈现**，
   * 而 `.jps` 文件视图本身就是整页阅读。
   *
   * ⚠ adj872（**"默认值由谁定"必须写死在这里**，不让它继续当隐式巧合）：
   *  · **代码块**（```jps）：`main.ts` 的 `zoomOfBlock()` ⇒ `jpsBlocks.zoomOfInfo()`
   *    —— **`z` 未写 ⇒ `100`**（固定自然尺寸，1 个 viewBox 单位 = 1 CSS px）；`z=*` ⇒ `'auto'`；`z=N` ⇒ `N`；
   *  · **嵌入块（`![[x.jps]]`）/ `.jps` 文件视图**：**本字段根本不传 ⇒ `undefined`** ⇒
   *    面板**显式**按 `'auto'` 处理（加 `ijipu-zoom-fit`）= **等价 `z=*`**（按宽自适应）。
   *    此前这一档是"两个缩放分支都不进、靠 styles.css 的 `width: 100%` 兜底"的**三层巧合** ⇒
   *    任何人动一下 CSS 就会静默改掉嵌入块/文件视图的默认呈现 ✗ ⇒ adj872 起改成显式（见 `publishDisplaySize`）。
   *
   * 只影响**屏显**：导出/复制仍走引擎的「范围」口径（与 `z` 无关 ✓）。
   */
  zoom?: number | 'auto'
  /**
   * adj870（用户 2026-10-11）：代码块写死的**初始显示模式**（来自 `v=p|w|s`，见 `jpsBlocks.modeOfInfo`）。
   * 只有代码块传它；文件视图 / 嵌入不传 ⇒ 用缺省「谱面」。工具条仍可**会话内临时切换**（参数是落地点、工具条是"看一眼"）。
   */
  mode?: 'page' | 'full' | 'score'
  /**
   * adj871（满宽模式的岔路口）：**开栏行里到底写没写 `z=`**。
   *
   * 为什么 `zoom` 一个值不够用：`zoomOfInfo()` 对「`z` 未写」「`z=100`」「`z=abc`」**都返回 `100`**
   * （那是"解析口径只在一处"的代价 ✓），而满宽模式要分两岔（用户 2026-10-11 口径）：
   *  · `z` 未写 / `z=*` ⇒ **铺满容器宽**（"满宽"的字面意思）；
   *  · `z=N`（写了具体数字，含 `z=100`）⇒ **固定像素宽** = 自然宽 × N/100。
   * ⇒ 由宿主多传一位"写没写"，面板**不去猜**（猜就是把解析口径又写一份 ✗）。
   */
  zoomWritten?: boolean
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
/**
 * adj794e：**面板自增 id**（模块级）—— 外侧落位时工具条会被移到 `document.body`（adj793c），
 * 而 `destroy()` 看不到 `paint()` 里那个局部 `toolbar` ⇒ 用 id 在 body 上精确定位并清掉。
 */
let paneSeq = 0
/**
 * adj794f（用户完整报告：`document.body` 上残留了**两条**旧工具条，属于已销毁的面板 ✗）：
 *
 * 上一版只在 `destroy()` 里清自己那条 ✗ —— 但报告显示**嵌入面板（`![[x.jps]]`）的销毁并没有走到
 * `destroy()`** ✗（两条孤儿的容器都已不在文档里 ✓）⇒ 靠"销毁回调"这条路不可靠 ✓。
 *
 * 所以改成**以事实为准**：维护 `面板 id → 容器元素`，清理时判断
 * "该 id 不存在、**或它的容器已经不在文档里**" ⇒ 移除 body 上那条工具条 ✓。
 * 清理时机也选**一定会发生**的动作：每次挂载新面板、以及每次把工具条摆到外侧时（后者很频繁 ✓）。
 */
const livePanes = new Map<number, HTMLElement>()
function sweepOrphanBodyToolbars(): void {
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('.ijipu-score-toolbar[data-ijipu-pane]'))) {
    const id = Number(el.dataset.ijipuPane)
    const owner = Number.isFinite(id) ? livePanes.get(id) : undefined
    if (!owner || !owner.isConnected) el.remove()
  }
}

export function mountScorePane(host: ScorePaneHost): ScorePaneHandle {
  /**
   * adj794e：**面板唯一 id** —— 外侧落位时工具条会被挂到 `document.body`（adj793c），
   * 而 `destroy()` 里看不到内层作用域里创建的工具栏元素（`paint()` 内的局部变量 ✗）⇒
   * 给每个面板一个 id，标记到工具条上，销毁时按 id 精确清掉（不误伤别的面板）。
   */
  const paneId = ++paneSeq
  // ⚠ 先把 `container` 解构出来，再登记（否则 TS 报"用在声明之前"）
  const { plugin, container } = host
  livePanes.set(paneId, container)
  // adj794f：挂载时顺手清理 body 上的孤儿工具条（历史版本残留/异常销毁路径都会留下它们）
  sweepOrphanBodyToolbars()
  let stopPlay: (() => void) | null = null
  let rafId = 0
  let rafPending = false
  // —— 面板级状态（跨重画保持）——
  let paneMode: ViewMode = host.mode ?? 'score'
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
    /**
   * adj725b：**"还没量到内容盒"时挂着的 ResizeObserver**。
   * 声明在 `paint()` 之外：重画与 `destroy()` 都要能一次性断掉它们（旧 svg 已经被丢弃）。
   */
  const cropObservers = new Set<ResizeObserver>()
  /**
   * adj871：**整页模式的尺寸观察器**（容器进渲染树 / 分栏宽度变化 ⇒ 重算一次拟合）。
   * 与 `cropObservers` 同理声明在 `paint()` 之外：重画与 `destroy()` 都要能干净断掉。
   */
  let pageFitObserver: ResizeObserver | null = null
  /**
   * adj871：**窗口尺寸变化的落点** —— 指向"当前这一版 `paint()`"里的尺寸重算函数
   * （`paint()` 每次重建 DOM ⇒ 闭包必须能跨重画指向新的容器与 svg）。
   * `destroy()` 里置空，免得销毁后还被一次 `resize` 摸到已经丢弃的 DOM。
   */
  let recomputeFit: (() => void) | null = null
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
      /**
       * adj791（用户诊断里祖先链出现 **`el-pre`**）：代码块外面那层 **`<pre>`** 很可能就是真正的裁剪层
       * （`<pre>` 默认 `overflow: auto` ⇒ 被上面的"滚动容器绝不动"规则挡下 ⇒ 永远放不开 ⇒ 工具条被裁 ✗）。
       *
       * 但这个 `<pre>` **只包着我们这一块**（`querySelector('.ijipu-score')` 命中它自己 ✓）——
       * 它的内容是按块尺寸渲染的，不需要滚动 ⇒ 放开它的 `overflow` 是**安全的**（不影响编辑器滚动：
       * 真正的滚动容器在更外层 `.cm-scroller` / `.markdown-preview-view`，那些仍然不动）。
       */
      const isOurPre = el.tagName === 'PRE' && el.querySelector('.ijipu-score') !== null
      const canTouch = isCmLayer || isOurs || isOurPre
      if (clips) {
        // 不动它的理由（为空 = 该放开）——写成变量而不是嵌套三元，免得模板字符串里套引号
        const whyNot = (scrollByDesign && !isOurPre) ? '是滚动容器' : canTouch ? '' : '是宿主骨架'
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
       * adj751（用户第三轮报「很顽固呀，工具条还是没有显示」，诊断里**命中测试命中的是 `div.cm-line`**）：
       *
       * 命中测试是唯一"用眼睛量"的判据 —— 它说"那个点上最上层不是我们" ⇒ 无论是因为
       * 哪一层裁剪（`overflow`/`contain`/`clip-path`/mask/滚动容器…我们不可能穷举宿主的机制），
       * 都说明"浮到块外侧"这条路在**这个宿主**里走不通。
       *
       * 于是给一个**自愈兜底**：命中失败就把工具条**贴回块内**（左上角内侧）——
       * 块内必然不会被任何祖先裁掉（祖先的裁剪框至少包含块本身）。
       * 下一帧再量一次：这次命中测试必须命中工具条自身，否则把结论写进诊断（供继续追）。
       */
      const hitSelf = hit !== null && toolbarEl.contains(hit)
      const wasInside = toolbarEl.hasClass('ijipu-toolbar-inside')
      /**
       * adj755（用户要求：「PC 端预览区，**阅读视图**下工具条在预览区外部左上角，**编辑模式**下在内部左上角，
       * 这个要规范为**都在外部左上角**」）：
       *
       * 原因是我 `adj751` 的"贴回块内"兜底**是粘住的**（加类后从不摘除）⇒ 某个面板只要历史上失败过一次，
       * 之后**永远**贴在里面（阅读视图没失败过 ⇒ 一直在外面）—— 这正是用户看到的不一致。
       *
       * 现在改成**每次显示都重新判定**，并且失败时先走"逐级放宽"这一梯，实在不行才临时贴回块内：
       *  ① 本帧测量若命中自身 ⇒ **移除**贴内类（恢复"外部左上角"，即规范）；
       *  ② 未命中 ⇒ 先放开**上游**（`.cm-editor` 以上直到 `.workspace-leaf-content`）会裁剪的 `contain`
       *     （`paint`/`strict`/`content` 都会裁；step 记录进诊断），下一帧复测；
       *  ③ 复测仍不命中 ⇒ 才加贴内类（临时兜底，且下次显示会重新判定 ⇒ 一旦不再需要就回外部）。
       */
      if (hitSelf && wasInside) {
        toolbarEl.removeClass('ijipu-toolbar-inside')
        plugin.lastToolbarInfo = `${plugin.lastToolbarInfo ?? ''}｜**恢复外部左上角**（本次命中自身，说明不再被裁）`
      }
      if (!hitSelf && inViewport && !wasInside) {
        const relaxed = relaxUpstreamClipping()
        window.requestAnimationFrame(() => {
          const r2 = toolbarEl.getBoundingClientRect()
          const h2 = document.elementFromPoint(Math.round(r2.left + r2.width / 2), Math.round(r2.top + r2.height / 2))
          const ok2 = h2 !== null && toolbarEl.contains(h2)
          if (ok2) {
            plugin.lastToolbarInfo =
              `${plugin.lastToolbarInfo ?? ''}｜**放宽上游裁剪**后命中自身 ✓${relaxed.length > 0 ? `（${relaxed.join('、')}）` : ''}`
            return
          }
          /**
           * adj787（用户要求）：「工具条**还是要求显示在外部**」——这条"临时贴回块内"的兜底**取消**：
           * 允许遮挡其它元素（已能自动隐藏 + 点击显隐），只有"外侧"一种落位。若某环境下真的看不见，
           * 诊断里会留下上面的命中测试事实，便于定位（而不是悄悄换成一个用户不要的位置）。
           */
          plugin.lastToolbarInfo =
            `${plugin.lastToolbarInfo ?? ''}｜放宽上游${relaxed.length > 0 ? `（${relaxed.join('、')}）` : ''}后仍未命中 ⇒ 仍保持**外侧**（用户口径；不贴回块内）`
        })
      }
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

  /**
   * adj755：**放宽上游裁剪**（命中测试失败时的一梯，比"贴回块内"更尊重用户的"都在外部"要求）。
   *
   * 只处理 `.cm-editor` **以上**、`.workspace-leaf-content`（含）以下的祖先 ——
   * `contain: paint/strict/content` 都会裁剪，而这些层（CM6 与 leaf 内容容器）不是界面骨架的关键，
   * 降级为 `layout style` 只损失一点包含优化。**记录改过谁**并写进诊断，便于下一轮回溯。
   * ⚠ 不动 `.view-content` 以上的层（那是宿主的滚动/布局骨架）。
   */
  const relaxUpstreamClipping = (): string[] => {
    const done: string[] = []
    let el: HTMLElement | null = container.closest('.cm-editor')?.parentElement ?? container.parentElement
    let depth = 0
    while (el && depth < 6) {
      depth += 1
      const isLeafContent = el.hasClass('workspace-leaf-content')
      const cs = window.getComputedStyle(el)
      if (/paint|strict|content/.test(cs.contain)) {
        if (!el.hasClass('ijipu-cm-nocontain')) el.addClass('ijipu-cm-nocontain')
        noClipEls.add(el)
        const name = el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') || el.tagName.toLowerCase()
        done.push(`${name}:contain=${cs.contain}→layout style`)
      }
      if (isLeafContent) break
      el = el.parentElement
    }
    return done
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

  /**
   * adj871：**窗口尺寸变化 ⇒ 重算一次整页拟合**（整页模式要"整页进视界"，视界变了就得重算）。
   *
   * ⚠ 这里**只监听 `resize`**：滚动时容器顶边一直在变，跟着滚动实时重算会让页面尺寸
   * "一跳一跳"（用户明确否掉 ✗）。容器**自身**的尺寸变化（分栏拖动 / 刚进渲染树）另由
   * `paint()` 末尾挂的 `ResizeObserver` 管 —— 两条路都走同一个落点。
   */
  const onWindowResize = (): void => recomputeFit?.()
  window.addEventListener('resize', onWindowResize)

  /** 全量重画（工具条 + 谱面 + 辅助虚线）；拖拽期间按帧节流 */
  const paint = (): void => {
    stopRuntime()
    // adj725b：上一轮挂的补量观察器盯着的是即将被丢弃的 svg ⇒ 先全部断掉
    for (const ro of cropObservers) ro.disconnect()
    cropObservers.clear()
    // adj871：整页拟合的观察器同理（它盯的是即将被丢弃的 `.ijipu-svgs`）
    pageFitObserver?.disconnect()
    pageFitObserver = null
    container.empty()
    container.addClass('ijipu-score')
    /**
     * adj785（用户要求，推翻 adj782 的"块内预留空带"）：
     * 「不管是嵌入 jps 文件，还是 jps 代码块，预览区前面有个空白区域…这是不对的，
     *  **jps 代码块或嵌入块应与其它块一样，像正常的块一样布局排列**，块周边间距应与其它块一样的标准，
     *  而**工具条应是浮在其它元素上方的**，工具条显示时可能会对其它元素有遮挡」。
     *
     * ⇒ 取消"预留空带"，回到**浮在块外正上方**（允许与相邻块/上一行重叠，这是用户明确接受的口径）。
     * 于是块本身的排版与间距完全回到普通块的标准（不再有额外的 30px 空带）。
     */

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
// adj794e：打上面板 id —— 工具条可能被移到 document.body（外侧落位），销毁时据此精确清理
toolbar.dataset.ijipuPane = String(paneId)

    /**
     * adj862（T-5 定稿，用户口径）：「**工具条只放高频，固定 5 位**：试听 / 排版 / 谱面·页面 /
     * 编辑 / ⋯ 更多；**设置等低频项移入菜单**」。
     *
     * `menuOnly` 就是这些**只进菜单**的按钮的容器：它们照旧按原样创建（`ConfigDialog` 那段
     * 40 行逻辑、格式化、"在应用中打开"、"打开谱面文件"全部**一行不改**），但**不挂进工具条 DOM**
     * —— 由「⋯ 更多」菜单的菜单项用 `.click()` 触发同一批监听器（零重复实现）。
     *
     * 为什么用"游离容器"而不是"建完再 `remove()`"：`remove()` 之后 DOM 会被重建，
     * 而这里连一次插入都不做 ⇒ 「工具条 = 5 位」是**结构事实**（冒烟可对源码计数验证），
     * 不依赖 CSS 藏、也不依赖执行顺序。游离元素上的 `.click()` 照常派发事件（元素无需在文档里）。
     */
    const menuOnly = createDiv({ cls: 'ijipu-menu-only' })
    /** 只进菜单的按钮（按宿主能力赋值；仍是原来那些按钮对象，处理器完全复用） */
    let fmtBtn: HTMLElement | null = null
    let cfgBtn: HTMLElement | null = null
    let appOpenBtn: HTMLElement | null = null
    let linkBtn: HTMLElement | null = null
    /** 嵌入模式下「打开谱面文件」的目标文件名（菜单项标题与提示据此显示） */
    let embedLinkTitle: string | null = null

    /**
     * adj862：**平台策略一处给出**（`scoreMenu.ts` 的 `toolbarPolicy`）——
     * 移动端：触控目标 ≥44px、**常驻不自动收起**、无 hover 依赖、无右键依赖；
     * 桌面：24px、3 秒自动收起、给右键菜单。渲染端只消费，不再各自 `if (Platform.isMobile)` 散判。
     */
    const policy = toolbarPolicy(Platform.isMobile)
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
    /**
     * adj761（用户报「工具条还在预览区内，而且鼠标移动时会**闪动**」，诊断里 `opacity=0` + 位置在块内）：
     *
     * 根因：`adj755` 把落位改成"**每次显示都重新判定**"，而 `revealToolbar(true)` 又被
     * **每一次 `pointermove`** 调用 ⇒ 于是一次移动里做了一整套重量级动作
     * （打宿主类 + 逐层放宽 `contain` + 命中测试 + 内侧兜底）⇒ 工具条在"外侧 / 内侧"之间来回翻
     * ⇒ 观感就是闪动；而这个宿主的外侧判定会失败 ⇒ 最终又停在内侧。
     *
     * 改成两条：
     *  · **每个面板只判定一次落位**（先试外侧 ⇒ 不行才内侧），此后固定不动 ⇒ 不闪；
     *  · 鼠标移动只做"确认显示 + 取消收起"这件轻量事（重量级动作只在**首次**或**重画后**做一次）。
     */
    let placementDecided = false
    let placementInside = false
    /** 落位判定所针对的那个工具栏元素（CM6 换掉块容器后元素会变 ⇒ 需要重新判定） */
    let placementEl: HTMLElement | null = null

    /**
     * adj769（用户报「编辑视图下工具条**又不显示了**」）——**铁律·同一个 bug 修到第三次就换"量法"**：
     * 前两轮我都在"落位判定"的细节里补分支，这轮改成从**可见性**倒推：
     *
     * ① **先显示，再落位**：`is-revealed` 必须在任何重量级动作**之前**加上 ——
     *    `adj761` 把"打宿主类 + 逐层放宽 `contain` + 两层 rAF 测量"放在了它前面，
     *    这条路径一旦抛错（或踩到已被 CM6 换掉的旧元素），**显示这一步就永远不执行** ⇒ 工具条不显示；
     * ② **取活元素**：每次显示都从容器里现查 `.ijipu-score-toolbar`（拿不到才回退到闭包里的那个），
     *    因为实时预览会**重建块容器**，闭包里的旧元素早已脱离文档 ⇒ 类加在旧元素上 = 看不见；
     * ③ **判定绝不外抛**：整段 `try/catch`，并把异常写进设置页诊断（下次一眼看出是不是它）；
     * ④ **元素换了就重新判定**（不再是"一辈子只判一次"）——同一元素则沿用上次结论 ⇒ 既不抖也不瞎。
     */
    const liveToolbar = (): HTMLElement => container.querySelector<HTMLElement>('.ijipu-score-toolbar') ?? toolbar

    const decidePlacement = (el: HTMLElement): void => {
      if (placementDecided && placementEl === el) return
      placementDecided = true
      placementEl = el
      try {
        // 先确认宿主块被标了类（宿主容器会被 CM6 换掉，类会丢）
        markHostWidget()
        // 逐层放开会裁剪的祖先（滚动容器除外），并把实测快照记进诊断
        const facts = exemptClippingAncestors()
        // 外侧先试：下一帧量"在工具条中心那个点上是不是我们自己"
        window.requestAnimationFrame(() => {
          try {
            const r = el.getBoundingClientRect()
            const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
            if (hit !== null && el.contains(hit)) {
              placementInside = false
              noteToolbar('落位判定：**外侧**（命中自身）', facts, el)
              return
            }
            // 外侧被裁 ⇒ 再放宽上游一层并复测一次，仍不行才固定为"内侧"
            const relaxed = relaxUpstreamClipping()
            window.requestAnimationFrame(() => {
              try {
                const r2 = el.getBoundingClientRect()
                const h2 = document.elementFromPoint(Math.round(r2.left + r2.width / 2), Math.round(r2.top + r2.height / 2))
                if (h2 !== null && el.contains(h2)) {
                  placementInside = false
                  noteToolbar('落位判定：**外侧**（放宽上游后命中）', [...facts, ...relaxed], el)
                  return
                }
                /**
                 * adj787（用户要求）：「工具条**还是要求显示在外部**」——允许它遮挡其它元素
                 * （因为已经能自动隐藏、也能点击预览区显/隐，遮挡不再是问题）。
                 * 所以这里**不再贴回块内**：即使外侧那个点没命中自己（被裁剪/被别的元素盖住），
                 * 也保持"外侧"落位，只把事实记进诊断，方便日后排查"看不见"的情况。
                 */
                placementInside = false
                noteToolbar(
                  '落位：保持**外侧**（用户口径：允许遮挡其它元素，不贴回块内）',
                  [...facts, ...relaxed],
                  el,
                )
              } catch (err) {
                plugin.lastToolbarInfo = `${plugin.lastToolbarInfo ?? ''}｜落位复测异常：${String(err)}`
              }
            })
          } catch (err) {
            plugin.lastToolbarInfo = `${plugin.lastToolbarInfo ?? ''}｜落位测量异常：${String(err)}`
          }
        })
      } catch (err) {
        plugin.lastToolbarInfo = `${plugin.lastToolbarInfo ?? ''}｜落位判定异常（已跳过，工具条照常显示）：${String(err)}`
      }
    }

    /**
     * adj793（用户第四次报「编辑模式不显示工具条」，诊断：位置正确在外侧、无裁剪层、
     * 但命中测试命中的是 `div.cm-line`）：
     *
     * 说明它**被相邻行压在了下面**（CM6 的 `.cm-line` 与我们的块是同级兄弟，而工具条虽然在块外，
     * 仍属于该块的包含块/堆叠上下文 ⇒ 相邻行后绘制 ⇒ 盖住它 ✗）。前两轮试过 z-index 与放开
     * `overflow`，都不足以跨过这层关系 ✗。
     *
     * 现在改用**绕开这两件事**的做法：外侧落位时用 `position: fixed`，坐标取块的实测矩形 ——
     * `fixed` 不参与兄弟间的层叠（也不会被祖先 `overflow`/`contain` 裁掉）⇒ 一定画在最上层。
     * 代价是要跟随滚动/尺寸变化，所以：
     *  · 显示期间监听 `scroll`/`resize`（passive）实时跟随；收起时摘掉内联坐标与监听；
     *  · 只在我们自己的面板上做（其它宿主保持原样，避免影响已正常的部分）。
     */
    const TOOLBAR_GAP = 2
    /**
     * adj797：**是否因为"块不在视界里"而隐藏过** —— 用它区分两种情况：
     *  · 用户主动收起（点预览区）⇒ 滚动回来**不该**自动弹出；
     *  · 因块离开视界而隐藏 ⇒ 块**回到视界时要重新显示**（用户口径："块出现在视界后才显示"）。
     */
    let hiddenByViewport = false
    /**
     * adj797：**块是否真的在视口里**（有尺寸、且与视口相交）。
     * 外侧落位靠它决定"该不该显示"：块还没排版（0×0）或滚出视口时，不该有一条工具条飘在那里 ✗。
     */
    const containerInViewport = (): boolean => {
      const r = container.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return false
      const vw = window.innerWidth || 0
      const vh = window.innerHeight || 0
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
    }
    /**
     * adj793b（用户第五次反馈 + 截图：「能显示了，但**位置不对**：在预览区内部、也没在左上角」）：
     *
     * 这两个现象合起来只有一个解释 —— **`position: fixed` 被祖先"降级"了**：
     * 只要有祖先带 `transform` / `filter` / `perspective` / `will-change: transform` / `contain: paint…`，
     * `fixed` 就**以那个祖先为参照系**（不再以视口为准）✗。于是我按**视口**算出来的坐标
     * （例如 left=348、top=343）会被解释成"**相对块内偏移**" ⇒ 右移 348、下移 343
     * ⇒ 正好是用户看到的"跑到内部、且不在左上角" ✓✓。
     *
     * 修法：先找出**真正的参照系**（最近的"会成为 fixed 包含块"的祖先），再按它算坐标：
     * `left = 块.left − 参照系.left`、`top = 块.top − 工具条高 − 2 − 参照系.top`。
     * 同时**下一帧与 50ms 后各重算一次**（首帧布局常未稳定，这也是坐标偏掉的一半原因）。
     */
    /**
     * adj793c：挂到 `document.body` 之后，**不再需要**"找 fixed 参照系"那套（body 下没有 transform 祖先）
     * ⇒ 该辅助函数已删除（上一版用它算坐标；现在坐标就是视口坐标）。
     */
    const positionOutsideFixed = (el: HTMLElement): void => {
      // adj794f：每次摆到外侧都顺手清一次孤儿（不依赖销毁回调）
      sweepOrphanBodyToolbars()
      /**
       * adj797（用户实测）：「嵌入 jps 文件的工具条**在嵌入块还没在视界里就显示了**，
       * 感觉凭空多出一条；应该**块出现在视界后才显示在块左上角**，没在视界里就不要显示。
       * 检查一下 jps 代码块是否也有这个问题」。
       *
       * 真因：外侧落位是 `fixed` + 按块矩形算坐标 ⇒ 块**还没排版/不在视口**时矩形是 (0,0,0×0)，
       * 工具条就被摆到 (0,-36) 这种位置 ⇒ 看着就是"凭空多出的一条" ✗。
       * 修法：**块不在视口（或还没尺寸）就立刻隐藏**、不摆位置；进入视口时再显示。
       * 代码块与嵌入共用本函数 ⇒ 两处一起修好 ✓。
       */
      if (!containerInViewport()) {
        hiddenByViewport = true
        revealToolbar(false)
        /**
         * adj797b（用户报告的决定性一行：`id=7 … userHidden=**N** visibility=visible opacity=1` ✗）：
         *
         * 手机端 CSS 会**强制常显**（`.is-mobile .ijipu-score-toolbar { opacity: 1 }`）⇒
         * 光调 `revealToolbar(false)`（只摘 `is-revealed`）**挡不住它** ✗ ⇒ 于是"块还没进视界，
         * 工具条却先显示 3 秒"（3 秒后首开定时器补上 `is-user-hidden` 才消失 ✓✓）。
         * 所以这里必须**同时**打上"主动隐藏"标记 —— 与点击收起、首开收起同一口径（且只在手机端需要）。
         */
        if (Platform.isMobile) liveToolbar().addClass('is-user-hidden')
        return
      }
      // 又回到视界里了 ⇒ 重新显示（用户口径：块出现在视界后才显示）
      if (hiddenByViewport) hiddenByViewport = false
      /**
       * adj793c（用户：坐标已正确、`position=fixed` 已生效，但命中测试仍落到 `div.cm-line` ✗）：
       *
       * 结论：`fixed` 也**跨不出祖先的层叠上下文** —— z-index 只在**同一个**上下文里比大小，
       * 而工具条仍在块（`.cm-embed-block` / `.ijipu-score`）的上下文里 ⇒ 相邻 `.cm-line` 只要落在
       * 更高的上下文，就照样盖住它 ✗。
       *
       * 唯一可靠的做法：**把工具条挂到 `document.body`**（脱离块的整棵子树）⇒ 不受任何祖先的
       * 裁剪与层叠约束 ⇒ 一定画在最上层；此时坐标也用**视口**坐标（body 下没有 transform 祖先）。
       * 收起时再挂回容器（见 `clearOutsideFixed`），保持 DOM 与"下次显示"的干净。
       */
      if (el.parentElement !== document.body) document.body.appendChild(el)
      /**
       * adj798：搬到 body 就**丢了祖先上下文** ⇒ `.is-mobile` / `.ijipu-embedded` 那两条控制
       * **按钮尺寸**的规则不再命中 ✗ ⇒ "点击显示的"与"滚动中的"工具栏大小不一致（用户实测 ✓）。
       * 这里把上下文标记搬到工具条自己身上，CSS 里对这两个标记镜像同样的尺寸变量。
       */
      el.toggleClass('ijipu-ported-mobile', Platform.isMobile)
      el.toggleClass('ijipu-ported-embedded', container.closest('.ijipu-embedded') !== null)
      const host = container.getBoundingClientRect()
      const h = el.getBoundingClientRect().height || 28
      /**
       * adj799（社区审核 **Error**）：`obsidianmd/no-static-styles-assignment` 不允许直接写内联样式 ✗
       * （我上一版在这里用了 `el.style.setProperty(…)` ×4 ⇒ 审核判 Failed ✓）。
       * 按规则给的三条出路（CSS 类 / `setCssProps` / `setCssStyles`）改成：
       *  · **坐标用 CSS 自定义属性**（`setCssProps` 是 Obsidian 认可的动态值写法 ✓）；
       *  · **定位与层级交给 CSS 类** `.ijipu-ported`（见 styles.css）✓。
       */
      el.addClass('ijipu-ported')
      el.setCssProps({
        '--ijipu-port-x': `${Math.round(host.left)}px`,
        '--ijipu-port-y': `${Math.round(host.top - h - TOOLBAR_GAP)}px`,
      })
    }
    const clearOutsideFixed = (el: HTMLElement): void => {
      // adj793c：挂到 body 的工具栏要**挂回容器**（否则收起后它仍留在 body 上，下次显示会错位/堆积）
      if (el.parentElement === document.body && container.isConnected) container.appendChild(el)
      // adj798：搬回来就摘掉"移植上下文"标记（回到容器里，祖先上下文重新生效）
      el.removeClass('ijipu-ported-mobile')
      el.removeClass('ijipu-ported-embedded')
      // adj799：同样走类 + 自定义属性（不再碰内联样式 ✗）
      el.removeClass('ijipu-ported')
      el.setCssProps({ '--ijipu-port-x': '', '--ijipu-port-y': '' })
    }
    let followToolbar: (() => void) | null = null

    const revealToolbar = (on: boolean): void => {
      const el = liveToolbar()
      // adj777：把"显式状态"与**所有**显隐入口同步（hover / focus / 点击都走这里）——
      // 否则状态会漂移，点击切换就可能出现"点一下没反应"。
      toolbarShown = on
      // ① 先显示：这一步绝不依赖下面的落位判定
      el.toggleClass('is-revealed', on)
      // adj773：显示时清掉"用户主动收起"的标记（它用来压过"移动端常显"那条 CSS 规则）
      if (on) el.removeClass('is-user-hidden')
      if (!on) {
        // adj793：收起时清掉"外侧 fixed"留下的内联坐标，并停止跟随滚动
        if (followToolbar) {
          window.removeEventListener('scroll', followToolbar, true)
          window.removeEventListener('resize', followToolbar)
          followToolbar = null
        }
        clearOutsideFixed(el)
        return
      }
      // ② 元素换了 ⇒ 清掉旧的"贴内"痕迹并重新判定；同元素则沿用上次结论
      if (placementEl !== null && placementEl !== el) {
        placementDecided = false
        placementInside = false
        el.removeClass('ijipu-toolbar-inside')
      }
      if (placementInside && !el.hasClass('ijipu-toolbar-inside')) el.addClass('ijipu-toolbar-inside')
      /**
       * adj785：取消 adj782/adj784 的"块内空带"后，这里恢复**统一走落位判定**（浮在块外正上方，
       * 被裁才贴回块内）。工具条现在允许遮挡其它元素（用户明确接受），所以外侧优先即可。
       */
      decidePlacement(el)
      /**
       * adj793：外侧落位 ⇒ 用 `position: fixed` 贴到块的实测上方（绕开"被相邻 CM6 行盖住"与裁剪）。
       * 同时挂上跟随监听（滚动/尺寸变化时重算），收起时由 `revealToolbar(false)` 统一清理。
       */
      positionOutsideFixed(el)
      // 首帧布局常未稳定（字体/换行/CM6 重排）⇒ 下一帧与 50ms 后各重算一次（adj793b）
      window.requestAnimationFrame(() => {
        if (toolbarShown) positionOutsideFixed(liveToolbar())
      })
      window.setTimeout(() => {
        if (toolbarShown) positionOutsideFixed(liveToolbar())
      }, 50)
      if (!followToolbar) {
        followToolbar = (): void => {
          // adj797c：滚动/尺寸变化的唯一处理 —— 交给状态机（进视界⇒显示+倒计时；离开⇒隐藏）
          syncToolbarVisibility()
          if (toolbarShown) positionOutsideFixed(liveToolbar())
        }
        window.addEventListener('scroll', followToolbar, true)
        window.addEventListener('resize', followToolbar)
      }
      /**
       * adj792（用户连报两次"编辑模式不显示"，而两次诊断都写着 `视口内=否`、y=1890 ✗）：
       *
       * 真因是**诊断本身不新鲜** —— `decidePlacement()` 每个元素只判定一次（adj761 防闪动），
       * 后续每次显示**不再写记录** ⇒ "最近一次"留在**别的实例**（例如滚到很下面的阅读视图面板）上，
       * 于是你贴给我的永远不是"你正在看的那个块" ✗。
       *
       * 现在**每次显示都刷新一条简短记录**：视口内？命中自身？矩形在哪 ——
       * 这三项就足以判断"它到底有没有画出来、被谁挡/裁"，而且一定是**你刚操作的那个面板**。
       */
      try {
        const r = el.getBoundingClientRect()
        const vw = window.innerWidth || 0
        const vh = window.innerHeight || 0
        const inVp = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
        const selfHit = hit !== null && el.contains(hit)
        const hitLabel = hit === null ? '（该点无元素）' : `${hit.tagName.toLowerCase()}${hit.className ? '.' + String(hit.className).split(/\s+/).slice(0, 2).join('.') : ''}`
        noteToolbar(
          `**本次显示**：视口内=${inVp ? '是' : '否'}｜命中自身=${selfHit ? '是' : `否（该点最上层是 ${hitLabel}）`}｜` +
            `工具条 ${Math.round(r.width)}×${Math.round(r.height)} @(${Math.round(r.left)},${Math.round(r.top)})`,
          [],
          el,
        )
      } catch {
        /* 诊断失败不影响显示 */
      }
    }
    /**
     * adj753（用户第四轮「工具条还是没有显示」，而诊断显示它 `命中自身 ✓ / opacity=1 / 视口内=是`）：
     *
     * 根因是**交互**而不是绘制 —— 工具条浮在谱面块**外侧上方**，而"显示"由**指针在谱面容器内移动**
     * 触发；用户把指针往上移去点它时，指针已离开容器 ⇒ 120ms 后它自己收起来 ⇒
     * 观感就是"根本没出现 / 抓不住"。三处修（都属于这个交互缺陷本身）：
     *  ① 收起判定加上"**指针是否正悬在工具条上**"（`:hover`）—— 工具条当然算"还在用"；
     *  ② 收起**延迟 240ms** 并在到期时复查，给"从谱面移到工具条"这段路留出时间；
     *  ③ 工具条自身 `pointerenter` 保持显示、`pointerleave` 再走同一套判定。
     */
    let hideTimer = 0
    const cancelHide = (): void => {
      if (hideTimer !== 0) window.clearTimeout(hideTimer)
      hideTimer = 0
    }
    /** adj769：一律用**活元素**判定（实时预览会重建块容器，闭包里的旧元素已脱离文档） */
    const hoveringToolbar = (): boolean => {
      try {
        return liveToolbar().matches(':hover')
      } catch {
        return false
      }
    }
    const focusInToolbar = (): boolean => liveToolbar().contains(document.activeElement)
    const scheduleHide = (): void => {
      cancelHide()
      hideTimer = window.setTimeout(() => {
        hideTimer = 0
        if (hoveringToolbar()) return
        if (focusInToolbar()) return
        revealToolbar(false)
      }, 240)
    }
    /**
     * adj785（用户要求）：「**PC 端鼠标移动时马上显示工具条的操作也不要有**，就通过点击预览区显/隐工具条」。
     *
     * 所以整套"悬停驱动显隐"**取消**（原行为：指针在容器内移动 ⇒ 显示；移出 ⇒ 240ms 后收起）。
     * 现在的口径只有三种，彼此不打架：
     *  · **首开**：显示一次，3 秒后自动隐藏（用户要求，见本函数末尾）；
     *  · **点击预览区**：显/隐切换（唯一的手动开关，各端一致）；
     *  · **键盘**：焦点进入工具条或容器内敲键时显示（纯键盘用户的入口）。
     * （`scheduleHide`/`cancelHide`/`hoveringToolbar` 仍留给"键盘/焦点"路径与点击路径使用。）
     */
    /**
     * 键盘可达性的**真正入口**：工具条隐藏时 `display:none` ⇒ **不可聚焦**，`focusin` 等不到 Tab。
     * 故在容器层面监听 `keydown`：只要焦点在谱面容器内、用户敲了键，就把工具条显示出来
     * （此后 Tab 便能进入其中的按钮）。这是纯键盘用户的唯一入口。
     */
    const onKeyDown = (): void => revealToolbar(true)
    container.addEventListener('keydown', onKeyDown)
    // 焦点进出工具条时同步（指针用户用鼠标移入/移出时的兜底）
    // adj769：监听挂在**容器**上（事件冒泡），这样 CM6 换掉工具条元素后依然有效
    container.addEventListener('focusin', (e) => {
      if (liveToolbar().contains(e.target as Node)) revealToolbar(true)
    })
    container.addEventListener('focusout', () => {
      // adj781：触摸交互下不要因失焦自动收起（手指点开工具条时会先失焦 ⇒ 会"刚显示就隐藏"）
      if (touchInteraction) return
      /**
       * adj785：悬停那套已取消，但"键盘/焦点离开工具条后收起"仍然需要 ——
       * 于是这里改用 `scheduleHide()`（延迟复查、且复查时若焦点又回到工具条内就不收）。
       */
      if (!focusInToolbar()) scheduleHide()
    })

    /**
     * adj781（用户实测，手机端代码块）：「首进显示工具条，点击预览区隐藏后，**再点击，显示的工具条
     * 显示后又马上隐藏**」（阅读/编辑模式都有）。
     *
     * 真因：**触摸设备上 Obsidian 会合成鼠标事件**（`pointerover`/`pointerout`/`pointerleave`）——
     * 我的点击切换把工具条显出来之后，紧随其后的合成"移出"又触发了**悬停那套自动收起**
     * （`scheduleHide()`，120ms 延迟 + 240ms 复查）⇒ 表现就是"显示后马上又消失" ✗。
     *
     * 触摸根本没有"指针移出"的语义（手指抬起就是结束）⇒ 这里记下**最近一次交互是不是触摸**，
     * 是的话**一律不自动收起**，显隐只由点击切换决定。鼠标交互（`mousedown`/`pointerdown` 非 touch）
     * 会把它复位 ⇒ 桌面端悬停那套行为完全不变。
     */
    let touchInteraction = Platform.isMobile
    container.addEventListener(
      'pointerdown',
      (e) => {
        touchInteraction = e.pointerType === 'touch'
        /**
         * adj795（手机端"在谱面图上上下滑 ⇒ 不能滚动"，两轮 CSS 加固都没解决）：
         * **不再盲改** —— 这里记一条"滚动链路"诊断，用户只要在谱面上碰一下，
         * 就能看出到底是谁在吃手势 / 有没有东西可滚：
         *  · 本容器与它最近的**可滚动祖先**的 `scrollHeight/clientHeight`（能不能滚）、
         *  · 沿途各层的 `overflow` 与 `touch-action`（谁把纵向手势禁掉了）。
         * 结果挂进「点击预览区显/隐工具条」那块诊断（用户已经在用它、且一键可复制）。
         */
        if (e.pointerType === 'touch') {
          try {
            const chain: string[] = []
            let el: HTMLElement | null = container
            let depth = 0
            let scroller: HTMLElement | null = null
            while (el && depth < 12) {
              depth += 1
              const cs = window.getComputedStyle(el)
              const canScroll = el.scrollHeight > el.clientHeight + 1
              const isScroller = /auto|scroll/.test(cs.overflowY)
              if (!scroller && isScroller && canScroll) scroller = el
              const name =
                (el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') || el.tagName.toLowerCase()
              chain.push(
                `${name}[overflowY=${cs.overflowY} touchAction=${cs.touchAction} scroll=${el.scrollHeight}/${el.clientHeight}${canScroll ? ' ⬍可滚' : ''}]`,
              )
              el = el.parentElement
            }
            const s = scroller as HTMLElement | null
            plugin.lastToolbarClick =
              `[滚动链路] 视口=${window.innerWidth}×${window.innerHeight}｜` +
              `最近可滚祖先=${s ? `${(s.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.') || s.tagName.toLowerCase()}` : '（没找到！）'}｜` +
              chain.join(' → ')
          } catch {
            /* 诊断失败不影响交互 */
          }
        }
      },
      true,
    )

    /**
     * adj773 / adj777（用户实测：「手机端点击预览区**无显/隐**工具条」「PC 与手机端在 `![[x.jps]]` 嵌入的
     * **编辑模式**下点击也无显/隐」）：
     *
     * 原来显隐**只由 hover 驱动**（`pointermove`/`pointerleave`），手机端没有 hover ⇒ 用户看不到工具条；
     * adj773 补了点击切换，但判据是"有没有 `is-revealed` 类"，而**手机端工具条靠 CSS 默认常显**
     * （`.is-mobile .ijipu-score-toolbar { opacity: 1; visibility: visible }`）时**并没有**这个类
     * ⇒ 第一下点击走的是"显示"分支（**屏幕上毫无变化** ✗），要点**第二下**才收起 —— 感受就是"点了没反应"。
     *
     * adj777 改成**显式状态** `toolbarShown`（初值按平台给：手机端=已在显示、桌面端=未显示），
     * 每次点击**翻转**它 ⇒ 点一下必有可见变化。另外：
     *  · 用**捕获阶段**监听：别处（如 `a.jp-link` 的处理器）`stopPropagation()` 拦不掉这次切换；
     *  · 点到**工具条自身** ⇒ 不翻转（否则点按钮会先把工具条收掉）；
     *  · 点到谱面内的**链接** ⇒ 不翻转（那次点击有自己的语义）；
     *  · 记一条**诊断**（`lastToolbarClick`，显示在设置页「说明」）—— 万一某平台仍不生效，
     *    用户能一眼看出"到底有没有收到这次点击、命中了什么元素"。
     */
    let toolbarShown = Platform.isMobile
    const onContainerClick = (e: MouseEvent): void => {
      /**
       * adj779b（用户发来的诊断写的是「命中=?」）：判据要从 `HTMLElement` 放宽到 `Element` ✗➜✓。
       *
       * 原因：谱面是 **SVG**，点在音符/小节线上时 `e.target` 是 `SVGElement`（不是 `HTMLElement`）⇒
       * 原来会被丢成 `null` ⇒ ① 诊断里只能看到 `命中=?`（没法定位）；② **"点到谱面内链接不切换"那条例外失效**
       * （SVG 里的 `<a class="jp-link">` 点一下会被当成普通点击、顺手把工具条收掉）。
       */
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('.ijipu-score-toolbar')) return
      if (target?.closest('a.jp-link')) return
      toolbarShown = !toolbarShown
      revealToolbar(toolbarShown)
      /**
       * 主动收起：只有**手机端**需要这个标记 —— 它的唯一用途是压过
       * `.is-mobile .ijipu-score-toolbar { opacity: 1 }` 那条"常显"规则。
       * 桌面端本来就有 `.ijipu-score-toolbar { opacity: 0 }`（默认隐藏）⇒ **不需要**这个类 ✗；
       * 而它一旦在桌面端被加上，就会出现"`is-revealed` 在、却 `opacity: 0` 且 `pointer-events: none`"
       * 的怪状态（用户实测的"编辑模式不显示工具条"诊断正是这个特征 ✗ —— 已按平台收紧，杜绝该状态）。
       */
      if (!toolbarShown && Platform.isMobile) liveToolbar().addClass('is-user-hidden')
      plugin.lastToolbarClick =
        `点击预览区 ⇒ ${toolbarShown ? '显示' : '隐藏'}工具条（平台=${Platform.isMobile ? '手机' : '桌面'}；` +
        `命中=${target?.tagName ?? '?'}${target?.className ? '.' + String(target.className).slice(0, 40) : ''}）`
    }
    // ⚠ 捕获阶段（第三个参数 true）：任何子元素的 stopPropagation 都拦不住这次切换
    container.addEventListener('click', onContainerClick, true)

    /**
     * adj785（用户要求 a）：「笔记中的预览区（嵌入 jps 文件或 jps 代码块）**首开时先显示一下工具条，
     * 3 秒后隐藏**，点击预览区可显/隐」。
     *
     * 于是这里在挂载时**显式显示一次**，并在 3 秒后自动收起（除非用户在这 3 秒里手动切换过、
     * 或焦点已经进了工具条 —— 那说明他正在用，不该被收走）。
     * 放在这一段（`toolbarShown` 声明之后）是为了避免 TDZ。
     */
    /**
     * adj797c（用户指出顺序反了）：「应该是**先判断是否有嵌入块/代码块在视界内**，再考虑工具显示 3 秒后隐藏…
     * 我的操作是在 3 秒隐藏前滚动到显示嵌入块的位置，结果还在显示的工具条**马上消失**了」。
     *
     * ⇒ 正确的状态机（**单一入口** `syncToolbarVisibility()`，挂载 / 滚动 / 尺寸变化都走它）：
     *  · **块不在视界**（或还没尺寸）⇒ 立即隐藏（不显示、也**不开始倒计时**）；
     *  · **块进入视界** ⇒ 显示，并**从这一刻**开始 3 秒倒计时（进视界前的时间不算 ✗）；
     *  · 用户**点击** ⇒ 手动显/隐（手动显示后不再自动收起，尊重用户意愿）；
     *  · 用 `hiddenByViewport` 区分"因离开视界隐藏"（回来要重新显示）与"用户主动收起"（回来不自动弹）。
     */
    let autoHideTimer = 0
    const clearAutoHide = (): void => {
      if (autoHideTimer !== 0) window.clearTimeout(autoHideTimer)
      autoHideTimer = 0
    }
    const startAutoHide = (): void => {
      /**
       * adj862（T-5 移动端口径）：**手机端常驻、不自动收起**（`policy.autoHideMs === 0`）——
       * 触屏没有 hover，工具条一旦自己消失，用户得先点一下预览区才能再点按钮；而且手机上
       * 没有右键那类替代入口。桌面保持既有行为（显示 3 秒后收起，见 adj785/adj797c）。
       */
      if (policy.autoHideMs <= 0) return
      clearAutoHide()
      autoHideTimer = window.setTimeout(() => {
        autoHideTimer = 0
        if (focusInToolbar()) return
        if (!toolbarShown) return
        toolbarShown = false
        revealToolbar(false)
        // adj792b：只有手机端需要这个"压过常显"的标记（桌面端有默认 opacity:0）
        if (Platform.isMobile) liveToolbar().addClass('is-user-hidden')
      }, 3000)
    }
    const syncToolbarVisibility = (): void => {
      if (!containerInViewport()) {
        if (toolbarShown) {
          hiddenByViewport = true
          revealToolbar(false)
          // adj797b：手机端还要打主动隐藏标记（否则 CSS 常显规则会继续显示它）
          if (Platform.isMobile) liveToolbar().addClass('is-user-hidden')
        }
        clearAutoHide()
        return
      }
      // 块在视界里：若之前因离开视界而隐藏 ⇒ 重新显示，并**从现在**开始 3 秒倒计时
      if (hiddenByViewport) {
        hiddenByViewport = false
        revealToolbar(true)
        startAutoHide()
      }
    }
    // 挂载时先同步一次状态（块已经可见就显示 + 倒计时；不可见就什么都不做）
    window.requestAnimationFrame(() => syncToolbarVisibility())
    plugin.register(clearAutoHide)
    /**
     * adj779（用户实测「手机端代码块：刚进入显示一次，点击后隐藏，**再显示不再显示**」）：
     *
     * 真因是**我自己挂的两套监听在打架** —— 这里原本还有一条 `pointerup` 兜底
     * （"触摸抬起时若隐藏就显示"），而一次触摸点击会**先 `pointerup` 再 `click`**：
     *   `pointerup` ⇒ 显示；紧跟的 `click` ⇒ 翻转 ⇒ **又隐藏** ⇒ 净结果永远是"隐藏" ✗✗
     * （这同时解释了"编辑模式看着根本不显示"）。**只要 click 这一条就够了**，删掉兜底。
     */
    plugin.register(() => {
      // adj785：悬停那两条监听已取消，这里只清理仍在用的监听
      container.removeEventListener('keydown', onKeyDown)
      /**
       * adj794d（用户实测）：「嵌入 jps 文件的编辑**可直达源码** ✓，但**工具栏卡在了原地不消失**」✗
       *
       * 原因：外侧落位时工具条被挂到 `document.body` 上（adj793c，为了摆脱祖先裁剪/层叠）⇒
       * 面板一旦被销毁（例如切到源码编辑态、或视图重建），**没人把它收回来** ⇒ 它就留在 body 上 ✗。
       * 这里在面板清理时兜住：还在 body 上就移回容器（容器已断开时直接移除）。
       */
      const el = liveToolbar()
      if (el.parentElement === document.body) {
        if (container.isConnected) container.appendChild(el)
        else el.remove()
      }
    })
    if (!host.embedded) toolbar.createSpan({ cls: 'ijipu-page-label', text: `${svgs.length} 页` })
    // adj738：工具条这里原来还有一枚「frontmatter 覆盖 N 项」徽标 —— 笔记 frontmatter 层已删除，
    // 值只可能来自「插件设置」或「源内 # jps-config」两种来源（后者在「⚙ 设置」对话框里列出自带项）。

    // —— 试听（播放/停止 + RAF 驱动色块跟随，与 iJipu 一致）——
    let playing: { cancel: () => void; totalMs: number; track: PlayheadSeg[] } | null = null
    // 试听按钮：图标 + 文字（窄容器里文字由 @container 规则隐藏，只留图标）
    const playBtn = toolbar.createEl('button', { cls: 'ijipu-play' })
    // adj862：工具条槽位标记（顺序契约见 `scoreMenu.ts` 的 SCORE_TOOLBAR_SLOTS；冒烟按它核对顺序）
    playBtn.dataset.slot = 'play'
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

    /**
     * adj764（清单 B6：用户要求「播放及色块显示等共性的功能都可以独立到引擎层面」）：
     * 时间轴推进改用**引擎时钟** `createPlaybackClock` —— 与应用共用同一套
     * "推进 / 暂停续播 / 取消后不再回调 / 到点恰好一次"的语义；本文件只做"每帧画色块"。
     * 起播延迟 200ms（与应用一致）从时间轴里扣掉：`currentMs = ms - PLAY_START_DELAY_MS`
     * （旧写法是 `performance.now() - playStart - 200`，等价但现在只有一份口径）。
     */
    const clock = createPlaybackClock({
      onTick: (ms) => {
        const currentMs = ms - PLAY_START_DELAY_MS
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
      },
      onEnd: () => {
        clearPlayBlock()
        playing = null
        setPlayState(false)
        plugin.unregisterPlay(stopPlayFn)
      },
    })

    const stopPlayFn = (): void => {
      playing?.cancel()
      playing = null
      clock.cancel()
      clearPlayBlock()
      setPlayState(false)
      plugin.unregisterPlay(stopPlayFn)
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
          setPlayState(true)
          clock.start()
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
    guidesBtn.dataset.slot = 'guides'
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
      /**
       * adj773（用户要求 3）：**按钮顺序统一为「试听、排版、设置、视图、编辑」**，
       * 「编辑」永远在**最后**（此前它在"设置"之前，用户报"编辑目前在中间"）。
       * 所以这里的"编辑"块被删掉了 —— 它与"格式化"一起挪到「视图」（`ijipu-mode-select-wrap`）之后，
       * 见下面标了 `adj773` 的那两段。
       */
      if (host.onFormat && !host.onToggleSource) {
        /**
         * adj749c（用户要求）：「**应该是源码状态才需要格式化，而不是预览**，位置不对」——
         * `.jps` 文件视图（有 `onToggleSource`）**预览态不再放格式化按钮**：
         * 它的位置在源码态的文件栏上，而且源码编辑已改成**逐行自动格式化**（与应用同款）。
         * 代码块没有"源码态 UI"（宿主本身就是源码），所以那里仍保留"就地格式化"。
         * adj773：位置从"设置之前"挪到"视图之后、编辑之前"（顺序见上）。
         */
        fmtBtn = menuOnly.createEl('button', { cls: 'ijipu-play ijipu-format-btn' })
        fmtBtn.setAttr('title', '按应用规范格式化源码（音符/小节线空格、歌词里的 {tp … } 段、描述头属性）')
        // adj749c：用**格式化自己的图标**（此前借的是"排版"图标 ⇒ 用户报"图标与排版重复"）
        fmtBtn.appendChild(formatIcon(15))
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
      cfgBtn = menuOnly.createEl('button', { cls: 'ijipu-play ijipu-config-btn' })
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
    /**
     * adj773（清理）：这里原本创建"块右上角的 `</>`（`ijipu-edit-source-btn`）"，
     * 但用户要求统一成工具条最后那枚「编辑」⇒ 那段创建代码已**删除**（不再"先建后撤"）。
     * 现在三处预览**只有一枚编辑入口**（`ijipu-edit-btn`，见"视图"之后那段）。
     * `editSourceBtn` 变量保留（恒为 null）：`revealToolbar` 里对它的 `?.` 调用天然是空操作，
     * 也避免为删一个已无用的变量再去动显示逻辑（减少回归面）。
     */

    // —— 显示模式：下拉列表（整页 / 满宽 / 谱面）——
    // 用普通按钮 + Obsidian 的 Menu，而**不是**原生 <select>：
    //  · 原生 select 会给下拉箭头预留内边距、宽度收不紧（在嵌入容器等上下文里还会参与布局，
    //    导致按钮比"图标 + 文字 + 箭头"宽一截）；
    //  · 它的弹层底色/文字色由平台决定，深色主题下会变成浅底浅字。
    // 自绘这三部分后宽度严格等于内容，菜单则完全跟随主题配色（且自带当前项勾选）。
    const modeWrap = toolbar.createEl('button', { cls: 'ijipu-mode-select-wrap' })
    modeWrap.dataset.slot = 'mode'
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

    /**
     * adj773（用户要求 3）：三处「编辑」**统一成一枚**：位置在**最后**（"视图"之后）、
     * **带笔图标**（用户说原来的 `</>` 图标"指示不明"），行为按宿主与平台分派：
     *  · **代码块**（`onEditSource`）⇒ 在笔记源码与该块预览之间切换（桌面/手机端都可用）；
     *  · **手机端**（`onToggleSource`）⇒ 用宿主编辑器打开 `.jps` 源码（源码模式）；
     *  · **桌面端**（`onEdit`）⇒ 用**嵌入版 iJipu**打开编辑。
     */
    {
      const editable = !!(host.onEditSource || host.onToggleSource || host.onEdit)
      if (editable) {
        const eb = toolbar.createEl('button', { cls: 'ijipu-play ijipu-edit-btn' })
        eb.dataset.slot = 'edit'
        eb.setAttr('aria-label', '编辑')
        eb.setAttr(
          'title',
          host.onEditSource
            ? '编辑这段源码（在笔记源码与预览之间切换）'
            : Platform.isMobile
              ? '编辑源码（用 Obsidian 的编辑器，源码模式）'
              : '用嵌入的爱记谱编辑',
        )
        eb.appendChild(editIcon(15))
        eb.createSpan({ cls: 'ijipu-btn-label', text: '编辑' })
        eb.addEventListener('click', () => {
          if (host.onEditSource) {
            host.onEditSource()
            return
          }
          /**
           * adj787（用户实测「手机端嵌入 `![[xxx.jps]]` 的工具条「编辑」点了**还是没反应**」）：
           *
           * 原来这里是 `host.onToggleSource?.()` —— 而**嵌入宿主没有 `onToggleSource`**（它只有 `onEdit`
           * 与 `onOpenFile`）⇒ `?.()` 空调用 ⇒ 什么都没发生 ✗（我上一轮加在 `embed.ts` 里的
           * "手机端 onEdit ⇒ 打开 .jps 并进源码编辑"因此**根本没被走到**）。
           * 现在手机端**回退到 `onEdit`**：嵌入宿主会给它，行为就是"打开该 .jps 并进入源码编辑"。
           */
          if (Platform.isMobile) {
            ;(host.onToggleSource ?? host.onEdit)?.()
            return
          }
          // 桌面端优先用嵌入版 iJipu（用户要求 3a）；没有这条路径时退回源码编辑
          if (host.onEdit) host.onEdit()
          else host.onToggleSource?.()
        })
      }
    }


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
    /**
     * adj773（用户要求 3）：**统一后的「编辑」按钮已经由上面那段创建**（在"视图"之后、带笔图标、
     * 按宿主与平台分派）⇒ 这里不再另建一枚（否则同一工具条会出现两个"编辑"）。
     * `hasEditEntry` / `keepEmbedLink` 仍保留：它们决定「打开谱面文件」链接要不要收掉。
     */
    if (!hasEditEntry && host.filePath && canOpenWithDefaultApp(plugin.app)) {
      // adj862：「应用打开」不再占工具条位置 ⇒ 建在游离容器里，由「⋯ 更多」菜单按 id 触发 `.click()`
      appOpenBtn = menuOnly.createEl('button', { cls: 'ijipu-play ijipu-app-open-btn' })
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

    // —— 「打开谱面文件」不再占工具条位置（adj862）：建在游离容器里，由「⋯ 更多」菜单触发 ——
    // adj726/727：有「编辑」且「编辑」留在站内时不再建；「编辑」会离开 Obsidian（默认应用）时保留。
    if (host.embedded && host.embedTitle && keepEmbedLink) {
      linkBtn = menuOnly.createEl('button', { cls: 'ijipu-embed-link' })
      embedLinkTitle = host.embedTitle
      linkBtn.setAttr('title', `打开谱面文件：${host.embedTitle}`)
      linkBtn.setAttr('aria-label', `打开谱面文件：${host.embedTitle}`)
      linkBtn.appendChild(linkIcon(15))
      linkBtn.createSpan({ cls: 'ijipu-embed-link-text', text: host.embedTitle })
      linkBtn.addEventListener('click', () => host.onOpenFile?.())
    }

    /**
     * adj862（T-5 定稿）：工具条**第 5 位**「⋯ 更多」——低频入口（设置 / 格式化 / 打开…）的唯一出口。
     *
     * ## 三入口共用**同一份** menuModel（用户口径：「同一份菜单数据、不同的呈现」）
     *   · 桌面 `⋯ 更多` 按钮 ⇒ `showAtPosition`（贴着按钮下沿弹出）
     *   · 桌面**预览区右键** ⇒ `showAtPosition`（鼠标位置；见下面的 `contextmenu` 监听）
     *   · 移动端 ⇒ 同一份数据 + 同一个 `Menu`：Obsidian 在手机上**本身**就把它渲染成
     *     **底部 Action Sheet**（`obsidian.asar` 的 app.css：`.is-phone .menu { position: absolute;
     *     bottom: 0; border-radius: … 0 0 }` + `.menu-grabber`）⇒ 不另写一套渲染 ✗（少一套就少一处漂移）。
     *
     * ## 为什么是"触发按钮的 `.click()`"而不是把处理器搬过来
     * 那四个入口（设置对话框 40 行、格式化、应用打开、打开谱面文件）**各自带着自己的前置条件与
     * 副作用**（`ConfigDialog` 的 onApply、落盘钩子 `beforeOpenExternal`、宿主写回…）。
     * 搬一遍 = 两份实现，必然漂移（本项目已多次复发）。这里只做**路由**：菜单项 id → 对应按钮。
     */
    const runScoreMenuAction = (id: ScoreMenuActionId): void => {
      /** adj864：面板自己手里的墨迹盒 + 当前显示模式（比插件缓存新鲜，供「跟随视图」与「谱面」范围用） */
      const paneRange = { box: svgEls[0] ? contentBoxOf(svgEls[0]) : null, mode: paneMode } as {
        box: { x: number; y: number; w: number; h: number } | null
        mode: ViewMode
      }
      switch (id) {
        case 'settings':
          cfgBtn?.click()
          return
        case 'format':
          fmtBtn?.click()
          return
        /**
         * adj874（用户 2026-10-11 定稿）：`copy-image-*` **一律**走 `copyScoreImage`（PNG → 剪贴板），
         * 不再按平台分派。
         *
         * ⚠ 这三项**只在桌面菜单里出现**（`buildScoreMenu` 在 `isMobile` 时不生成图片组）：
         * 取图必须走**嵌入版 iJipu 应用**，而嵌入版**只在桌面注册**（`main.ts` 的
         * `if (Platform.isDesktopApp) this.registerView(...)`；`embed.ts` 的 `getEmbedUrl` 在手机
         * 直接 `return null`）⇒ 手机上点它必然失败，于是**手机端根本不暴露这个入口**。
         * `copyScoreImage` 在手机上仍会失败（同一条嵌入版依赖），只是菜单不会再给到它
         * （adj873 那条"手机端保存到谱面同目录"也要取图 ⇒ 同样必失败，已整条删除）。
         */
        case 'copy-image-1':
          void plugin.copyScoreImage(source, 1, paneRange)
          return
        case 'copy-image-2':
          void plugin.copyScoreImage(source, 2, paneRange)
          return
        case 'copy-image-4':
          void plugin.copyScoreImage(source, 4, paneRange)
          return
        case 'copy-svg':
          void plugin.copyScoreSvg(source, paneRange)
          return
        case 'copy-source':
          void plugin.copyScoreSource(source)
          return
        case 'range-view':
          plugin.setExportRange('view')
          return
        case 'range-page':
          plugin.setExportRange('page')
          return
        case 'range-score':
          plugin.setExportRange('score')
          return
        case 'app-open':
          appOpenBtn?.click()
          return
        case 'embed-link':
          linkBtn?.click()
          return
      }
    }
    const openScoreMenu = (at: HTMLElement | { x: number; y: number }): void => {
      const sections = buildScoreMenu({
        isMobile: Platform.isMobile,
        hasWriteSource: cfgBtn !== null,
        hasFormat: fmtBtn !== null,
        hasAppOpen: appOpenBtn !== null,
        embedTitle: embedLinkTitle ?? undefined,
        // adj864：菜单里能改「导出范围」；"跟随视图"把当前显示模式写实（不点开也知道会按哪种口径）
        // adj873：缺省值读 `types.ts` 的 `DEFAULT_EXPORT_RANGE`（**一处定义**：设置页 / 解析 / 菜单同源）
        range: plugin.settings.exportRange ?? DEFAULT_EXPORT_RANGE,
        paneModeLabel: MODE_LABEL[paneMode],
      })
      const menu = new Menu()
      sections.forEach((sec, i) => {
        if (i > 0) menu.addSeparator()
        // 组标题：桌面菜单里是灰字不可点行；手机上就是 Action Sheet 的小标题
        menu.addItem((item) => item.setTitle(sec.title).setIsLabel(true))
        for (const it of sec.items) {
          menu.addItem((item) => {
            item.setTitle(it.label).onClick(() => runScoreMenuAction(it.id))
            // adj864：「导出范围」是单选 ⇒ 当前项打勾（与显示模式/深浅模式那两组同一做法）
            if (it.checked !== undefined) item.setChecked(it.checked)
          })
        }
      })
      if (at instanceof HTMLElement) {
        const r = at.getBoundingClientRect()
        menu.showAtPosition({ x: Math.round(r.left), y: Math.round(r.bottom + 4) })
      } else {
        menu.showAtPosition({ x: Math.round(at.x), y: Math.round(at.y) })
      }
      // 诊断：菜单里到底有哪些项（用户报告"某个入口不见了"时，这一行直接给出答案）
      plugin.lastToolbarClick =
        `⋯ 更多 ⇒ 菜单（平台=${Platform.isMobile ? '手机' : '桌面'}；` +
        `项=${scoreMenuIds(sections).join('、') || '（空）'}）`
    }
    const moreBtn = toolbar.createEl('button', { cls: 'ijipu-play ijipu-more-btn' })
    moreBtn.dataset.slot = 'more'
    moreBtn.setAttr('type', 'button')
    moreBtn.setAttr('aria-label', '更多')
    moreBtn.setAttr('aria-haspopup', 'menu')
    moreBtn.setAttr('title', '更多：设置 / 格式化 / 打开（桌面在预览区右键是同一份菜单）')
    moreBtn.appendChild(moreIcon(15))
    moreBtn.createSpan({ cls: 'ijipu-btn-label', text: '更多' })
    moreBtn.addEventListener('click', () => openScoreMenu(moreBtn))
    /**
     * **桌面右键预览区** = 与「⋯ 更多」同一份菜单（T-5 三入口之一）。
     * 移动端**不注册**（`policy.contextMenu` 为 false）：手机没有右键，长按又被宿主的文本选择/
     * 块菜单占用 ⇒ 移动端唯一入口是 `⋯ 更多`（点开就是底部 Action Sheet）。
     */
    if (policy.contextMenu) {
      container.addEventListener('contextmenu', (e) => {
        const t = e.target instanceof Element ? e.target : null
        // 右键落在工具条自身上 ⇒ 交回宿主（例如以后要"右键工具条"做别的）
        if (t?.closest('.ijipu-score-toolbar')) return
        e.preventDefault()
        openScoreMenu({ x: e.clientX, y: e.clientY })
      })
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
    /**
     * adj865（用户定稿的块级缩放 `z`）：**只对笔记里的代码块生效**（`host.zoom` 由 `IJipuBlock` 传，
     * 文件视图 / 嵌入不传 ⇒ 保持既有行为 ✓）。
     *
     * 落地方式是**类 + CSS 自定义属性**（社区审核 `no-static-styles-assignment` 禁止直接写内联样式 ✗）：
     *  · `ijipu-zoom-fixed` ⇒ 宽度 = `--ijipu-zoom-w`（该图的 viewBox 宽 = 自然尺寸）× `--ijipu-zoom-factor`；
     *  · `ijipu-zoom-fit`（`z=*`）⇒ 宽度 100%（铺满笔记栏宽 = 上线前的行为）；
     *  · **不传 `zoom`** ⇒ 两个类都不加 ⇒ 走既有的 `.ijipu-mode-* svg { width: 100% }`（文件视图/嵌入不变）。
     * 基础规则里的 `max-width: 100%` 仍然管用 ⇒ 自然尺寸比栏宽时按比例缩小，不会横向溢出 ✓。
     *
     * ⚠ adj871：这里原来**当场按 `host.zoom` 打类**，而 `setMode()` 又按模式打一次 ⇒ 两处口径会漂：
     * `v=p`（整页）本该让 `z` 不生效，但 `ijipu-zoom-fixed` 还在 ⇒ 整页被 z 缩掉 ✗。
     * 现在**只有一处判定**（`publishDisplaySize`，挂载与切模式走同一条路），这里不再自己判一遍。
     */
    /**
     * adj872（**把"嵌入块/文件视图默认 = `z=*`"从隐式变成显式**）：
     * **`undefined`（嵌入块 `![[x.jps]]` / `.jps` 文件视图）就地折成 `'auto'`** ⇒ 面板一定打
     * `ijipu-zoom-fit`（按宽自适应）。这一档此前是**三层巧合**：这两个入口不传 `zoom` ⇒
     * `publishDisplaySize` 两个分支都不进 ⇒ 不加任何 zoom 类 ⇒ 靠 styles.css 的 `width: 100%` 兜底
     * ⇒ 视觉上等价 `z=*`。**任何人动一下 CSS 就会静默改掉它们的默认呈现** ✗ ⇒ 现在写死成显式事实。
     *
     * **"默认值由谁定"只有这两处**（别处不许再定，免得又漂回隐式）：
     *  · **代码块**（```jps）＝ `main.ts` 的 `zoomOfBlock()` ⇒ `jpsBlocks.zoomOfInfo()`：
     *    **`z` 未写 ⇒ `100`**（固定自然尺寸，1 个 viewBox 单位 = 1 CSS px）；`z=*` ⇒ `'auto'`；`z=N` ⇒ `N`；
     *  · **嵌入块 / `.jps` 文件视图** ＝ **`host.zoom === undefined`**（本字段根本不传）⇒ 等价 `z=*`。
     * `page`（整页）模式下 `z` 不生效（整页尺寸由"整页进视界"决定，见 `publishPageFit`）。
     */
    const zoomOfHost: number | 'auto' = host.zoom === undefined ? 'auto' : host.zoom
    /**
     * ⚠ adj871 订正（用户：「`z` 未写保持 `z=100` 的现状」）：面板里**不再需要**区分"z 写没写" ——
     * 未写与 `z=100` 行为一致（固定自然尺寸），只有 `z=*` 才铺满 ⇒ 原来那个局部常量已删（`tsc` 会报未使用 ✓）。
     * `ScorePaneHost.zoomWritten` 仍由 `main.ts` 传着（它只服务于"`v=p` + 具体 `z=N` ⇒ 提示 z 不生效"）。
     */
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
       * 游离节点量不到）；而此刻**辅助虚线层还没加**（`addGuideLayer` 已经挪到 `setMode` 之后，
       * 见 `rebuildGuides` —— 那里才量得到"尺寸定稿后"的真实宽度），
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

    /**
     * adj863/adj864：把**这份谱的实测墨迹盒 + 当前显示模式 + 页面尺寸**报给插件。
     *
     * 为什么连**页面尺寸**一起报：导出/复制图片时，渲染是在**嵌入版应用**里做的（插件没有 canvas）——
     * 而"墨迹盒"是在**本面板的配置**下量的。两边页面设置若不一致（例如应用里选了 A5、插件里是 A4），
     * 盒就落在**另一套坐标系**里 ⇒ 裁出来的图必然错位 ✗。插件据此**明确拒绝**（`resolveRangeBox`），
     * 而不是糊里糊涂裁一下 ✗。
     */
    function publishInk(svgEl: SVGSVGElement, mode: ViewMode): void {
      const box = contentBoxOf(svgEl)
      const orig = svgEl.dataset.origVb ?? svgEl.getAttribute('viewBox') ?? ''
      const [, , w, h] = orig.split(/[\s,]+/).map(Number)
      if (box === null || !(w > 0) || !(h > 0)) return
      plugin.lastInk = { source, box, mode, pageW: w, pageH: h }
    }

    /** 把量到的内容盒写进 dataset（`applyViewBox` 与切模式都读它） */
    function writeContentBox(svgEl: SVGSVGElement, box: { x: number; y: number; w: number; h: number }): void {
      svgEl.dataset.contentBox = `${box.x} ${box.y} ${box.w} ${box.h}`
      // adj863（T-3 定稿）：**同时**把这份实测墨迹盒挂到插件上（导出/复制走命令路径时只能读它）
      publishInk(svgEl, paneMode)
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
      /**
       * adj780b（用户实测「关闭排版后有偶发的情况不会自动裁剪」，诊断写着
       * 「未量到内容盒（那一刻谱面还没进渲染树；已自动重试 3 次、并挂了 ResizeObserver 等它进树）」）：
       *
       * 只重试 3 次（最远 300ms）对"切换模式后要等新容器真正进渲染树"这件事**太短了** ⇒
       * 放弃补量后就永久留着空白 ✗（"偶发"正是因为大多时候来得及、偶尔来不及）。
       * 阶梯加长到 5 档（最远 3s），覆盖"跨帧/跨布局/等字体"这些常见情形；
       * `ResizeObserver` 那条仍作为尺寸变化时的独立补量路径。
       */
      const delays = [0, 60, 300, 1000, 3000]
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
        else noteCrop('未量到内容盒（那一刻谱面还没进渲染树；已自动重试 5 次、并挂了 ResizeObserver 等它进树）')
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
      /**
       * adj865：把"这张图的**自然宽度**"（= 当前 viewBox 的宽，单位就是 CSS px）挂到外层元素上。
       * `z` 的固定尺寸口径消费它：`宽度 = 自然宽 × z/100`（`z=100` ⇒ 正好 1:1，不被放大 ✓）。
       * 模式/裁剪一变，自然宽就变 ⇒ 每次下发 viewBox 时一并更新（口径同源，不另算 ✗）。
       */
      const publishZoomW = (w: number): void => {
        const wrapEl = svgEl.parentElement
        if (wrapEl instanceof HTMLElement && w > 0) wrapEl.setCssProps({ '--ijipu-zoom-w': `${w}px` })
      }
      if (mode === 'score') {
        const [, , w, h] = orig.split(/[\s,]+/).map(Number)
        const b = contentBoxOf(svgEl)
        /**
         * adj843（用户 2026-10-11 给出**数据驱动**的判据 ✔）：
         * 「**通常音符墨迹高度为最小墨迹盒高度**」——整块谱面的墨迹盒**不可能比一个音符的墨迹还矮**。
         * 所以这里只做一件事：**量一个音符的墨迹高**（`[data-notepos]`，与引擎的光标联动属性同源），
         * 阈值公式由引擎的 `minInkFor()` 给（取它的 ~90%，取不到音符 ⇒ 兜底极小值，不阻断渲染）。
         */
        let noteInkH = 0
        try {
          const noteEl = svgEl.querySelector('[data-notepos]')
          const nb = noteEl === null ? null : (noteEl as SVGGraphicsElement).getBBox()
          if (nb !== null && Number.isFinite(nb.height) && nb.height > 0) noteInkH = nb.height
        } catch {
          /* 量不到音符就用兜底阈值 ✔（不阻断渲染 ✔） */
        }
        /**
         * adj863（T-3 定稿）：**判据与几何全部交给引擎**——`rangeBox()` 一次给出
         * 「墨迹 ± 每边 N px」+ 退化闸（小于一个音符的墨迹）+ 近整页闸（≥98% 整页 ⇒ 多半把白底量进来了）。
         * 此前这里的 `PAD = 2` 与两道闸是本文件的**私有副本**，导出那边又写一遍 ⇒ 口径必然漂 ✗
         * （本项目"数值口径必须同源"的老坑，见 AGENTS §六之二·4）。
         */
        const out = rangeBox({ range: 'score', pageW: w, pageH: h, ink: b, minInk: minInkFor(noteInkH) })
        if (out.ok) {
          svgEl.setAttribute('viewBox', `${out.box.x} ${out.box.y} ${out.box.w} ${out.box.h}`)
          publishZoomW(out.box.w)
          // 回传给插件，供设置页显示（运行期诊断；见 IJipuPlugin.lastCropInfo 的说明）
          noteCrop(
            `按墨迹裁剪 ${out.box.w.toFixed(0)}×${out.box.h.toFixed(0)}（墨迹 ${Math.round(b?.w ?? 0)}×${Math.round(b?.h ?? 0)}` +
              ` + 每边 ${RANGE_PAD_DEFAULT}px；整页 ${Math.round(w)}×${Math.round(h)}，高度只剩 ${(((b?.h ?? 0) / h) * 100).toFixed(0)}%）`,
          )
        } else {
          /**
           * 判失败 ⇒ **显示端**退回按边距裁剪（比裁成一条横带好得多 ✗）。
           * ⚠ 导出端**不跟着退**：那里必须**明确报错**（见 `main.ts` 的 `applyExportRange`）——
           * 用户可以接受"预览先用边距顶着"，但不能接受"我选了导出谱面、结果悄悄给我一张整页"✗。
           */
          const ml = c.margin_left ?? 0
          const mt = c.margin_top ?? 0
          const mr = c.margin_right ?? 0
          const mb = c.margin_bottom ?? 0
          svgEl.setAttribute('viewBox', `${ml} ${mt} ${Math.max(1, w - ml - mr)} ${Math.max(1, h - mt - mb)}`)
          publishZoomW(Math.max(1, w - ml - mr))
          noteCrop(`退回按边距裁剪 —— ${out.reason ?? '量取不可靠'}`)
          /**
           * adj780（用户实测）：「PC 端 jps 代码块，点排版→调整虚线→再点排版关闭虚线时，
           * **视图回到谱面视图，但墨迹四周空白没被及时消除**」。
           *
           * 原来是"**只有完全没量到**（`!box`）才补量"；而"量到的盒几乎等于整页"被判为"**真的量到了、重试没意义**"。
           * 但实测里这一支恰恰也可能是**量得太早**（渲染/字体还没就绪、或刚切换模式还没重排）⇒
           * 退回"按边距裁剪"且**不再补量** ⇒ 墨迹四周的空白就一直留着 —— 与用户描述完全一致。
           *
           * 现在**两种情形（没量到 / 量得不可信）都补量一次**；用 `cropRetried` 标记把补量限制为
           * "每个渲染出的 svg 至多一次"，避免"补量 → 又走这条分支 → 再补量"的自激循环（补量本身会重下 viewBox ✔）。
           */
          if (svgEl.dataset.cropRetried !== '1') {
            svgEl.dataset.cropRetried = '1'
            observeUntilMeasured(svgEl, c)
            scheduleCropRetry(svgEl, c)
          }
        }
        svgEl.removeAttribute('width')
        svgEl.removeAttribute('height')
      } else {
        svgEl.setAttribute('viewBox', orig)
        // adj865：整页/满宽的自然宽 = 页面宽（`z=100` 时按 1px:1px 显示整页）
        publishZoomW(Number(orig.split(/[\s,]+/)[2]) || 0)
      }
    }

    /**
     * adj871：**显示尺寸的唯一落地点** —— 按当前模式 + 代码块参数（`m=` / `z=`）决定
     * "打哪个缩放类、下发哪个系数"。挂载（`setMode` 在 `paint()` 末尾被调）与切模式都走它
     * ⇒ 不会出现"某个入口只改了一半"的漂移（adj866 就是这类 bug：切模式把 `z` 的类抹掉）。
     *
     * 三种模式的几何（用户 2026-10-11 定稿）：
     *  · `page` ：整页（含页边距）按 contain 放进可视区 ⇒ **`z` 不生效**（尺寸由"整页进视界"决定，
     *             见 `publishPageFit`）。这里只把两个缩放类摘掉，让 styles.css 的
     *             `.ijipu-mode-page` 规则生效（否则 `ijipu-zoom-fixed` 特异性更高、会把整页缩掉 ✗）；
     *  · `full` ：只有**宽度**进视界 ⇒ 宽 = 容器宽（`z=*`；**嵌入块 / 文件视图传 `undefined` ⇒ 已折成
     *             这一支**）或 自然宽 × z/100（`z=N`，含 `z=100`；**代码块 `z` 未写 ⇒ `100` ⇒ 这一支**）；
     *             高度超出就靠滚动（`height: auto`）；
     *  · `score`：现状不变（viewBox 裁到墨迹盒 + 每边 2px；`z=*` / `undefined` ⇒ 按宽铺满、
     *             `z=N` ⇒ 自然尺寸 × N/100）。
     *
     * ⚠ adj872：这里**看不到 `undefined`** —— 它已在 `paint()` 里就地折成 `'auto'`（见那段注释）。
     * 那不是"漏了一档"，而是**同一个事实只保留一个表示**：嵌入块 / 文件视图 ＝ `undefined` ＝ `z=*`。
     */
    function publishDisplaySize(mode: ViewMode): void {
      // 先清两类：切来切去都不留旧类（否则上一模式的类会把新模式的规则压掉 ✗）
      svgWrap.removeClass('ijipu-zoom-fit')
      svgWrap.removeClass('ijipu-zoom-fixed')
      if (mode === 'page') return
      const zNum = typeof zoomOfHost === 'number' ? zoomOfHost : null
      /**
       * ⚠ adj871 订正（用户 2026-10-11 明确）：「**`z` 未写保持 `z=100` 的现状**」⇒
       * 满宽模式下**未写 z 也是固定自然尺寸**（1 单位 = 1px），**只有写 `z=*` 才铺满**。
       * 所以这里**不能**用 `zoomWritten` 分岔（那是"未写即铺满"的写法，已撤掉）；
       * `zoomWritten` 现在只服务于"`v=p` + 具体 `z=N` ⇒ 提示 z 不生效"那一条 ✓。
       */
      if (mode === 'full' && zoomOfHost === 'auto') {
        // 满宽 + `z=*` ⇒ 铺满容器宽（高度超出就滚动 ✓）
        svgWrap.addClass('ijipu-zoom-fit')
        return
      }
      if (zNum !== null) {
        svgWrap.addClass('ijipu-zoom-fixed')
        svgWrap.setCssProps({ '--ijipu-zoom-factor': String(zNum / 100) })
      } else if (zoomOfHost === 'auto') {
        svgWrap.addClass('ijipu-zoom-fit')
      }
      // adj872：`host.zoom` 未传（嵌入块 / `.jps` 文件视图）已在上面折成 `'auto'` ⇒ 一定落到
      // `ijipu-zoom-fit`；**不再有"两类都不打、靠 `.ijipu-mode-*` 的 `width: 100%` 兜底"这一档**。
    }

    /**
     * adj871：**整页模式的"整页进视界"拟合**（用户 2026-10-11 定稿）。
     *
     * 设可视区 `W1×H1`、页面框 `W×H` ⇒ 缩放系数 `s = Math.min(w1 / w, h1 / h)`，
     * 于是渲染宽 `W*s`、高 `H*s`（高由 `height: auto` 按 viewBox 比例自动得到 ✓）。
     *  · `W`/`H` = 该页**整页**框（含页边距）= `data-orig-vb` 的第 3/4 个数；
     *  · `W1` = 谱面容器（`.ijipu-svgs`）的可用宽度；
     *  · `H1` = **可见高度** = `window.innerHeight` − 容器顶边 − `PAGE_FIT_GAP`，
     *         下限钳到 `PAGE_FIT_MIN_H`（面板再矮也要留出能看的空间）。
     *
     * ⚠ 重算时机**只有**三个：**挂载** / **切换模式**（都由 `setMode` 调）/ **尺寸变化**
     * （`window.resize` + 挂在容器上的 `ResizeObserver`，见 `paint()` 末尾）。
     * **绝不跟滚动实时重算** —— 滚动时容器顶边一直在变，页面尺寸会跟着"一跳一跳"（用户明确否掉 ✗）。
     *
     * 只写 `--ijipu-page-fit`（在 styles.css 里乘到 `--ijipu-zoom-w` 上）：
     * `v=p` 时 `z` 不生效，所以**不复用** `--ijipu-zoom-factor` —— 免得读代码的人以为 `z` 还在起作用。
     */
    function publishPageFit(): void {
      if (paneMode !== 'page') return
      const w1 = svgWrap.clientWidth
      const h1 = Math.max(PAGE_FIT_MIN_H, window.innerHeight - svgWrap.getBoundingClientRect().top - PAGE_FIT_GAP)
      if (!(w1 > 0) || !(h1 > 0)) return // 容器还没进渲染树（宽 0）⇒ 不写，等 ResizeObserver 叫我们
      for (const svgEl of svgEls) {
        const wrapEl = svgEl.parentElement
        if (!(wrapEl instanceof HTMLElement)) continue
        const vb = (svgEl.dataset.origVb || svgEl.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number)
        const w = vb[2]
        const h = vb[3]
        if (!(w > 0) || !(h > 0)) continue
        const s = Math.min(w1 / w, h1 / h)
        if (!(s > 0) || !Number.isFinite(s)) continue
        wrapEl.setCssProps({ '--ijipu-page-fit': String(s) })
      }
    }

    /**
     * adj871：**重建辅助虚线层**（`paint()` 里尺寸定稿之后一次；尺寸变化后一次）。
     *
     * 为什么要重建而不是留原地：虚线的位置是按"SVG **当前实际宽度**"换算出来的百分比
     * （`guidePlacement` 的 `boxWPx`），而整页模式下这个宽度是**算出来的**（见 `publishPageFit`）
     * ⇒ 必须在拟合系数落地之后再量一次，否则虚线会整体偏（左右边距线最明显）。
     */
    function rebuildGuides(): void {
      if (!plugin.showGuides) return
      svgEls.forEach((svgEl, i) => {
        const wrapEl = svgEl.parentElement
        if (!(wrapEl instanceof HTMLElement)) return
        wrapEl.querySelectorAll('.ijipu-guide-layer').forEach((el) => el.remove())
        addGuideLayer(wrapEl, svgEl, i, cfg)
      })
    }

    /**
     * adj871：**尺寸变化**（`window.resize` / `ResizeObserver`）的唯一落点：
     * 重算整页拟合 + 重摆辅助虚线。⚠ 它**不监听滚动**（见 `publishPageFit` 的口径）。
     */
    function onSizeChanged(): void {
      publishPageFit()
      rebuildGuides()
    }

    function setMode(next: ViewMode): void {
      paneMode = next
      /**
       * ⚠ adj866（**真机验证抓到的真 bug**）：这里原来是 `setAttribute('class', 'ijipu-svgs ijipu-mode-x')`
       * —— 它把整个 class 属性**重写**了一遍 ⇒ `adj865` 的块级缩放类（`ijipu-zoom-fixed` /
       * `ijipu-zoom-fit`，切模式时会被这一句抹掉）**当场丢失** ⇒ `z=100` 退化成"撑满容器"（用户看到的就是
       * "设了 z 没用"）。源码正则断言抓不到这种"属性被后写覆盖"的顺序问题，只有真机跑一遍才现形
       * ⇒ 改成**按模式类增删**（`ijipu-svgs` 与缩放类都不动）。
       */
      for (const m of ['page', 'full', 'score'] as const) svgWrap.removeClass(`ijipu-mode-${m}`)
      svgWrap.addClass(`ijipu-mode-${next}`)
      // 按钮上的文字、图标、悬停说明跟着走（图标三种形状见 icons.ts，与菜单项一一对应）
      modeTextEl.setText(MODE_LABEL[next])
      modeIconEl.empty()
      modeIconEl.appendChild(modeIcon(next, 15))
      modeWrap.setAttr('title', `显示模式：${MODE_LABEL[next]}（${MODE_HINT[next]}）`)
      /**
       * adj871：顺序有讲究 —— ① 先定"打哪个缩放类 + 系数"；② 再逐页下发 viewBox 与自然宽
       * （整页拟合要用 viewBox 里的**页面框 W×H** ⇒ 必须在 ② 之后）；③ 整页拟合（只对 `page` 有效）。
       */
      publishDisplaySize(next)
      for (const svgEl of svgEls) applyViewBox(svgEl, next, cfg)
      publishPageFit()
      /**
       * adj864：把"这份谱**最近一次显示的模式**"（连同页面尺寸）再报一次 —— 命令路径没有面板，
       * 而「跟随视图」这一口径要靠它才知道该按谱面还是按整页（`IJipuPlugin.resolveRangeBox`）。
       */
      const first = svgEls[0]
      if (first) publishInk(first, next)
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
        /**
         * adj783（用户实测）：「**手机端开排版调整虚线是比较困难的，至少我没正常拖动过**」。
         *
         * 原来只挂 `mousedown` —— 触摸拖动**根本不会产生 `mousemove`**（那是鼠标事件），
         * 所以手机上必然拖不动。改用 **Pointer Events**（鼠标/触摸/触控笔通吃）：
         * 事件对象 `PointerEvent` 继承 `MouseEvent`，`clientX/clientY` 语义不变 ⇒
         * `startGuideDrag` 内部逻辑一行都不用改。
         * 另配 `touch-action: none`（见 styles.css）—— 否则浏览器会把这记手势当**滚动**，
         * 直接掐断手势流（这也是"怎么拖都不动"的另一半原因）。
         */
        el.addEventListener('pointerdown', (e) => startGuideDrag(e, line, scale))
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
        // adj783：移动端也要能拖 ⇒ 与 pointerdown 配套改用 pointermove/pointerup（+ pointercancel）
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      // 触摸被系统/浏览器接管（来电、手势返回等）时也要收尾，避免"拖到一半卡住"
      window.addEventListener('pointercancel', onUp)
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

    // 初始显示模式（内部会把缩放类 / 自然宽 / 整页拟合一并下发）
    setMode(paneMode)
    /**
     * adj871：辅助虚线层**在尺寸定稿之后**再建 —— 整页模式的宽度是"整页进视界"算出来的
     * （`setMode` 里已落地），这里量到的才是最终宽度，虚线才不会偏（见 `rebuildGuides`）。
     */
    rebuildGuides()
    /**
     * adj871：整页拟合的**第二种重算时机** —— 容器尺寸变化（分栏拖动 / 刚进渲染树）。
     * 挂 `ResizeObserver` 而不是定时器：宿主"先建 DOM 再挂进文档"时，容器宽度从 0 变成真实值的那一瞬
     * 正是可以算拟合的时刻（与 adj725b 的补量思路同源）。
     * ⚠ 只观察容器尺寸，**不监听滚动**（滚动重算 ⇒ 页面尺寸一跳一跳，用户明确否掉）。
     */
    recomputeFit = onSizeChanged
    if (typeof ResizeObserver !== 'undefined') {
      pageFitObserver = new ResizeObserver(() => onSizeChanged())
      pageFitObserver.observe(svgWrap)
    }
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
      // adj871：整页拟合的观察器与"窗口尺寸变化"的落点同理（销毁后不许再摸已经丢弃的 DOM）
      pageFitObserver?.disconnect()
      pageFitObserver = null
      recomputeFit = null
      window.removeEventListener('resize', onWindowResize)
      // adj725：把挂到宿主 widget 容器上的类原样摘掉（那是宿主自己的元素，不留痕）
      hostWidgetEl?.removeClass('ijipu-cm-host')
      hostWidgetEl = null
      // adj740/745：逐层摘掉两类类（都不是我们的元素，必须不留痕）
      for (const el of noClipEls) {
        el.removeClass('ijipu-cm-noclip')
        el.removeClass('ijipu-cm-nocontain')
      }
      noClipEls.clear()
      /**
       * adj794e（用户实测：手机端"嵌入 jps 文件的编辑可直达源码 ✓，但**工具栏卡在了原地不消失**"）：
       *
       * 外侧落位时工具条被挂到 `document.body`（adj793c，为摆脱祖先裁剪/层叠）⇒
       * 面板销毁时 `container.empty()` 只清容器**内**的东西 ✗ ⇒ 它就留在 body 上不动 ✓✓
       * （我上一版把它放进 `plugin.register(...)` ✗ —— 那个回调只在**插件卸载**时跑，
       *  面板销毁根本不会触发 ✗，所以完全没生效 ✓）。这里在**真正的 destroy** 里收掉。
       */
      // ⚠ `destroy()` 看不到 `paint()` 内那个局部 `toolbar`（写成 `toolbar` 会解析到浏览器全局 ✗）
      // ⇒ 按面板 id 在 body 上精确找它并移除（外侧落位时它被挂到 body，见 adj793c/adj794e）
      document.body.querySelector(`[data-ijipu-pane="${paneId}"]`)?.remove()
      livePanes.delete(paneId)
      container.empty()
    },
  }
}
