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
}

/** 导出范围（见 `IJipuSettings.exportRange`）：跟随视图 / 页面 / 谱面 */
export type ExportRangeSetting = 'view' | 'page' | 'score'

/**
 * 导出范围的默认值：**页面**（保持既有行为）。
 *
 * 为什么不默认 `view`（虽然 T-5 的菜单把「跟随视图」列在第一项）：面板的**初始显示模式就是「谱面」**，
 * 若默认跟随视图，则"从谱面模式导出"会**静默变成裁过的图** ✗ —— 老用户升级后导出尺寸突变、
 * 却看不出是谁改的。跟随视图是**可选**口径，用户明确选了才生效（菜单里一眼能看到当前选的是哪个）。
 */
export const DEFAULT_EXPORT_RANGE: ExportRangeSetting = 'page'

/** 打开 `.jps` 的方式（见 `IJipuSettings.embedOpenMode`） */
export type EmbedOpenMode = 'right' | 'tab' | 'current' | 'defaultApp'

/** 默认打开方式——用户指定为**右侧栏** */
export const DEFAULT_EMBED_OPEN_MODE: EmbedOpenMode = 'right'
