/**
 * config.ts — 谱面设置解析（纯逻辑，零 Obsidian 依赖，可单测）
 *
 * 优先级（**源内最高**，与 iJipu 应用的「每首谱用自己的设置」一致）：
 *   引擎默认 `defaultPageConfig`
 *     < 插件设置（设置面板里的全局默认）
 *       < **谱面源码内的 `# jps-config:{...}`**（该曲谱自带设置）
 *
 * 最后一级是「把 iJipu 的 .jps 直接复制进 Obsidian 即可一模一样」的关键：
 * iJipu 在点「保存设置」时用 `writeJpsConfig` 把**与默认不同的项**（差量）写进源码那一行，
 * 而 adj480 起 iJipu 应用侧**不再有"本机页面设置"层**（谱面自包含）⇒ 源内配置就是它的全部面子。
 * 插件设置只对**源内没写的键**生效（保留"改一处、全库统一变"的能力）；
 * 要把这份谱复制给别人也一致，用设置对话框的「保存到谱面」（= 把生效项写进源码那一行）。
 *
 * adj738（用户决定）：**删掉笔记 frontmatter 那一层**（`ijipu_*` 键）。
 * 理由（用户原话）：它对 `.jps` 文件用不上、对"一个笔记里多个 ` ```jps ` 块"又太粗（笔记级），
 * 且**不随谱走**；而源内的 `# jps-config` 既跟谱走、又能**逐块**写。**这是破坏性变更**：
 * 老笔记里写在 Properties/YAML 里的 `ijipu_*` 键从此不再生效（RELEASE-NOTES 有醒目提示）。
 */
import { extractJpsConfig, mergeJpsConfig, type PageConfig } from '@ijipu/engine'

export type ResolvedConfig = {
  /** 最终生效的页面配置 */
  config: PageConfig
  /**
   * **本库默认层** = 代码默认 ← 插件设置。
   * 设置对话框用它当基线，区分"这份谱自己写了的项"与"只是跟随本库默认"的项。
   */
  baseline: PageConfig
  /** 源内 `# jps-config` 生效的字段名（供徽标/对话框显示） */
  sourceFields: string[]
}

/**
 * 解析最终配置：默认 < 插件设置 < 源内 `# jps-config`。
 * @param source 代码块里的 .jps 源码（与 iJipu 打开的文件内容一致）
 * @param settings 插件设置（全局默认）
 */
export function resolvePageConfig(source: string, settings: Partial<PageConfig>): ResolvedConfig {
  // 源内配置字段（也用于徽标告知用户"这份谱自带设置"）
  const sourceFields = Object.keys(extractJpsConfig(source) ?? {})
  // `mergeJpsConfig` 会先把 `defaultPageConfig` 铺底再盖 fallback，所以传 Partial 是安全的
  //（类型上它要完整 PageConfig，这里显式收窄即可）。
  const baseline = mergeJpsConfig('', settings as PageConfig)
  // mergeJpsConfig 的语义即「默认 < fallback < 源内」，恰好是本插件需要的优先级
  const config = mergeJpsConfig(source, settings as PageConfig)
  return { config, baseline, sourceFields }
}
