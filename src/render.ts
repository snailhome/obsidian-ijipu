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
import { splitParseIssues, type ParseIssue } from './parseIssues'

/**
 * 合并设置（优先级：默认 < 插件默认设置 < 笔记 frontmatter）。
 * 实现移到 `frontmatter.ts`（零 Obsidian 依赖、可单测）：键名兼容 snake_case / camelCase、
 * 值按默认值类型转换、未识别键返回建议。此处仅做转出，保持既有 `from './render'` 引用可用。
 */
export { applyFrontmatter, mergePageConfig, frontmatterKey, unknownKeyHint, deprecatedKeyHint, FRONTMATTER_PREFIX } from './frontmatter'
export type { AppliedOverride, UnknownKey, DeprecatedKey, FrontmatterResult } from './frontmatter'
export { resolvePageConfig } from './config'
export type { ResolvedConfig } from './config'

/**
 * 解析结果的严重级别拆分（adj394）——实现见 `parseIssues.ts`（纯逻辑、可单测）：
 * 引擎同时产出 `error`（阻断渲染）与 `warning`（提示，不阻断）。
 */
export { splitParseIssues } from './parseIssues'
export type { ParseIssues, ParseIssue } from './parseIssues'

/** 渲染 .jps → 每页 SVG 字符串（**错误**才返回 error 信息；告警随 `warnings` 一并返回，不阻断） */
export function renderScore(
  source: string,
  pageConfig: PageConfig,
): { svgs: string[]; error?: string; warnings?: ParseIssue[] } {
  const parsed = parseJps(source)
  const { errors, warnings } = splitParseIssues(parsed)
  if (errors.length > 0) return { svgs: [], error: errors.map((e) => e.text).join('\n'), warnings }
  const layout = layoutScore(parsed, pageConfig)
  return { svgs: renderScoreToSvg(layout), warnings: warnings.length > 0 ? warnings : undefined }
}

/**
 * 渲染并**一并返回排版结果**（`layout`）——排版辅助虚线的几何（行顶/歌词行/描述头）
 * 需要 layout，不能在只拿 SVG 字符串后反推。
 */
export function renderScoreFull(
  source: string,
  pageConfig: PageConfig,
): { svgs: string[]; layout: ScoreLayout | null; error?: string; warnings?: ParseIssue[]; errorIssues?: ParseIssue[] } {
  const parsed = parseJps(source)
  const { errors, warnings } = splitParseIssues(parsed)
  if (errors.length > 0) {
    return { svgs: [], layout: null, error: errors.map((e) => e.text).join('\n'), warnings, errorIssues: errors }
  }
  const layout = layoutScore(parsed, pageConfig)
  return { svgs: renderScoreToSvg(layout), layout, warnings: warnings.length > 0 ? warnings : undefined }
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
  // adj394：只有 error 级才阻断试听；warning（如渐强/渐弱写得不够完整）照常播放
  const fatal = parsed.errors.filter((e) => e.severity === 'error')
  if (fatal.length > 0) throw new Error(`谱面解析失败：${fatal.map((e) => String(e.message ?? e)).join('；')}`)
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
