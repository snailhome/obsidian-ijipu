/**
 * frontmatter.ts — 笔记 frontmatter（ijipu_*）→ PageConfig 的纯逻辑
 *
 * 零 Obsidian 依赖（只依赖 @ijipu/engine），便于用 Node 单测（scripts/smoke-frontmatter.mts）。
 *
 * 设计要点（都是"设置看起来没生效"的常见原因）：
 *  1. **键名兼容两种写法**：`ijipu_note_size`（snake_case，与引擎字段一致）与 `ijipu_noteSize`
 *     （camelCase）都接受——比较时统一去掉非字母数字并小写。此前只做 `ijipu_<字段名>` 精确匹配，
 *     按 README 旧示例写 `ijipu_note_space_layout` 会**静默无效**。
 *  2. **值类型按默认值类型转换**：Properties 面板里数字常被存成字符串（`"15"`），
 *     布尔也可能写成 `是/否/1/0`——统一转换，避免"值进去了但排版没变"。
 *  3. **不静默忽略**：返回已生效项、未识别键，以及"最接近的合法键"建议，供界面提示。
 */
import { defaultPageConfig, type PageConfig } from '@ijipu/engine'

/** frontmatter 键前缀（唯一约定：键 = 前缀 + 引擎 PageConfig 字段名） */
export const FRONTMATTER_PREFIX = 'ijipu_'

/** PageConfig 字段 → frontmatter 键（与设置面板显示的键一致） */
export function frontmatterKey(field: string): string {
  return `${FRONTMATTER_PREFIX}${field}`
}

/** 规范化键名：去掉下划线/连字符/空格等并统一小写（`note_size`/`noteSize`/`note-size` → `notesize`） */
function normKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

/** 去掉 `ijipu_` 前缀（大小写不敏感）；无前缀时原样返回 */
function stripPrefix(key: string): string {
  return key.toLowerCase().startsWith(FRONTMATTER_PREFIX) ? key.slice(FRONTMATTER_PREFIX.length) : key
}

/**
 * PageConfig 全部字段名。
 *
 * **必须显式列出**：引擎的 `defaultPageConfig` 只包含"有默认值"的 28 个字段，
 * 而 `lyricShrink` / `showInstrument`（正是设置面板里的两项！）等 6 个可选字段不在其中——
 * 若按 `Object.keys(defaultPageConfig)` 建映射，写 `ijipu_showInstrument: true` 会被判成
 * **未识别键并静默忽略**（用户反馈的"设置了没生效"）。
 * 下面的类型断言保证此表与引擎类型完全一致：引擎增删字段时 `tsc` 会直接报错提醒同步。
 */
export const PAGE_CONFIG_FIELDS = [
  'page',
  'margin_top',
  'margin_bottom',
  'margin_left',
  'margin_right',
  'body_margin_top',
  'descAreaH',
  'biaoti_font',
  'biaoti_size',
  'fubiaoti_font',
  'fubiaoti_size',
  'miaoshu_font',
  'miaoshu_size',
  'notes_font',
  'notes_size',
  'geci_font',
  'geci_size',
  'lyricShrink',
  'note_size',
  'shuzi_font',
  'height_quci',
  'height_cici',
  'height_ciqu',
  'height_ciqu_lyric',
  'height_shengbu',
  'bar_gap',
  'align_min_bars',
  'noteSpaceLayout',
  'showInstrument',
  'metaPos',
  'lianyinxian_type',
  'heights',
] as const satisfies readonly (keyof PageConfig)[]

/** 编译期完整性断言：引擎新增字段而此表未同步时 tsc 报错（`never` 不可赋给 `true`） */
type MissingPageConfigField = Exclude<keyof PageConfig, (typeof PAGE_CONFIG_FIELDS)[number]>
export const _PAGE_CONFIG_FIELDS_COMPLETE: MissingPageConfigField extends never ? true : never = true

/**
 * 无默认值的可选字段的取值类型（`defaultPageConfig` 里没有它们，无法按默认值推断）。
 * 缺失会导致 `ijipu_lyricShrink: 否` 这类写法被当成普通字符串（真值）——按类型转换才正确。
 */
const OPTIONAL_FIELD_KIND: Partial<Record<keyof PageConfig, 'number' | 'boolean' | 'string'>> = {
  lyricShrink: 'boolean',
  showInstrument: 'boolean',
}

/**
 * **已不再属谱面级**的键（分层原则见 主项目 docs/SETTINGS-AUDIT.md）：
 * 编辑器字体/字号是「用户个性」（L1），只影响本机编辑体验，不随谱保存。
 * 早期版本把它们写进了 `# jps-config`，Frontmatter 里若还写着需明确提示（不是拼写错误）。
 */
const DEPRECATED_KEYS: Record<string, string> = {
  editorfont: '编辑器字体已改为插件设置里的本机偏好（不随谱保存）',
  editorfontsize: '编辑器字号已改为插件设置里的本机偏好（不随谱保存）',
}

/** 规范化字段名 → 真实 PageConfig 字段（一次构建，O(1) 查询） */
const FIELD_BY_NORM: ReadonlyMap<string, keyof PageConfig> = new Map(
  PAGE_CONFIG_FIELDS.map((f) => [normKey(f), f as keyof PageConfig]),
)

