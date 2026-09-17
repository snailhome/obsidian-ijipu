/**
 * config.ts — 谱面设置解析（纯逻辑，零 Obsidian 依赖，可单测）
 *
 * 优先级（**源内最高**，与 iJipu 应用的「每首谱用自己的设置」一致）：
 *   引擎默认 `defaultPageConfig`
 *     < 插件设置（设置面板里的全局默认）
 *       < 笔记 frontmatter（`ijipu_*`，笔记级兜底）
 *         < **谱面源码内的 `# jps-config:{...}`**（该曲谱自带设置）
 *
 * 最后一级是「把 iJipu 的 .jps 直接复制进 Obsidian 即可一模一样」的关键：
 * iJipu 在点「保存设置」时用 `writeJpsConfig` 把**与默认不同的项**（差量）写进源码那一行，
 * 而 adj480 起 iJipu 应用侧**不再有"本机页面设置"层**（谱面自包含）⇒ 源内配置就是它的全部面子。
 * 插件这一侧插件设置与 frontmatter 只对**源内没写的键**生效（保留"改一处、全库统一变"的能力）；
 * 要把这份谱复制给别人也一致，用设置对话框的「随谱固化」（= 把与引擎默认不同的全部生效项写进源码）。
 */
import { extractJpsConfig, mergeJpsConfig, type PageConfig } from '@ijipu/engine'
import { applyFrontmatter, type AppliedOverride, type DeprecatedKey, type UnknownKey } from './frontmatter'

export type ResolvedConfig = {
  /** 最终生效的页面配置 */
  config: PageConfig
  /** frontmatter 里生效的项（原键名 + 值，供徽标/提示显示） */
  applied: AppliedOverride[]
  /** 未识别的 frontmatter 键（含最近键名建议） */
  unknown: UnknownKey[]
  /** 写法合法但已降级为「用户个性」的键（编辑器偏好等，不再随谱） */
  deprecated: DeprecatedKey[]
  /** 源内 `# jps-config` 生效的字段名（供徽标显示） */
  sourceFields: string[]
}

/**
 * 解析最终配置：默认 < 插件设置 < frontmatter < 源内 `# jps-config`。
 * @param source 代码块里的 .jps 源码（与 iJipu 打开的文件内容一致）
 * @param settings 插件设置（全局默认）
 * @param frontmatter 笔记 frontmatter（可为 null）
 */
export function resolvePageConfig(
  source: string,
  settings: Partial<PageConfig>,
  frontmatter: Record<string, unknown> | null | undefined,
): ResolvedConfig {
  const fm = applyFrontmatter(settings, frontmatter)
  // 源内配置字段（也用于徽标告知用户"这份谱自带设置"）
  const sourceFields = Object.keys(extractJpsConfig(source) ?? {})
  // mergeJpsConfig 的语义即「默认 < fallback < 源内」，恰好是本插件需要的优先级
  const config = mergeJpsConfig(source, fm.config)
  return { config, applied: fm.applied, unknown: fm.unknown, deprecated: fm.deprecated, sourceFields }
}
