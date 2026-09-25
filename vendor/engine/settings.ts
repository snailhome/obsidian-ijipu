/**
 * engine/settings.ts — 谱面级设置持久化（adj83）
 *
 * 每份简谱可把自己的页面设置（PageConfig + metaPos）保存在源码的
 * `# jps-config:{...}` 单行 JSON 注释里，保证「这首谱用自己的设置」；
 * 源码里没有该注释时回退公共设置（localStorage）。
 *
 * 语法：`# jps-config:{"page":"A4","margin_top":80,...,"metaPos":{...}}`
 *  - 识别：行首 `#` + 空白 + `jps-config:` 前缀
 *  - 保存：覆盖已有该行；**默认差量写入**（只写与 `defaultPageConfig` 不同的字段），
 *    无差量则**删除该行**；`{ mode: 'full' }` 才写全量（「固化全部设置到谱面」用）
 *
 * 分层（见 docs/SETTINGS-AUDIT.md）：**编辑器偏好（editorFont/editorFontSize）不属于谱面级**，
 * 早期版本曾把它们写进这里（TopBar 改字号即写文件），导致"把 .jps 发给别人、别人的编辑器字体被改"。
 * 现已从 `PageConfig` 移除 → 编解码两侧都不会再出现。
 *
 * adj454（用户确认「优先级 = 源码设置 > 缓存设置 > 默认设置」后的一轮加固）：
 *  ① **读取优先级**：`mergeJpsConfig` 的展开顺序即 `默认 → 公共设置(缓存) → 源码`，源码最后展开故最高优先；
 *  ② **写回只有用户改动**：`mergeConfigEdits` 以「本次编辑开始前的生效配置」为基线，只把**用户真正改过**
 *     的字段并入源码层——缓存（L1）来源的值不再被固化进谱面（此前点一次「保存设置」就会把本机设置写进别人的谱）；
 *  ③ **读取端类型校验**：坏 JSON / 类型不对的值 / 拼错的键不再静默生效或静默丢弃，统一由
 *     `inspectJpsConfig` 给出**带行号的告警**（解析器把它并进 `ParseResult.errors` → 应用问题条 + 状态栏橙点）。
 */
import { defaultPageConfig, PAPER_SIZE } from './types'
import { normalizeFontStack, SCORE_FONT_FIELDS, type EditorPrefs } from './fonts'
import type { PageConfig } from './types'

/** # jps-config 注释行前缀 */
export const JPS_CONFIG_PREFIX = '# jps-config:'

/**
 * 不在 `defaultPageConfig` 对象上的**可选字段**：写回 `# jps-config` 后读回时必须保留，
 * 否则「显示乐器名 / 歌词压缩 / 描述头位置」这类设置保存后重开即失效。
 *
 * adj382：补 `showInstrument`——它此前漏在白名单外（`defaultPageConfig` 里没有它，
 * 又不是显式白名单项），于是 `writeJpsConfig` 明明写进了 30 个字段，`extractJpsConfig`
 * 只读回 29 个，App 勾选「显示乐器名」保存后重新打开就丢（同类"设置不生效"）。
 * 下面的编译期断言保证**引擎新增可选字段时此处必须同步**（否则 tsc 报错）。
 */
const OPTIONAL_CONFIG_FIELDS = ['heights', 'metaPos', 'lyricShrink', 'showInstrument', 'segmentRowGap'] as const

/** PageConfig 中的可选字段集合 */
type OptionalConfigKey = {
  [K in keyof PageConfig]-?: undefined extends PageConfig[K] ? K : never
}[keyof PageConfig]
/** 编译期完整性断言：可选字段未列入 OPTIONAL_CONFIG_FIELDS 时报错（`never` 不可赋给 `true`） */
export const _OPTIONAL_CONFIG_FIELDS_COMPLETE: Exclude<
  OptionalConfigKey,
  (typeof OPTIONAL_CONFIG_FIELDS)[number]
> extends never
  ? true
  : never = true

/** 可写入/读回的字段名集合（= 默认字段 ∪ 可选字段） */
const CONFIG_FIELDS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(defaultPageConfig),
  ...OPTIONAL_CONFIG_FIELDS,
])

/** 早期版本误写进谱面的**编辑器偏好键**（读到即迁移到 L1，之后不再写回） */
const LEGACY_EDITOR_KEYS = ['editorFont', 'editorFontSize'] as const

