/**
 * scoreMenu.ts — 谱面面板的「工具条槽位 / 菜单模型 / 平台策略」**唯一来源**（adj862，T-5 定稿）
 *
 * ## 为什么要有这个文件（用户 2026-10-11 定稿口径）
 * ① **工具条只放高频，且固定 5 位**：`▶ 试听` / `☰ 排版` / `谱面·页面` / `✎ 编辑` / `⋯ 更多`——
 *    「设置」等低频项**移入菜单**（用户原话：「我建议 设置 放到菜单中」「编辑建议还是尽量放在工具条，
 *    这也是高频操作」）。
 * ② **菜单只定义一次**（用户原话：「同一份菜单数据、不同的呈现」）：桌面 `⋯ 更多` 弹出、
 *    桌面预览区**右键**、移动端**底部 Action Sheet** 三处**消费同一份 `buildScoreMenu`**
 *    —— 禁止各写一份（AGENTS §六之二·4「数值口径必须同源」；本项目多次因"两处各写一份"复发）。
 * ③ **移动端不是"缩小版桌面"**：触控目标 ≥44px、**不自动收起**（常驻）、不依赖 hover、不依赖右键
 *    —— 由 `toolbarPolicy()` 一处给出，渲染端只**消费**，不再各自 `if (Platform.isMobile)` 散判。
 *
 * ## 四条硬约束（都有冒烟闸门 `adj862` / `adj874` 守着）
 * · `SCORE_TOOLBAR_SLOTS` 是**顺序契约**：`scorePane.ts` 里 `dataset.slot` 的出现顺序必须与它一致
 *   （工具条多一个/少一个/换位置 ⇒ 冒烟红灯，必须**明确**改这份契约而不是悄悄漂）。
 * · 工具条**不再包含** 设置 / 格式化 / 应用打开 / 打开谱面文件（它们是菜单项；见 `MENU_ONLY_ACTIONS`）。
 * · 移动端**没有**「在应用中打开」（嵌入版仅桌面可用，`embed.ts` 的视图注册也只在桌面）。
 * · 移动端**没有图片出口**（`copy-image` / `save-png` / `save-svg` 都不生成）：取图必须走嵌入版应用，
 *   而嵌入版只在桌面注册 ⇒ 手机上必失败；手机能用的只有「复制 SVG 文本 / 复制谱面源码」这类
 *   **走插件自己引擎**的出口（`adj874` + `adj912`，用户 2026-10-13 定稿；详见 `buildScoreMenu` 里那段注释）。
 *
 * ## 移动端 Action Sheet 为什么不自己画
 * Obsidian 的 `Menu` 在手机上**本身就是底部弹出的大行高面板**——`obsidian.asar` 的 app.css 里有
 * `.is-phone .menu { position: absolute; bottom: 0; left/right: var(--safe-area-inset-*);
 * border-radius: … 0 0 }` 与 `.menu-grabber`（吸顶把手）⇒ 三处共用 `Menu` 即天然满足
 * 「移动端 = Action Sheet」，**不引入第二套渲染**（少一套就少一处漂移）。
 *
 * ## 依赖约束
 * 本模块**不依赖 obsidian / DOM**（只输出纯数据；唯一的运行时依赖是引擎的 `dpiForScale`，也是纯函数）
 * ⇒ 可被 `npm run smoke` 直接 import 逐项断言；真正的渲染（`new Menu()` / 事件绑定）留在 `scorePane.ts`。
 */
import { dpiForScale } from '@ijipu/engine'

/** 工具条上的 5 个槽位（顺序即渲染顺序；`scorePane.ts` 的 `dataset.slot` 必须按此出现） */
export const SCORE_TOOLBAR_SLOTS = [
  { id: 'play', label: '试听' },
  { id: 'guides', label: '排版' },
  { id: 'mode', label: '谱面·页面' },
  { id: 'edit', label: '编辑' },
  { id: 'more', label: '⋯ 更多' },
] as const

/** 槽位 id 联合类型 */
export type ScoreToolbarSlot = (typeof SCORE_TOOLBAR_SLOTS)[number]['id']

/**
 * **只进菜单、不进工具条**的动作（T-5 定稿：工具条 5 位之外的一切入口都走 `⋯ 更多`）。
 * 冒烟用它做**负对照**：菜单模型里必须有这些，工具条槽位里必须没有这些。
 */
