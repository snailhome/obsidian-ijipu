import {
  parseJps,
  layoutScore,
  renderScoreToSvg,
  buildPlaySequence,
  inferBpm,
  schedulePlay,
  defaultPageConfig,
  type PageConfig,
} from '@ijipu/engine'
import { SpessaSynthBackend, HqCache, getHqLibrary, loadHqBank } from './soundbank'

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
  if (parsed.errors.length > 0) return null
  // buildPlaySequence 需 layout（排版）与 bpm（速度，可由描述头推断）
  const layout = layoutScore(parsed, pageConfig)
  const bpm = inferBpm(parsed)
  const seq = buildPlaySequence(parsed, layout, bpm)
  // adj352：SpessaSynth 高保真试听——音源远端下载 + IndexedDB 缓存，worklet 由插件提供
  const backend = new SpessaSynthBackend()
  await backend.ready()
  try {
    const bank = await loadHqBank(getHqLibrary(), new HqCache())
    await backend.load(bank, opts?.workletUrl ?? '')
  } catch {
    backend.dispose()
    return null
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