/** 取源码里 `# jps-config:` 行与它的行号（1-based；无则 null） */
function findConfigLine(code: string): { raw: string; lineNo: number } | null {
  const lines = code.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(JPS_CONFIG_PREFIX)) return { raw: lines[i], lineNo: i + 1 }
  }
  return null
}

/**
 * 设置行的告警（adj454）：line/col 为 1-based/0-based（与 `ParseError` 一致，col 0 = 行首），
 * 端侧据此在问题条里定位到 `# jps-config:` 那一行。
 */
export interface JpsConfigIssue {
  line: number
  col: number
  severity: 'error' | 'warning'
  message: string
  hint?: string
}

/** 设置行的正确写法（告警里的「正确写法」提示，与 docs/SYNTAX.md 口径一致） */
const CONFIG_LINE_HINT =
  '设置行形如 `# jps-config:{"margin_top":40,"note_size":15}`：**顶格**写在最后，值为 JSON 对象、' +
  '键必须是可识别的设置项（数值项写数值、布尔项写 true/false、字体项写字体栈字符串）。' +
  '一般不用手写——在「设置 → 谱面」里改完点「保存设置」即可。'

/** 值预览（告警文案里展示"当前是什么"） */
function preview(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s.length > 24 ? `${s.slice(0, 24)}…` : s
  } catch {
    return String(v)
  }
}

/**
 * 单个设置项的值校验（adj454）：通过返回 null，否则返回「应为…」的中文说明。
 * 数值项要求有限数（`"abc"` / `null` / `NaN` 一律拒绝——此前会被原样用于排版）；字符串项要求字符串；
 * 枚举项（纸张 / 布局模式 / 连音线样式）要求取值在枚举内；嵌套对象逐层校验。
 */
function expectDescOf(key: string, v: unknown): string | null {
  switch (key) {
    case 'page': {
      const ok = typeof v === 'string' && Object.prototype.hasOwnProperty.call(PAPER_SIZE, v)
      return ok ? null : '纸张名（A4 / A5 / A4_horizontal / A5_horizontal）'
    }
    case 'noteSpaceLayout':
      return v === 'space' || v === 'duration' ? null : '"space"（空间优先）或 "duration"（时值优先）'
    case 'lianyinxian_type':
      return v === 0 || v === 1 || v === 2 ? null : '0 / 1 / 2'
    case 'lyricShrink':
    case 'showInstrument':
      return typeof v === 'boolean' ? null : 'true / false'
    case 'segmentRowGap': {
      // adj629：加 `tp`（替谱段与所属歌词行的间距）
      const shape = '对象 {"bz":数值,"dsb":数值,"tp":数值}'
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return shape
      for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
        if (k !== 'bz' && k !== 'dsb' && k !== 'tp') return shape
        if (typeof n !== 'number' || !Number.isFinite(n)) return shape
      }
      return null
    }
    case 'metaPos': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return '对象 {"标题键":{"x":数值,"y":数值}}'
      for (const p of Object.values(v as Record<string, unknown>)) {
        if (typeof p !== 'object' || p === null) return '对象 {"标题键":{"x":数值,"y":数值}}'
        const { x, y } = p as { x?: unknown; y?: unknown }
        if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
          return '对象 {"标题键":{"x":数值,"y":数值}}'
        }
      }
      return null
    }
    case 'heights': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return '对象 {"页码":[曲部,词部,曲词,声部(,曲词下部)]}'
      for (const arr of Object.values(v as Record<string, unknown>)) {
        if (!Array.isArray(arr) || arr.length < 4 || arr.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
          return '对象 {"页码":[曲部,词部,曲词,声部(,曲词下部)]}'
        }
      }
      return null
    }
    default: {
      // 其余按 `defaultPageConfig` 上的类型判定（数值项 / 字符串项）
      const d = (defaultPageConfig as unknown as Record<string, unknown>)[key]
      if (typeof d === 'number') return typeof v === 'number' && Number.isFinite(v) ? null : '数值'
      if (typeof d === 'string') return typeof v === 'string' ? null : '字符串'
      if (typeof d === 'boolean') return typeof v === 'boolean' ? null : 'true / false'
      return null
    }
  }
}

/**
 * 解析 + 校验一行设置（adj454 的内部收敛点）：返回**可用字段**与**全部告警**。
 * `extractJpsConfig` / `inspectJpsConfig` / `inspectJpsConfigLine` 三者共用，保证"能读到的"与"会告警的"
 * 永远出自同一套规则（此前只有"白名单过滤"，坏值会被静默放行或静默丢弃）。
 */