export const MENU_ONLY_ACTIONS = [
  'settings',
  'format',
  // adj864（T-5「复制」组）→ **adj912 改组**：图片出口从三项「复制为图片（1×/2×/4×）」合成**一项**
  //   「复制图片」，分辨率改由**「分辨率」组**（`scale-1/2/4`，单选打勾）决定 —— 它是一条**可持久化的
  //   L1 设置**（`settings.imageScale`，默认 2×），与「导出范围」同一手法（菜单里点 = 改设置）。
  // adj874 的口径不变：图片类出口**只在桌面生成**（取图必须走嵌入版应用，而嵌入版只在桌面注册）；
  'copy-image',
  // adj912 新增：两个**保存到文件**的出口（PNG 走嵌入版渲染通道、SVG 走插件自己的引擎），
  //   落点与命名见 `savePath.ts`（`.jps` 同目录 + 主名，同名不覆盖就加序号）
  'save-png',
  'save-svg',
  'copy-svg',
  'copy-source',
  // adj912：「分辨率」组（单选打勾；只对**位图**出口生效 —— 复制图片 / 保存为 PNG，矢量不适用）
  'scale-1',
  'scale-2',
  'scale-4',
  // adj864（T-5「范围」组）：跟随视图 / 页面 / 谱面 —— 决定复制与导出时的画布口径
  'range-view',
  'range-page',
  'range-score',
  'app-open',
  'embed-link',
] as const

/** 菜单动作 id（渲染端按 id 分派到具体按钮的既有处理器） */
export type ScoreMenuActionId = (typeof MENU_ONLY_ACTIONS)[number]

/** 菜单项 */
export interface ScoreMenuItem {
  id: ScoreMenuActionId
  /** 菜单里的标题（面向用户） */
  label: string
  /** 悬浮说明（桌面菜单里的 tooltip；手机上多数平台不显示，故信息不能只写这里） */
  title: string
  /**
   * adj864：打勾（当前生效项）——「导出范围」那一组是**单选**，必须让用户一眼看出现在选的是哪个
   * （与显示模式/深浅模式那两组菜单同一做法）。
   */
  checked?: boolean
}

/** 菜单分组（组之间渲染成一条分隔线；组标题给移动端 Action Sheet 当小标题用） */
export interface ScoreMenuSection {
  title: string
  items: ScoreMenuItem[]
}

/**
 * 菜单模型的输入：**“这个面板现在有什么能力”**（由宿主经 `ScorePaneHost` 决定）。
 *
 * 刻意用「能力标志」而不是直接传 `ScorePaneHost`：模型不认识宿主类型，冒烟才好逐项断言；
 * 同时强迫调用方把"按钮存在与否"的判据**算一次**（渲染端照抄，不再各自重算）。
 */
export interface ScoreMenuContext {
  /** 是否移动端（决定「在应用中打开」这类**桌面专属**项是否出现） */
  isMobile: boolean
  /** 面板有写回入口（`host.writeSource`）⇒ 有「设置」（页面设置对话框） */
  hasWriteSource: boolean
  /** 有「格式化源码」入口（代码块宿主；`.jps` 文件视图的格式化在源码态的文件栏上） */
  hasFormat: boolean
  /** 有「在应用中打开」（桌面 + 有磁盘文件 + 没有更近的「编辑」入口） */
  hasAppOpen: boolean
  /** 嵌入模式下的谱面文件名（有值才给「打开谱面文件」） */
  embedTitle?: string
  /**
   * adj864：当前**导出范围**设置（`view` = 跟随视图）——「导出范围」那一组据此打勾。
   * 取值与插件设置同域（`types.ts` 的 `ExportRangeSetting`），这里用字面量联合避免跨模块耦合。
   */
  range: 'view' | 'page' | 'score'
  /**
   * adj864：`range === 'view'` 时"视图"当前是什么（'整页' / '满宽' / '谱面'）——
   * 写进菜单标签「跟随视图（谱面）」，让用户不点开也知道会按哪种口径复制/导出。
   */
  paneModeLabel?: string
  /**
   * adj912（用户 2026-10-13 定稿）：当前**图片分辨率**（`1` / `2` / `4`）——「分辨率」组据此打勾。
   * 取值与插件设置同域（`types.ts` 的 `ImageScaleSetting`），这里用字面量联合避免跨模块耦合。
   * 缺省值由调用方从 `types.ts` 的 `DEFAULT_IMAGE_SCALE` 取（**不许**在这里再写一个默认值）。
   */
  imageScale: 1 | 2 | 4
}

