import {
  parseJps,
  layoutScore,
  renderScoreToSvg,
  buildPlaySequence,
  inferBpm,
  schedulePlay,
  defaultPageConfig,
  type PageConfig,
  type ScoreLayout,
} from '@ijipu/engine'
import { SpessaSynthBackend, HqCache, getHqLibrary, loadHqBank } from './soundbank'

/**
 * 合并设置（优先级：默认 < 插件默认设置 < 笔记 frontmatter）。
 * 实现移到 `frontmatter.ts`（零 Obsidian 依赖、可单测）：键名兼容 snake_case / camelCase、
 * 值按默认值类型转换、未识别键返回建议。此处仅做转出，保持既有 `from './render'` 引用可用。
 */
export { applyFrontmatter, mergePageConfig, frontmatterKey, unknownKeyHint, FRONTMATTER_PREFIX } from './frontmatter'
export type { AppliedOverride, UnknownKey, FrontmatterResult } from './frontmatter'
export { resolvePageConfig } from './config'
export type { ResolvedConfig } from './config'

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
 * 渲染并**一并返回排版结果**（`layout`）——排版辅助虚线的几何（行顶/歌词行/描述头）
 * 需要 layout，不能在只拿 SVG 字符串后反推。
 */
export function renderScoreFull(
  source: string,
  pageConfig: PageConfig,
): { svgs: string[]; layout: ScoreLayout | null; error?: string } {
  const parsed = parseJps(source)
  if (parsed.errors.length > 0) {
    const msg = parsed.errors.map((e) => (e as { message?: string }).message ?? String(e)).join('\n')
    return { svgs: [], layout: null, error: msg }
  }
  const layout = layoutScore(parsed, pageConfig)
  return { svgs: renderScoreToSvg(layout), layout }
}

/**
 * 试听：.jps → 播放序列 → SpessaSynth 高保真（复用 @ijipu/engine 播放引擎 + obsidian 音源缓存）。
 * 返回 { cancel, totalMs } 供播放/停止切换；解析失败/音源缺失返回 null。
 * opts.workletUrl 由插件提供（内置 worklet）；opts.hqVoice 为默认音色（GM program，null=声部路由）。
 */
export type PlayheadSeg = {
  atMs: number
  durationMs: number
  pageIndex: number
  x: number
  y: number
  width: number
  voice: number
  group: number
}

export async function playScore(
  source: string,
  pageConfig: PageConfig = defaultPageConfig,
  opts?: { hqVoice?: number | null; workletUrl?: string },
): Promise<{ cancel: () => void; totalMs: number; track: PlayheadSeg[] } | null> {
  const parsed = parseJps(source)
  if (parsed.errors.length > 0) throw new Error(`谱面解析失败：${parsed.errors.map((e) => String((e as { message?: string })?.message ?? e)).join('；')}`)
  // buildPlaySequence 需 layout（排版）与 bpm（速度，可由描述头推断）
  const layout = layoutScore(parsed, pageConfig)
  const bpm = inferBpm(parsed)
  const seq = buildPlaySequence(parsed, layout, bpm)
  // adj352：SpessaSynth 高保真试听——音源远端下载 + IndexedDB 缓存，worklet 由插件提供
  const backend = new SpessaSynthBackend()
  try {
    // adj353：失败原因直接抛出，供 Obsidian 界面/控制台可见（不再静默无声）
    await backend.ready()
    if (!opts?.workletUrl) throw new Error('未找到内置 SpessaSynth worklet（main.js 内联 worklet 失败，请重新构建并更新插件）')
    const bank = await loadHqBank(getHqLibrary(), new HqCache())
    await backend.load(bank, opts.workletUrl)
  } catch (e) {
    backend.dispose()
    throw e instanceof Error ? e : new Error(String(e))
  }
  backend.setVoice(opts?.hqVoice ?? null)
  // 200ms 起播延迟（与 iJipu PLAY_FIRST_DELAY_MS 一致，声画同步）
  const control = schedulePlay(seq, backend, undefined, undefined, 200)
  // 构建播放色块轨道（与 iJipu 一致：按 playheadSegs 拍段，每段 ≤1 拍）
  const beatMs = 60000 / bpm
  const track: PlayheadSeg[] = seq.events.flatMap((e) =>
    (e.playheadSegs ?? []).map((s) => ({
      atMs: e.atMs + s.beat * beatMs,
      durationMs: s.beats * beatMs,
      pageIndex: s.pageIndex,
      x: s.x,
      y: s.y,
      width: s.width,
      voice: s.voice,
      group: s.group,
    })),
  )
  return { ...control, track }
}