/** 一条生效的 frontmatter 覆盖 */
export type AppliedOverride = {
  /** frontmatter 里的原始键名（原样回显给用户） */
  key: string
  /** 对应的 PageConfig 字段 */
  field: string
  /** 转换后的值 */
  value: unknown
}

/** 未识别键 + 建议（建议为空表示没有相近的合法键） */
export type UnknownKey = {
  key: string
  suggest: string | null
}

/** 已降级为「用户个性」的旧键（不再随谱；见 DEPRECATED_KEYS） */
export type DeprecatedKey = {
  key: string
  reason: string
}

export type FrontmatterResult = {
  /** 合并结果：默认 < 插件设置 < frontmatter */
  config: PageConfig
  applied: AppliedOverride[]
  unknown: UnknownKey[]
  /** 写法合法但已不再随谱保存的键（编辑器偏好等） */
  deprecated: DeprecatedKey[]
}

/** 编辑距离（用于"是不是想写 X"的建议，键总量约 30 个，开销可忽略） */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** 未识别键 → 最接近的合法 frontmatter 键（距离 ≤ max(2, 键长/3) 才算"像"） */
function suggestKey(key: string): string | null {
  const target = normKey(stripPrefix(key)) // 必须去掉前缀再比对：字段名规范化后不含 `ijipu`
  let best: { k: string; d: number } | null = null
  for (const [norm, field] of FIELD_BY_NORM) {
    const d = editDistance(target, norm)
    if (!best || d < best.d) best = { k: frontmatterKey(String(field)), d }
  }
  if (!best) return null
  return best.d <= Math.max(2, Math.floor(target.length / 3)) ? best.k : null
}

/** 按字段取值类型转换 frontmatter 值；无法转换/空值返回 undefined（视为未设置） */
function coerceValue(field: keyof PageConfig, value: unknown): unknown {
  const def = defaultPageConfig[field]
  const kind: 'number' | 'boolean' | 'string' | undefined =
    typeof def === 'number'
      ? 'number'
      : typeof def === 'boolean'
        ? 'boolean'
        : typeof def === 'string'
          ? 'string'
          : OPTIONAL_FIELD_KIND[field] // 无默认值的可选字段按显式声明的类型转换
  if (kind === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    const s = String(value).trim()
    if (s === '') return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  if (kind === 'boolean') {
    if (typeof value === 'boolean') return value
    const s = String(value).trim().toLowerCase()
    if (['true', 'yes', 'on', '1', '是', '开', '显示', '真'].includes(s)) return true
    if (['false', 'no', 'off', '0', '否', '关', '不显示', '假'].includes(s)) return false
    return undefined
  }
  if (kind === 'string') {
    if (value === null || value === undefined) return undefined
    const s = String(value).trim()
    return s === '' ? undefined : s
  }
  return value // 对象类字段（metaPos/heights 等）原样透传
}

/**
 * 合并设置：默认 < 插件默认设置 < 笔记 frontmatter。
 * @param defaults 插件设置（设置面板里的全局默认）
 * @param frontmatter 笔记 frontmatter（Obsidian 元数据缓存里的对象，含 position 等非业务键）
 */
export function applyFrontmatter(
  defaults: Partial<PageConfig>,
  frontmatter: Record<string, unknown> | null | undefined,
): FrontmatterResult {
  const config: PageConfig = { ...defaultPageConfig, ...defaults }
  const applied: AppliedOverride[] = []
  const unknown: UnknownKey[] = []
  const deprecated: DeprecatedKey[] = []
  if (!frontmatter) return { config, applied, unknown, deprecated }

  for (const [key, raw] of Object.entries(frontmatter)) {
    if (key === 'position' || key === 'aliases' || key === 'cssclasses' || key === 'tags') continue
    if (!key.toLowerCase().startsWith(FRONTMATTER_PREFIX)) continue
    const norm = normKey(stripPrefix(key))
    // 写法合法但已降级为「用户个性」的键：明确提示，而不是当成拼写错误
    const dep = DEPRECATED_KEYS[norm]
    if (dep) {
      deprecated.push({ key, reason: dep })
      continue
    }
    const field = FIELD_BY_NORM.get(norm)
    if (!field) {
      unknown.push({ key, suggest: suggestKey(key) })
      continue
    }
    const value = coerceValue(field, raw)
    if (value === undefined) continue // 空值/无法转换：保持默认，不算错误
    ;(config as unknown as Record<string, unknown>)[field as string] = value
    applied.push({ key, field: String(field), value })
  }
  return { config, applied, unknown, deprecated }
}

/** 兼容旧调用：只要合并后的配置 */
export function mergePageConfig(
  defaults: Partial<PageConfig>,
  frontmatter: Record<string, unknown> | null | undefined,
): PageConfig {
  return applyFrontmatter(defaults, frontmatter).config
}

/** 已降级键提示文案（说明"为什么不生效"） */
export function deprecatedKeyHint(list: DeprecatedKey[]): string {
  return list.map((d) => `${d.key}：${d.reason}`).join('；')
}

/** 未识别键提示文案（界面/控制台共用；无可建议键时省略"是否想写"） */
export function unknownKeyHint(list: UnknownKey[]): string {
  return list
    .map((u) => (u.suggest ? `${u.key}（是否想写 ${u.suggest}？）` : u.key))
    .join('、')
}
