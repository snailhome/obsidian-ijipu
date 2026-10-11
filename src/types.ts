import type { PageConfig } from '@ijipu/engine'

/**
 * 插件全局设置：继承 iJipu PageConfig 的渲染项（四组：页面/字体/行距/渲染）。
 * 未设置时由 defaultPageConfig 兜底；笔记 frontmatter（ijipu_*）再覆盖。
 */
export type IJipuSettings = Partial<PageConfig> & {
  /** 默认音色（GM program；null=按声部名自动路由，adj352） */
  hqVoice?: number | null
  /** 收藏音色（GM program 集合；试听可选，默认常用音色） */
  hqEnabled?: number[]
  /**
   * adj724b（嵌入版）：是否启用**嵌入的完整 iJipu**。
   *
   * 打开后：左侧栏出现「爱记谱」图标、打开 `.jps` 用完整编辑器（`embed/appView.ts`）、
   * 并以当前文库为工作区。关闭后一切回到原来的轻量渲染（`.jps` → textarea + SVG 预览）。
   *
   * 注意：这是**界面偏好**（与具体谱无关），按 `docs/SETTINGS-AUDIT.md` 的分层属 **L1**，
   * 因此**不能**放进 `defs.ts` 的 `DEFS`（那里的键被钉死为 `keyof PageConfig`），
   * 也不能写进谱面源码。
   */
  embedIjuipu?: boolean
  /**
   * 嵌入版的工作区子目录（vault 相对路径；留空 = **vault 根**）。
   * 例：`乐谱` ⇒ 文件树只显示 `乐谱/` 下的 `.jps`。
   */
  embedRoot?: string
  /** 嵌入版是否跟随 Obsidian 主题（默认开） */
  embedFollowTheme?: boolean
  /**
   * adj724b（用户要求）：**打开 `.jps` 的方式**。
   *
   * 用户原话：「在嵌入版页签中添加一个下拉列表选择，默认打开方式，添加以下几个打开方式选择：
   * ① 右侧栏 ② 新的页签 ③ 当前页签 ④ 默认应用；并实现相应的打开方式，**默认选择为右侧栏**」。
   *
   * - `right`：在**右侧边栏**打开嵌入版（默认；不抢主编辑区，适合边看谱边写笔记）
   * - `tab`：在主编辑区**新建页签**
   * - `current`：用**当前页签**（会替换掉当前页签的内容）
   * - `defaultApp`：交给**系统默认应用**（桌面端；即"外部编辑"）
   */
  embedOpenMode?: EmbedOpenMode
  /**
   * adj863（T-3 定稿）：**导出范围**。
   *
   *  · `page`（**默认**）：导出**页面** —— 整页 + 四周留白（与改动前的行为完全一致 ✓）；
   *  · `score`：导出**谱面** —— **墨迹包围盒 + 每边 2px**（不保留页宽）；
   *  · `view`（adj864）：**跟随视图** —— 谱面模式 ⇒ 按 `score`；整页/满宽 ⇒ 按 `page`。
   *
   * 几何**不在插件里算**：一律走引擎 `rangeBox()`（应用与 CLI 同一份口径 ✓）。墨迹盒只能用真实 DOM
   * 量（面板里量过就把结果挂在插件上，见 `IJipuPlugin.lastInk`）⇒ `score` 范围**量不到就明确报错**，
   * 绝不猜一个盒出来（`E-2026-*` 那类"导出成一条横带"的由来）。
   *
   * 属 **L1 界面/偏好**（与具体谱无关、不随谱走）⇒ 不进 `defs.ts` 的 `DEFS`、不写进谱面源码。
   */
  exportRange?: ExportRangeSetting
  /**
   * adj868（用户要求）：**嵌入版通道**总开关（原来叫「开发者：允许嵌入版调用插件能力」）。
   *
   * 它不是只给开发者用的东西 —— 它是「嵌入版 iJipu（应用）↔ 插件」**两条** postMessage 通道的总开关：
   *  · **插件 → 应用**：`render.svg`（探活）、`render.png`、`export.midi`、`playback.play|stop`
   *    ⇒ **「导出 PNG」「导出 MIDI」「复制为图片」必经**（渲染要用应用里的画布、合成要用应用里的音色库）；
   *  · **应用 → 插件**：`engine.version`、`capabilities`、`render.svg`
   *    ⇒ 目前**应用侧没有调用方**（`__ijipuRpcRequest` 在应用仓库 grep 为空），是给将来/第三方留的能力面。
   *
   * **默认 false**（安全优先）：这条通道能让"页面里的代码"驱动宿主；打开后仍只认
   * **本插件自己打开的那个嵌入版窗口**（来源校验，不符就静默忽略）+ 方法白名单 + 参数逐项校验。
   *
   * adj868 起由"仅本会话有效"改为**持久化**（L1 界面偏好，存插件 `data.json`）——
   * 用户要求"别每次重启都要点一次"。关着时**不影响**导出 SVG / 复制 SVG 文本（那两条走插件自己的引擎）。
   */
  embedChannel?: boolean
}

/** 导出范围（见 `IJipuSettings.exportRange`）：跟随视图 / 页面 / 谱面 */
export type ExportRangeSetting = 'view' | 'page' | 'score'

/**
 * 导出范围的默认值：**跟随视图**（`view`）—— **用户 2026-10-11 定稿**（`adj873`）。
 *
 * ## 现在的口径（用户 2026-10-11 明确要求改成 `view`）
 * 「导出/复制出来的画布口径，默认就与我**看到的**一致」：预览里显示的是「谱面」（墨迹包围盒）
 * 就按谱面导出，显示「整页 / 满宽」就按整页导出 —— 不必每次先去菜单里手动挑一次。
 *
 * ## 旧口径（`page`，`adj863` / `adj864` 时的裁决）—— 留在这里说明**当初为什么那样选、又为什么改**
 * 原来刻意默认 `page`（= 与改动前的导出逐字一致）：面板的**初始显示模式就是「谱面」**，
 * 若默认跟随视图，则"从谱面模式导出"会**静默变成裁过的图** ✗ —— 老用户升级后导出尺寸突变、
 * 却看不出是谁改的；那时跟随视图是**可选**口径，用户明确选了才生效。
 *
 * 现在改成 `view`，是**用户重新拍板**的结果：他明确要"默认跟随视图"（`2026-10-11`）。
 * 代价（从谱面模式导出的尺寸与旧默认不同）由两处**可见**兜住：菜单「导出范围」组与设置页那一项
 * 都把**当前值打勾/选中**，用户一眼能看出按哪种口径导出，也能就地改回 `page` 或 `score` ✓。
 */
export const DEFAULT_EXPORT_RANGE: ExportRangeSetting = 'view'

/**
 * 嵌入版通道（`IJipuSettings.embedChannel`）的默认值：**关闭**。
 *
 * 为什么默认关（沿用当初的裁决 ③）：这条通道能让嵌入版页面里的代码驱动插件做事
 * ⇒ 「默认安全」优先于「省一次点击」。用户在设置里打开一次后**会记住**（`adj868` 起持久化）。
 */
export const DEFAULT_EMBED_CHANNEL = false

/** 打开 `.jps` 的方式（见 `IJipuSettings.embedOpenMode`） */
export type EmbedOpenMode = 'right' | 'tab' | 'current' | 'defaultApp'

/** 默认打开方式——用户指定为**右侧栏** */
export const DEFAULT_EMBED_OPEN_MODE: EmbedOpenMode = 'right'
