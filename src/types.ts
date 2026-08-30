import type { PageConfig } from '@ijipu/engine'

/**
 * 插件全局设置：继承 iJipu PageConfig 的渲染项（四组：页面/字体/行距/渲染）。
 * 未设置时由 defaultPageConfig 兜底；笔记 frontmatter（ijipu_*）再覆盖。
 */
export type IJipuSettings = Partial<PageConfig>