/**
 * 按能力标志生成菜单模型（**纯函数**：同一输入必得同一输出，便于断言与"三处共用"）。
 *
 * ## 分组口径（**adj912 用户 2026-10-13 定稿**，从上到下四组，组间分隔）
 *   · **显示**：设置（页面设置）—— 用户裁定 ①：「显示 / 设置」两项放**最上面单独一组**；
 *   · **操作**：复制图片 / 复制 SVG 文本 / 复制谱面源码 / 保存为 PNG / 保存为 SVG；
 *   · **分辨率**：1× / 2×（默认）/ 4×（单选打勾）—— 只对**位图**出口生效（复制图片、保存为 PNG），
 *     对 SVG **不生效**（矢量无分辨率，用户裁定 ④）；
 *   · **导出范围**（视图）：跟随视图 / 页面 / 谱面（单选打勾）—— 对**四个**出口都生效（用户裁定 ④）；
 *   之后的「源码」/「打开」两组照旧（能力标志决定建不建）。
 *
 * 后续要加东西**往这里加组**，不许在渲染端另加项（三处共用同一份模型）。
 */
export function buildScoreMenu(ctx: ScoreMenuContext): ScoreMenuSection[] {
  const sections: ScoreMenuSection[] = []

  // ——【第 0 组】显示 / 设置（用户 2026-10-13 定稿：单独一组、放最上面）——
  const display: ScoreMenuItem[] = []
  if (ctx.hasWriteSource) {
    display.push({
      id: 'settings',
      label: '设置',
      title: '页面设置：按字段精确设值（字体/字号/行距/渲染开关；可保存到谱面或存为插件默认）',
    })
  }
  if (display.length > 0) sections.push({ title: '显示', items: display })

  /**
   * ——【第 1 组】操作（adj912）——
   *
   * 「复制图片」用**第 2 组选中的分辨率**（`ctx.imageScale`，来自插件设置）；分辨率在 `title` 里写实，
   * 让用户不点开也知道会按多少 DPI 复制（与「跟随视图（谱面）」同一手法：把当前值写进文案）。
   *
   * ## 为什么位图出口**手机端不生成**（adj874 口径延续到 adj912）
   * 「复制图片」与「保存为 PNG」都要**取图**，而插件没有 canvas ⇒ 必须走**嵌入版 iJipu 应用**的
   * `render.png`，而嵌入版**只在桌面注册**（`main.ts` 里 `if (Platform.isDesktopApp) this.registerView(...)`；
   * `embed.ts` 的 `getEmbedUrl` 在手机直接 `return null`）⇒ 手机上点它**必然失败**，
   * 所以手机端**根本不出现**这两个入口（而不是让用户点了才知道不行）。
   * 「保存为 SVG」用户 2026-10-13 也明确裁定**手机端隐藏** ⇒ 一并进这两处平台守则。
   *
   * 手机端**能**用的出口：`copy-svg`（复制 SVG 文本）与 `copy-source`（复制谱面源码）——
   * 它们走**插件自己的引擎**（`api.renderSvg` / 纯文本），不经过嵌入版通道。
   */
  const ops: ScoreMenuItem[] = []
  if (!ctx.isMobile) {
    ops.push({
      id: 'copy-image',
      label: '复制图片',
      title: `按「分辨率」组选中的分辨率复制 PNG 图片到剪贴板（当前 ${ctx.imageScale}× ⇒ ${dpiForScale(ctx.imageScale)} DPI）`,
    })
  }
  ops.push(
    { id: 'copy-svg', label: '复制 SVG 文本', title: '复制这一份谱的 SVG 源码文本（矢量，可粘进支持 SVG 的编辑器）' },
    { id: 'copy-source', label: '复制谱面源码', title: '复制 `.jps` 源码文本（发给别人/存档）' },
  )
  if (!ctx.isMobile) {
    ops.push({
      id: 'save-png',
      label: '保存为 PNG',
      title: `存到谱面同一目录（分辨率按「分辨率」组，当前 ${ctx.imageScale}×）；同名不覆盖，自动加序号`,
    })
  }
  if (!ctx.isMobile) {
    ops.push({
      id: 'save-svg',
      label: '保存为 SVG',
      title: '存到谱面同一目录（矢量 ⇒ 不受分辨率影响）；同名不覆盖，自动加序号',
    })
  }
  sections.push({ title: '操作', items: ops })

  /**
   * ——【第 2 组】分辨率（adj912 用户裁定 ④）——
   *
   * 单选打勾、与设置页那一项是**同一个值**（`settings.imageScale`，L1 偏好 ⇒ 只存 `data.json`）。
   * 只作用于**位图**出口（「复制图片」「保存为 PNG」）；SVG 是矢量 ⇒ 不受影响（那两项的 `title` 已写明）。
   *
   * **只在菜单里真有吃分辨率的出口时**才给这一组：出口全是矢量/文本时（例如手机端没有图片出口），
   * 摆一排 1×/2×/4× 就是"点了没事发生"的死入口（本项目口径：不摆必失败的入口）。
   */
  const scale: ScoreMenuItem[] = [
    {
      id: 'scale-1',
      label: '1×',
      title: '1× ⇒ 72 DPI（体积最小）；作用于「复制图片」与「保存为 PNG」',
      checked: ctx.imageScale === 1,
    },
    {
      id: 'scale-2',
      label: '2×（默认）',
      title: '2× ⇒ 144 DPI（默认，常见文档插图足够清晰）；作用于「复制图片」与「保存为 PNG」',
      checked: ctx.imageScale === 2,
    },
    {
      id: 'scale-4',
      label: '4×',
      title: '4× ⇒ 288 DPI（最清晰、体积最大）；作用于「复制图片」与「保存为 PNG」',
      checked: ctx.imageScale === 4,
    },
  ]
  if (ops.some((i) => i.id === 'copy-image' || i.id === 'save-png')) {
    sections.push({ title: '分辨率', items: scale })
  }

  /**
   * ——【第 3 组】导出范围（adj864 定稿；adj912 起组名与文案**保持不变**）——
   *
   * 跟随视图 / 页面 / 谱面 —— 单选，当前项打勾。
   *
   * 与设置页的那一项是**同一个值**（`settings.exportRange`）：这里改、那里也变（反之亦然）。
   * `view` 的标签把"当前视图是什么"写实（「跟随视图（谱面）」），因为它的含义完全取决于所在面板的显示模式。
   * 对**四个**出口都生效：复制图片 / 保存为 PNG（走 `resolveRangeBox` + `params.crop`）、
   * 复制 SVG 文本 / 保存为 SVG（走 `applyExportRange`）。
   */
  const rangeView = ctx.paneModeLabel ? `跟随视图（${ctx.paneModeLabel}）` : '跟随视图'
  const range: ScoreMenuItem[] = [
    {
      id: 'range-view',
      label: rangeView,
      title: '按当前显示模式决定画布口径：谱面模式 ⇒ 墨迹 + 每边 2px；整页/满宽 ⇒ 整页',
      checked: ctx.range === 'view',
    },
    {
      id: 'range-page',
      label: '页面（整页 + 留白）',
      title: '导出/复制**整页**（A4 等）+ 四周留白',
      checked: ctx.range === 'page',
    },
    {
      id: 'range-score',
      label: '谱面（墨迹 + 每边 2px）',
      title: '导出/复制**墨迹包围盒 + 每边 2px**（不保留页宽，最小边界）',
      checked: ctx.range === 'score',
    },
  ]
  sections.push({ title: '导出范围', items: range })

  const source: ScoreMenuItem[] = []
  if (ctx.hasFormat) {
    source.push({
      id: 'format',
      label: '格式化源码',
      title: '按应用规范格式化源码（音符/小节线空格、歌词里的 {tp … } 段、描述头属性）',
    })
  }
  if (source.length > 0) sections.push({ title: '源码', items: source })

  const open: ScoreMenuItem[] = []
  // 移动端**不给**「在应用中打开」：嵌入版 iJipu 的视图只在桌面注册（见 embed.ts），
  // 手机上点它只会得到一句"仅桌面端可用" ⇒ 直接不出现，而不是让用户点了才知道。
  if (ctx.hasAppOpen && !ctx.isMobile) {
    open.push({ id: 'app-open', label: '在应用中打开', title: '用系统默认应用（关联的 iJipu 桌面版）打开这份谱' })
  }
  if (ctx.embedTitle) {
    open.push({ id: 'embed-link', label: '打开谱面文件', title: `在库内打开这份谱：${ctx.embedTitle}` })
  }
  if (open.length > 0) sections.push({ title: '打开', items: open })

  return sections
}

