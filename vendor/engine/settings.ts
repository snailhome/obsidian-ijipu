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
 */
import { defaultPageConfig } from './types'
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
const OPTIONAL_CONFIG_FIELDS = ['heights', 'metaPos', 'lyricShrink', 'showInstrument'] as const

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

/** 取源码里 `# jps-config:` 行（无则 null） */
function jpsConfigLine(code: string): string | null {
  return (
    code
      .replace(/\r\n/g, '\n')
      .split('\n')
      .find((l) => l.startsWith(JPS_CONFIG_PREFIX)) ?? null
  )
}

/**
 * 从源码中提取谱面级设置（无该注释返回 null）。
 * 只取白名单字段，损坏 JSON 静默忽略（回退公共设置）；字体字段做 fallback 补全。
 */
export function extractJpsConfig(code: string): Partial<PageConfig> | null {
  const line = jpsConfigLine(code)
  if (!line) return null
  const raw = line.slice(JPS_CONFIG_PREFIX.length).trim()
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (typeof obj !== 'object' || obj === null) return null
    // 仅回填已知字段，防止任意键污染；白名单 = 默认字段 ∪ 可选字段（可选字段必须显式列入，
    // 否则写回后读回会被过滤丢失；新增可选字段时 OPTIONAL_CONFIG_FIELDS 与编译期断言会强制同步）
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj)) {
      if (!CONFIG_FIELDS.has(k)) continue
      const v = obj[k]
      // 字体：旧文件里常是裸字体名（如 "SimHei"）——统一补 fallback 链，避免换机器掉到浏览器默认字体
      out[k] = (SCORE_FONT_FIELDS as readonly string[]).includes(k) && typeof v === 'string' ? normalizeFontStack(v) : v
    }
    return out as Partial<PageConfig>
  } catch {
    return null
  }
}

/**
 * 读取**旧版**误写进谱面的编辑器偏好（用于一次性迁移到 L1 缓存）。
 * 只读原始 JSON（不走白名单），因为这两个键已不属于 `PageConfig`。
 */
export function extractLegacyEditorPrefs(code: string): Partial<EditorPrefs> | null {
  const line = jpsConfigLine(code)
  if (!line) return null
  try {
    const obj = JSON.parse(line.slice(JPS_CONFIG_PREFIX.length).trim()) as Record<string, unknown>
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
 * 合并谱面设置：源码 # jps-config 优先，其次公共设置（localStorage），兜底默认。
 * @param code 源码
 * @param fallback 公共设置（null 表示无 → 用默认）
 */
export function mergeJpsConfig(
  code: string,
  fallback: PageConfig | null,
): PageConfig {
  const embedded = extractJpsConfig(code)
  return {
    ...defaultPageConfig,
    ...(fallback ?? {}),
    ...(embedded ?? {}),
  }
}

/** 写入模式：diff = 只写与默认不同的字段（默认）｜full = 固化全部字段 */
export type JpsConfigWriteMode = 'diff' | 'full'

/** 深比较（只用于判断"是否与默认值相同"，值都是原始类型/小对象） */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
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
 */
function pickWritableConfig(cfg: PageConfig, mode: JpsConfigWriteMode): Record<string, unknown> {
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
 * 把设置写回源码的 `# jps-config` 行：
 *  - 已有该行 → 原位替换 JSON；
 *  - 无该行且有待写内容 → 追加到源码末尾（补空行分隔，adj200）；
 *  - **差量模式（默认）且无差量 → 删除已有该行**（全部回到默认 = 不需要设置行）。
 * 返回新源码；JSON 序列化失败时返回原串。
 */
export function writeJpsConfig(code: string, cfg: PageConfig, opts?: { mode?: JpsConfigWriteMode }): string {
  const mode: JpsConfigWriteMode = opts?.mode ?? 'diff'
  const picked = pickWritableConfig(cfg, mode)
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
