/**
 * engine/settings.ts — 谱面级设置持久化（adj83）
 *
 * 每份简谱可把自己的页面设置（PageConfig + metaPos）保存在源码的
 * `# jps-config:{...}` 单行 JSON 注释里，保证「这首谱用自己的设置」；
 * 源码里没有该注释时回退公共设置（localStorage）。
 *
 * 语法：`# jps-config:{"page":"A4","margin_top":80,...,"metaPos":{...}}`
 *  - 识别：行首 `#` + 空白 + `jps-config:` 前缀
 *  - 保存：覆盖已有该行，无则追加到文件末尾
 */
import { defaultPageConfig } from './types'
import type { PageConfig } from './types'

/** # jps-config 注释行前缀 */
export const JPS_CONFIG_PREFIX = '# jps-config:'

/**
 * 不在 `defaultPageConfig` 对象上的**可选字段**：写回 `# jps-config` 后读回时必须保留，
 * 否则「显示乐器名 / 歌词压缩 / 编辑器字体」这类开关保存后重开即失效。
 *
 * adj382：补 `showInstrument`——它此前漏在白名单外（`defaultPageConfig` 里没有它，
 * 又不是显式白名单项），于是 `writeJpsConfig` 明明写进了 30 个字段，`extractJpsConfig`
 * 只读回 29 个，App 勾选「显示乐器名」保存后重新打开就丢（同类"设置不生效"）。
 * 下面的编译期断言保证**引擎新增可选字段时此处必须同步**（否则 tsc 报错）。
 */
const OPTIONAL_CONFIG_FIELDS = [
  'heights',
  'metaPos',
  'editorFont',
  'editorFontSize',
  'lyricShrink',
  'showInstrument',
] as const

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

/**
 * 从源码中提取谱面级设置（无该注释返回 null）。
 * 只取白名单字段，损坏 JSON 静默忽略（回退公共设置）。
 */
export function extractJpsConfig(code: string): Partial<PageConfig> | null {
  const line = code
    .replace(/\r\n/g, '\n')
    .split('\n')
    .find((l) => l.startsWith(JPS_CONFIG_PREFIX))
  if (!line) return null
  const raw = line.slice(JPS_CONFIG_PREFIX.length).trim()
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (typeof obj !== 'object' || obj === null) return null
    // 仅回填已知字段，防止任意键污染
    // adj221/adj382：可选字段（不在 defaultPageConfig 对象上）必须显式列入白名单，
    // 否则写回 # jps-config 后读回会被过滤丢失；新增可选字段时 OPTIONAL_CONFIG_FIELDS
    // 与上面的编译期断言会强制同步。
    const known = new Set<string>([...Object.keys(defaultPageConfig), ...OPTIONAL_CONFIG_FIELDS])
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj)) {
      if (known.has(k)) out[k] = obj[k]
    }
    return out as Partial<PageConfig>
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

/**
 * 把设置写回源码的 # jps-config 行：
 *  - 已有该行 → 原位替换 JSON
 *  - 无该行 → 追加到源码末尾（空行分隔）
 * 返回新源码；不修改原文则返回原串（JSON 序列化失败时）。
 */
export function writeJpsConfig(code: string, cfg: PageConfig): string {
  let raw: string
  try {
    raw = JSON.stringify(cfg)
  } catch {
    return code
  }
  const line = `${JPS_CONFIG_PREFIX}${raw}`
  const lines = code.replace(/\r\n/g, '\n').split('\n')
  const idx = lines.findIndex((l) => l.startsWith(JPS_CONFIG_PREFIX))
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