/** 取菜单里所有动作 id（按渲染顺序）——渲染端做诊断、冒烟做断言都用它 */
export function scoreMenuIds(sections: readonly ScoreMenuSection[]): ScoreMenuActionId[] {
  return sections.flatMap((s) => s.items.map((i) => i.id))
}

/** 菜单里有没有某个动作（冒烟的正/负对照都读它，避免各写一遍 `some(...)`） */
export function hasScoreMenuItem(sections: readonly ScoreMenuSection[], id: ScoreMenuActionId): boolean {
  return scoreMenuIds(sections).includes(id)
}

/**
 * 工具条的平台策略（T-5 移动端口径）。
 *
 * 为什么要有它：这些数值以前散在 `scorePane.ts`（`Platform.isMobile` 分支）与 `styles.css`
 * 两处，改一处忘一处就会"手机上按钮还是 30px / 还是会自己消失"。现在**一处定义**：
 * 渲染端消费 `autoHideMs` / `contextMenu`，样式端消费 `minTargetPx`（CSS 里的 44px 由冒烟比对）。
 */
export interface ToolbarPolicy {
  /** 触控目标最小边长（px）——移动端 44（用户口径），桌面取样式基线 24（鼠标精度高，不必放大） */
  minTargetPx: number
  /** 无操作后自动收起工具条的延迟（ms）；**0 = 常驻不自动收起**（移动端：没有 hover，收起后要点回来） */
  autoHideMs: number
  /** 是否用"指针悬停/移出"驱动显隐（两端都 false：adj785 起统一改为点击预览区切换） */
  hoverHide: boolean
  /** 点击预览区切换显隐（两端都 true——这是唯一的手动开关） */
  toggleOnClick: boolean
  /** 是否提供右键菜单入口（手机没有右键、长按被宿主占用 ⇒ 移动端只靠 `⋯ 更多`） */
  contextMenu: boolean
  /**
   * 按钮**文字标签**怎么显示（adj905y，用户口径：「手机端统一使用只图标」）。
   *
   *  · `'hidden'` —— **一律只图标**（手机端）：屏幕窄、触控目标就那么大，文字会把工具条挤到换行；
   *    图标含义由 `title` 与「⋯ 更多」菜单里的文字兜住；
   *  · `'byWidth'` —— **按容器宽度**（桌面端）：`.ijipu-score` 窄于 400px 时由 `@container` 隐藏文字
   *    （侧栏 / 分栏里的嵌入也判断正确），宽度够就带文字。
   *
   * ⚠ 为什么要有这个字段、而不是只留 CSS：文字标签原来是**纯容器查询**决定的，
   * 而工具条显示时会被搬到 `document.body`（`adj793c`，为了不被祖先裁剪/盖住）——
   * 那一刻**容器查询失效** ⇒ 同一条工具条"收起时只图标、点开却带文字"（用户实测 ✗）。
   * 现在把"这个平台要不要文字"这个**结论**随元素带走（打一个类），与搬不搬出去无关。
   */
  labelMode: 'hidden' | 'byWidth'
}