function readConfigLine(raw: string, lineNo: number): { config: Partial<PageConfig>; issues: JpsConfigIssue[] } {
  const issues: JpsConfigIssue[] = []
  const jsonText = raw.trim().slice(JPS_CONFIG_PREFIX.length).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    issues.push({
      line: lineNo,
      col: 0,
      severity: 'warning',
      message: `设置行 JSON 无法解析（${detail}）——**整行设置已忽略**，本机公共设置（或默认值）生效`,
      hint: CONFIG_LINE_HINT,
    })
    return { config: {}, issues }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    issues.push({
      line: lineNo,
      col: 0,
      severity: 'warning',
      message: `设置行必须是 JSON 对象（形如 \`{...}\`），当前是${Array.isArray(parsed) ? '数组' : typeof parsed}——整行设置已忽略`,
      hint: CONFIG_LINE_HINT,
    })
    return { config: {}, issues }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    // 旧版误写进谱面的编辑器偏好：由 extractLegacyEditorPrefs 单独迁移，这里不算"拼错"、不告警
    if ((LEGACY_EDITOR_KEYS as readonly string[]).includes(k)) continue
    if (!CONFIG_FIELDS.has(k)) {
      issues.push({
        line: lineNo,
        col: 0,
        severity: 'warning',
        message: `设置行里的 \`${k}\` 不是可识别的设置项（值 ${preview(v)}）——已忽略，请检查拼写`,
        hint: CONFIG_LINE_HINT,
      })
      continue
    }
    if (v === null || v === undefined) continue // 显式 null = 未设置，按未写入处理（回退下一层）
    const expect = expectDescOf(k, v)
    if (expect) {
      issues.push({
        line: lineNo,
        col: 0,
        severity: 'warning',
        message: `设置行里的 \`${k}\` 值不合法：应为${expect}，当前是 ${preview(v)}——该项已忽略，回退下一层设置（宿主默认 / 代码默认值）`,
        hint: CONFIG_LINE_HINT,
      })
      continue
    }
    // 字体：旧文件里常是裸字体名（如 "SimHei"）——统一补 fallback 链，避免换机器掉到浏览器默认字体
    out[k] = (SCORE_FONT_FIELDS as readonly string[]).includes(k) && typeof v === 'string' ? normalizeFontStack(v) : v
  }
  return { config: out as Partial<PageConfig>, issues }
}

/** 校验**任意一行**设置行文本（供解析器逐行调用；行号 1-based）。非设置行返回空数组 */
export function inspectJpsConfigLine(rawLine: string, lineNo: number): JpsConfigIssue[] {
  if (!rawLine.trim().startsWith(JPS_CONFIG_PREFIX)) return []
  return readConfigLine(rawLine, lineNo).issues
}

/** 校验源码里的设置行（无该行返回空数组）——解析器把它并进 `ParseResult.errors` 展示给用户 */
export function inspectJpsConfig(code: string): JpsConfigIssue[] {
  const found = findConfigLine(code)
  return found ? readConfigLine(found.raw, found.lineNo).issues : []
}

/**
 * 从源码中提取谱面级设置（无该注释返回 null）。
 * 只取白名单字段且**逐项校验类型**（adj454：不合法/拼错的项被忽略并另行告警）；
 * 损坏的 JSON 静默返回 null（告警由 `inspectJpsConfig` 负责）；字体字段做 fallback 补全。
 */
export function extractJpsConfig(code: string): Partial<PageConfig> | null {
  const found = findConfigLine(code)
  if (!found) return null
  // JSON 坏掉时整体失效（返回 null，回退公共设置）——与告警文案口径一致
  const jsonText = found.raw.trim().slice(JPS_CONFIG_PREFIX.length).trim()
  try {
    JSON.parse(jsonText)
  } catch {
    return null
  }
  return readConfigLine(found.raw, found.lineNo).config
}

/**
 * 读取**旧版**误写进谱面的编辑器偏好（用于一次性迁移到 L1 缓存）。
 * 只读原始 JSON（不走白名单），因为这两个键已不属于 `PageConfig`。
 */
