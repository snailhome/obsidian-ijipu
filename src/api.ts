/**
 * api.ts — iJipu 的**公开调用面**（方案 B 的 B1）
 *
 * 背景（`docs/CLI-AND-COMMAND-PLAN.md` §B）：嵌入版与插件的能力分两层——
 *  · **纯 TS 能力**（解析/格式化/校验/导出 SVG/MIDI）**引擎已在插件内**（`vendor/engine`）⇒
 *    直接调用即可，**不必**跨 iframe 绕一圈（更快、无网络、**手机端也能用** ✓）；
 *  · **应用专属能力**（位图/PDF、音色库试听）以后走嵌入版 RPC（B2/B3），本文件先不碰。
 *
 * 设计约束（都是为了让"对外承诺"可维护）：
 *  1. **冻结的面**：`apiVersion` 一旦发布只增不改；破坏性变化必须升 `apiVersion`；
 *  2. **不泄内部对象**：返回值只用普通数据（数组/字符串/布尔），
 *     不让调用方拿到 `ScoreLayout` 之类内部结构去改（`renderFull` 是**显式**的逃生舱，标 experimental）；
 *  3. **不吞错**：解析错误如实返回（`ok:false` + `errors`），不抛异常给调用方；
 *  4. **配置口径同源**：走插件自己的 `resolvePageConfig(source, settings)`（与预览区逐字一致 ✓），
 *     **禁止**在 API 里另算一份（AGENTS §六之二·4"数值口径必须同源"）。
 *
 * 用法（其它插件 / QuickAdd / Templater / DataviewJS）：
 * ```ts
 * const ijipu = (this.app as any).plugins.plugins['ijipu']?.api
 * if (ijipu?.apiVersion === 1) {
 *   const r = ijipu.renderSvg(source)          // 每页一段 SVG 字符串
 *   const lint = ijipu.lint(source)            // 错误/告警
 *   const fixed = ijipu.format(source)         // 按应用规范规范化
 * }
 * ```
 */
import { formatJps, parseJps, splitParseIssues, type PageConfig, type RenderAssets } from '@ijipu/engine'
import { resolvePageConfig, type ResolvedConfig } from './config'
import { renderScore, renderScoreFull, type ParseIssue } from './render'

/** 公开 API 版本：**只增不改**（破坏性变化必须 +1，调用方按它分支） */
export const IJIPU_API_VERSION = 1 as const

/** 一次解析的结论（`ok` 为假时看 `errors`） */
export type IjipuLintResult = {
  ok: boolean
  errors: ParseIssue[]
  warnings: ParseIssue[]
}

/** 渲染结论：`ok` 为假时 `svgs` 为空、`error` 给一句人话 */
export type IjipuRenderResult = {
  ok: boolean
  svgs: string[]
  error?: string
  warnings: ParseIssue[]
}

/** 能力探测：调用方据此**降级**（例如没有音色库时只提供 MIDI） */
export type IjipuCapabilities = {
  apiVersion: number
  /** 纯 TS 能力（插件内即有，移动端同样可用） */
  parse: true
  format: true
  lint: true
  renderSvg: true
  /** 导出 MIDI（`eventsToMidi`，纯 TS）——B3 起提供，先报 false 不骗调用方 */
  midi: false
  /** 需要**应用**的能力（位图/PDF、音色库试听）——走嵌入版 RPC，B2/B3 起可用 */
  rasterExport: false
  audioPlayback: false
}

export interface IjipuApi {
  readonly apiVersion: number
  readonly capabilities: IjipuCapabilities
  /** 解析：只回结论与问题清单，不外泄内部结构 */
  lint(source: string): IjipuLintResult
  /** 规范化源码（与应用编辑器"格式化"同一份实现） */
  format(source: string): string
  /**
   * 渲染为**每页一段** SVG 字符串；`pageConfig` 省略时用插件当前设置（含源内 `# jps-config`）。
   *
   * `assets`（adj965k）：**宿主解析好的水印 / 背景图资源**（`{ href: data: URI, w, h }`）。
   * 为什么要由调用方递：引擎是纯 TS、零 DOM —— 它读不到字节也量不到宽高，**只认这份 `{href,w,h}`**；
   * 而"相对本谱的路径"与"`[[双链]]`"两类取值只有宿主（插件，能读 vault）解析得出来。
   * 省略 ⇒ 与不加图片层时**逐字节相同**（引擎那条回归闸门管着）。
   */
  renderSvg(source: string, pageConfig?: Partial<PageConfig>, assets?: RenderAssets): IjipuRenderResult
  /** 生效配置 + 来源信息（"这个值来自哪一层"），供高级调用方显示/固化 */
  effectiveConfig(source: string): Pick<ResolvedConfig, 'config' | 'baseline' | 'sourceFields'>
  /** 实验性：连排版结果一起返回（**不要**改它；接口可能变） */
  renderFull(source: string, pageConfig?: Partial<PageConfig>): ReturnType<typeof renderScoreFull>
}

/**
 * 构造公开 API。
 * @param settings 取"插件当前设置"的函数（`Partial<PageConfig>`）—— 传函数而非快照，
 *   保证用户改了设置后 API 立刻跟着变（不出现"设置改了、API 还是旧的"）。
 */
export function createIjipuApi(settings: () => Partial<PageConfig>): IjipuApi {
  const lint = (source: string): IjipuLintResult => {
    const { errors, warnings } = splitParseIssues(parseJps(source))
    return { ok: errors.length === 0, errors, warnings }
  }

  /**
   * adj965k（**用户实测证伪第一版修法之后**）：第三个参数 `assets` 直接转给 `renderScore`。
   *
   * 第一版把图内联成 `data:` URI 写进源码，**没用** ✗ —— 引擎渲染图片只认 `assets` 里那份
   * `{href,w,h}`（它零 DOM：量不到宽高、也读不到字节，源码里写什么都不够）。
   * 两个宿主（插件自己的出口、嵌入版应用）现在都是"**宿主解析好 ⇒ 当参数递给渲染端**"这一条口径。
   */
  const renderSvg = (source: string, pageConfig?: Partial<PageConfig>, assets?: RenderAssets): IjipuRenderResult => {
    const cfg = pageConfig ? { ...resolvePageConfig(source, settings()).config, ...pageConfig } : resolvePageConfig(source, settings()).config
    const { svgs, error, warnings } = renderScore(source, cfg, assets)
    return { ok: error === undefined, svgs, error, warnings: warnings ?? [] }
  }

  const api: IjipuApi = {
    apiVersion: IJIPU_API_VERSION,
    capabilities: {
      apiVersion: IJIPU_API_VERSION,
      parse: true,
      format: true,
      lint: true,
      renderSvg: true,
      midi: false,
      rasterExport: false,
      audioPlayback: false,
    },
    lint,
    format: (source) => formatJps(source),
    renderSvg,
    effectiveConfig: (source) => {
      const r = resolvePageConfig(source, settings())
      return { config: r.config, baseline: r.baseline, sourceFields: r.sourceFields }
    },
    renderFull: (source, pageConfig) => {
      const cfg = pageConfig ? { ...resolvePageConfig(source, settings()).config, ...pageConfig } : resolvePageConfig(source, settings()).config
      return renderScoreFull(source, cfg)
    },
  }
  /**
   * 冻结：公开面**不得**被调用方改写（否则"我承诺的接口"随时可能被别的插件换掉 ✗）。
   * 注意只冻结**表层**——返回值都是新对象，天然不可反向影响内部 ✓。
   */
  return Object.freeze(api)
}
