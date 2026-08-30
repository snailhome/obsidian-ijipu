import {
  parseJps,
  layoutScore,
  renderScoreToSvg,
  buildPlaySequence,
  createBackend,
  inferBpm,
  schedulePlay,
  defaultPageConfig,
  type PageConfig,
  type PlayEvent,
} from '@ijipu/engine'

/**
 * 合并设置（优先级：默认 < 插件默认设置 < 笔记 frontmatter）。
 * frontmatter 键统一 `ijipu_<PageConfig字段>`（snake_case，与 iJipu 引擎字段一致，便于反查）。
 */
export function mergePageConfig(
  defaults: Partial<PageConfig>,
  frontmatter: Record<string, unknown>,
): PageConfig {
  const cfg: PageConfig = { ...defaultPageConfig, ...defaults }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!key.startsWith('ijipu_')) continue
    const field = key.slice('ijipu_'.length) as keyof PageConfig
    if (value === undefined || value === null) continue
    if (field in cfg) {
      // 直接写入（frontmatter 的 YAML 类型与字段语义一致：number/string/boolean）
      ;(cfg as unknown as Record<string, unknown>)[field as string] = value
    }
  }
  return cfg
}

/** 渲染 .jps → 每页 SVG 字符串（解析失败返回 error 信息） */
export function renderScore(
  source: string,
  pageConfig: PageConfig,
): { svgs: string[]; error?: string } {
  const parsed = parseJps(source)
  if (parsed.errors.length > 0) {
    const msg = parsed.errors.map((e) => (e as { message?: string }).message ?? String(e)).join('\n')
    return { svgs: [], error: msg }
  }
  const layout = layoutScore(parsed, pageConfig)
  return { svgs: renderScoreToSvg(layout) }
}

/**
 * 试听：.jps → 播放序列 → Web Audio 合成（复用 @ijipu/engine 播放引擎）。
 * 返回 { cancel, totalMs } 供播放/停止切换；解析失败返回 null。
 */
export async function playScore(
  source: string,
  pageConfig: PageConfig = defaultPageConfig,
): Promise<{ cancel: () => void; totalMs: number; events: PlayEvent[] } | null> {
  const parsed = parseJps(source)
  if (parsed.errors.length > 0) return null
  // buildPlaySequence 需 layout（排版）与 bpm（速度，可由描述头推断）
  const layout = layoutScore(parsed, pageConfig)
  const bpm = inferBpm(parsed)
  const seq = buildPlaySequence(parsed, layout, bpm)
  const backend = createBackend('synth')
  // SynthBackend.ensure()：异步创建/恢复 AudioContext（需用户手势触发）
  await (backend as { ensure?: () => Promise<unknown> }).ensure?.()
  const control = schedulePlay(seq, backend)
  return { ...control, events: seq.events }
}