export function extractLegacyEditorPrefs(code: string): Partial<EditorPrefs> | null {
  const found = findConfigLine(code)
  if (!found) return null
  try {
    const obj = JSON.parse(found.raw.slice(JPS_CONFIG_PREFIX.length).trim()) as Record<string, unknown>
    const out: Partial<EditorPrefs> = {}
    for (const k of LEGACY_EDITOR_KEYS) {
      const v = obj[k]
      if (k === 'editorFont' && typeof v === 'string' && v.trim() !== '') out.font = v
      if (k === 'editorFontSize' && typeof v === 'number' && Number.isFinite(v)) out.fontSize = v
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * adj413：把谱面设置里的 **px 值统一取整**（四舍五入）。覆盖三类：
 *  ① 顶层数值字段（边距 / 间距 / 字号 / 条数）——非数值字段（字符串、枚举、字体栈）原样保留；
 *  ② 按页行距 `heights`（数组里每个数）；
 *  ③ 描述头自定义位置 `metaPos` 的 `x` / `y`。
 *
 * 由来：虚线拖拽的位移天生是浮点（鼠标位移 ÷ 预览缩放），过去会把 `12.4` 这类值写进
 * `# jps-config`（`metaPos` 更是刻意保留到 0.1px）；用户要求**设置与间距里的 px 一律整数**。
 * 这里放在引擎层做，并在**读取（mergeJpsConfig）与写入（writeJpsConfig）两端各过一遍**：
 * 于是旧文件里已有的小数值一读出来就是整数，新写入的也一定是整数。
 */
export function roundPxIntegers(cfg: Partial<PageConfig>): Partial<PageConfig> {
  const out = { ...(cfg as unknown as Record<string, unknown>) }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v)
  }
  if (cfg.heights) {
    const h: Record<string, [number, number, number, number, number?]> = {}
    for (const [k, arr] of Object.entries(cfg.heights)) {
      // heights 每项是 [quci, cici, ciqu, shengbu, ciquLyric?]（末位可选，adj79 兼容旧存储）
      const rounded = arr.map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : n))
      h[k] = rounded as [number, number, number, number, number?]
    }
    out.heights = h
  }
  if (cfg.metaPos) {
    const p: Record<string, { x: number; y: number }> = {}
    for (const [k, v] of Object.entries(cfg.metaPos)) {
      p[k] = { x: Math.round(v.x), y: Math.round(v.y) }
    }
    out.metaPos = p
  }
  // adj432（E-2026-172）：`segmentRowGap`（adj428 新增的**嵌套数值对象**）同样要取整——
  // 此前只处理了 heights / metaPos，漏了它：手改的 `"segmentRowGap":{"bz":22.5}` 会原样保留小数，
  // 与「设置与间距里的 px 一律整数」的约定不一致（应用内写入虽已取整，读入端却不归一化）。
  // 注意：**以后新增嵌套数值字段必须在这里补一段**（无编译期断言兜底，只能靠这条注释 +
  // smoke 断言；下面的 smoke 用例覆盖 segmentRowGap）。
  if (cfg.segmentRowGap) {
    const g: { bz?: number; dsb?: number; tp?: number } = {}
    const bz = cfg.segmentRowGap.bz
    const dsb = cfg.segmentRowGap.dsb
    const tp = cfg.segmentRowGap.tp // adj629：替谱段间距
    if (typeof bz === 'number' && Number.isFinite(bz)) g.bz = Math.round(bz)
    if (typeof dsb === 'number' && Number.isFinite(dsb)) g.dsb = Math.round(dsb)
    if (typeof tp === 'number' && Number.isFinite(tp)) g.tp = Math.round(tp)
    out.segmentRowGap = g
  }
  return out as unknown as Partial<PageConfig>
}

/**
 * 合并谱面设置：**源码 # jps-config 优先，其次公共设置（localStorage 缓存），兜底默认**。
 * 展开顺序即优先级（源码最后展开、覆盖前两层）——adj454 起在注释里写明，并有用例锁定该顺序。
 * adj413：合并结果统一取整（px 一律整数），旧文件里的小数值读出来即为整数。
 * @param code 源码
 * @param fallback 公共设置（null 表示无 → 用默认）
 */
export function mergeJpsConfig(
  code: string,
  fallback: PageConfig | null,
): PageConfig {
  const embedded = extractJpsConfig(code)
  // 合并结果一定是完整配置（defaultPageConfig 打底），故这里收回 PageConfig 类型
  return roundPxIntegers({
    ...defaultPageConfig,
    ...(fallback ?? {}),
    ...(embedded ?? {}),
  }) as PageConfig
}