/** 桌面：挂载后显示一次，3 秒无操作自动收起（`adj785` 的用户口径） */
export const DESKTOP_AUTO_HIDE_MS = 3000
/**
 * 移动端触控目标下限（宽度，px）。
 *
 * 口径变迁（都有用户实测依据）：
 *  · 改动前实际 21–30px ⇒ 用户反馈"手指偏小" ⇒ 提到 44px；
 *  · 2026-10-11 真机再看 ⇒ 用户反馈"**偏大**"，定为 **32px 宽**（高度另给、比宽度更小 ⇒ `MOBILE_CTL_H_PX`）。
 * 40 与 44 都不再使用；`styles.css` 的取值由冒烟与这里比对（单一来源）。
 */
export const MOBILE_MIN_TARGET_PX = 32
/** 移动端控件**高度**（用户 2026-10-11："32px 宽，高度也可以更小一些"） */
export const MOBILE_CTL_H_PX = 28
/** 桌面控件高度（与 `styles.css` 基础块的 `--ijipu-ctl-h: 24px` 同口径） */
export const DESKTOP_MIN_TARGET_PX = 24

/** 取某平台的工具条策略（纯函数：同参数必同结果，冒烟直接断言） */
export function toolbarPolicy(isMobile: boolean): ToolbarPolicy {
  return {
    minTargetPx: isMobile ? MOBILE_MIN_TARGET_PX : DESKTOP_MIN_TARGET_PX,
    autoHideMs: isMobile ? 0 : DESKTOP_AUTO_HIDE_MS,
    hoverHide: false,
    toggleOnClick: true,
    contextMenu: !isMobile,
    /**
     * adj905y（用户口径）：「手机端统一使用只图标」——手机端**一律**隐藏文字标签（不再看容器宽度）；
     * 桌面端保持"按宽度"（窄容器才图标化），见 `ToolbarPolicy.labelMode` 的说明。
     */
    labelMode: isMobile ? 'hidden' : 'byWidth',
  }
}