/** 写入模式：diff = 只写与默认不同的字段（默认）｜full = 固化全部字段 */
export type JpsConfigWriteMode = 'diff' | 'full'

/**
 * adj480：**谱面自包含检查**——列出「生效值与代码默认值不同、但谱面 `# jps-config` 没写（或写得不一样）」的字段。
 *
 * 为什么需要：`.jps` 要能"复制给别人也一模一样"，就必须**自包含**——凡影响外观的值都得写在谱面里。
 * 应用侧已在 adj480 取消「本机页面设置」这一层（生效 = 代码默认 ← 谱面），所以应用里这里恒为 `ok`；
 * **宿主侧**（如 Obsidian 插件的插件设置 / 笔记 frontmatter）仍是"隐藏默认层"，这份检查把差异显式化，
 * 供"复制给他人前先随谱固化"的提示使用。
 *
 * @param code 源码
 * @param effective 当前生效配置（宿主默认 + 谱面合并后的结果）
 */
export function configCarryover(
  code: string,
  effective: PageConfig,
): { ok: boolean; missing: { key: string; value: unknown }[] } {
  const embedded = (extractJpsConfig(code) ?? {}) as unknown as Record<string, unknown>
  const eff = effective as unknown as Record<string, unknown>
  const def = defaultPageConfig as unknown as Record<string, unknown>
  const missing: { key: string; value: unknown }[] = []
  for (const k of CONFIG_FIELDS) {
    const v = eff[k]
    if (v === undefined || v === null) continue
    // 与代码默认值一致 → 不需要随谱携带（对方也用同一个默认值）
    if (sameValue(v, def[k])) continue
    // 谱面已写且与本机生效值一致 → 已随谱携带
    if (k in embedded && sameValue(embedded[k], v)) continue
    missing.push({ key: k, value: v })
  }
  return { ok: missing.length === 0, missing }
}

/**
 * 深比较（只用于判断"是否与默认值相同"，值都是原始类型/小对象）。
 *
 * adj606（用户反馈"乐器显示复选框点击时 `*` 没有变化"）：**可选布尔字段的"关"有两种写法**——
 * `false`（复选框取消时写的）与 `undefined`（`defaultPageConfig` 里根本没这个字段 = 未设置）。
 * 渲染侧一律按 `=== true` 判定（`showInstrument`/`lyricShrink` 都是），所以两者是**同一个状态**；
 * 若把它们当成不同，`false` 会永远算作"与默认不同"：面板上的红色 `*` 取消勾选后也不熄灭，
 * 保存时还会往文件里写一条冗余的 `false`。
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // adj606：未设置 ↔ 显式关闭（仅布尔；`0`/`''` 这类"假值"不在此列——它们语义上确实与未设置不同）
  if ((a === false && b === undefined) || (a === undefined && b === false)) return true
  if (a === null || b === null || a === undefined || b === undefined) return a === b
  if (typeof a !== 'object' || typeof b !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 挑出要写入的字段：
 *  - `full`：全部可写字段（含 `metaPos`/`heights`/可选开关等非默认字段）；
 *  - `diff`：只保留与 `defaultPageConfig` 不同的字段——文件更干净，且**不会被旧默认永久钉住**
 *    （默认值将来改得更合理时，未显式设置过的谱会跟着变好）。
 * 两种情况都只写白名单字段（编辑器偏好等非谱面项永远不会出现）。
 * adj454：`cfg` 放宽为 `Partial<PageConfig>`——写回时传的是「源码层配置」（见 `mergeConfigEdits`），
 * 它天然可能只含少数字段，缺的项由 `undefined` 跳过而不是补默认值。
 */
function pickWritableConfig(cfg: Partial<PageConfig>, mode: JpsConfigWriteMode): Record<string, unknown> {
  const src = cfg as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of CONFIG_FIELDS) {
    const v = src[k]
    if (v === undefined || v === null) continue
    if (mode === 'diff' && sameValue(v, (defaultPageConfig as unknown as Record<string, unknown>)[k])) continue
    out[k] = v
  }
  return out
}

/**
 * adj605（用户要求）：列出 `cfg` 里**与代码默认值不同**的字段——设置面板据此在标签后加红色 `*`。
 *
 * 判据与写盘**同一份**（`pickWritableConfig(cfg, 'diff')` 的键集）⇒ 面板上"带了 `*`"严格等价于
 * "点「保存设置」后会写进这份谱的 `# jps-config`"，不会出现"标了却没写"或"写了却没标"。
 * 只认白名单字段（`CONFIG_FIELDS`）；`undefined`/`null`（= 未设置）一律不算（等同默认）。
 */
export function nonDefaultConfigKeys(cfg: Partial<PageConfig>): string[] {
  return Object.keys(pickWritableConfig(cfg, 'diff'))
}

/**
 * adj454：把「用户本次改动」并入**源码层**设置，得到应写回 `# jps-config` 的配置。
 *
 * 规则（用户确认的分层「源码 > 缓存 > 默认」在**写方向**上的对应实现）：
 *  - 源码层原有字段：原样保留（用户没动它们）；
 *  - `next` 与 `base` 不同的字段：写入（= 用户本次真正改动的项）；
 *  - **缓存（L1）来源的值不会被固化**：它们既不在源码层里、也不在改动集里 → 不写进谱面。
 *
 * 由来：此前写回直接用「合并后的生效配置」，于是"点一次保存设置就把本机公共设置写进这首谱"
 * （实测：缓存里的 `margin_right`/`height_quci` 会出现在 `# jps-config` 里）——本机偏好泄漏成谱面级。
 *
 * @param code 源码
 * @param base 本次编辑**开始前**的生效配置（对话框打开时 / 虚线按下时的快照）
 * @param next 本次编辑**结束后**的生效配置
 */
export function mergeConfigEdits(code: string, base: PageConfig, next: PageConfig): Partial<PageConfig> {
  const out: Record<string, unknown> = { ...(extractJpsConfig(code) ?? {}) }
  const b = base as unknown as Record<string, unknown>
  const n = next as unknown as Record<string, unknown>
  for (const k of CONFIG_FIELDS) {
    if (sameValue(n[k], b[k])) continue
    // 清空某项（如 metaPos 被置空）时写入 undefined —— pickWritableConfig 会跳过它，
    // 于是旧值随"源码层重建"一并消失（等价于删除该字段）
    out[k] = n[k]
  }
  return out as Partial<PageConfig>
}

/**
 * 把设置写回源码的 `# jps-config` 行：
 *  - 已有该行 → 原位替换 JSON；
 *  - 无该行且有待写内容 → 追加到源码末尾（补空行分隔，adj200）；
 *  - **差量模式（默认）且无差量 → 删除已有该行**（全部回到默认 = 不需要设置行）。
 * 返回新源码；JSON 序列化失败时返回原串。
 * adj454：`cfg` 放宽为 `Partial<PageConfig>`；**持久化用户改动**请传 `mergeConfigEdits(...)` 的结果，
 * 不要直接传合并后的生效配置（那会把本机缓存设置固化进谱面）。
 */
export function writeJpsConfig(code: string, cfg: Partial<PageConfig>, opts?: { mode?: JpsConfigWriteMode }): string {
  const mode: JpsConfigWriteMode = opts?.mode ?? 'diff'
  // adj413：写入前统一取整——文件里的 px 一律整数（即便调用方传了浮点）
  const picked = pickWritableConfig(roundPxIntegers(cfg), mode)
  let raw: string
  try {
    raw = JSON.stringify(picked)
  } catch {
    return code
  }
  const text = code.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => l.startsWith(JPS_CONFIG_PREFIX))
  const isEmpty = Object.keys(picked).length === 0

  if (isEmpty) {
    if (idx < 0) return code
    // 删除设置行：连同它上方由 adj200 补出的连续空行一起收敛（最多 3 行），避免留一堆空行
    let from = idx
    while (from > 0 && lines[from - 1] === '' && idx - from < 3) from--
    lines.splice(from, idx - from + 1)
    // 文末空行收敛为一个
    while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2] === '') lines.pop()
    return lines.join('\n')
  }

  const line = `${JPS_CONFIG_PREFIX}${raw}`
  if (idx >= 0) {
    lines[idx] = line
  } else {
    // adj200：追加前默认补 3 个空行（原有 1 个）——把 # jps-config 与用户正文隔开，
    // 避免用户误改/误删设置行
    const tail = lines[lines.length - 1]
    if (tail === undefined || tail === '') {
      lines.push('', '', line)
    } else {
      lines.push('', '', '', line)
    }
  }
  return lines.join('\n')
}
