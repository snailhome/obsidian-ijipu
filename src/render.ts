import {
  parseJps,
  layoutScore,
  renderScoreToSvg,
  buildPlaySequence,
  inferBpm,
  schedulePlay,
  defaultPageConfig,
  noteFontFamily,
  type AccidentalInkMetrics,
  type PageConfig,
  type ScoreLayout,
} from '@ijipu/engine'
import { SpessaSynthBackend, HqCache, getHqLibrary, loadHqBank } from './soundbank'
import type { BankFileStore } from './bankFile'
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

/**
 * adj638（用户报"描述头 `D: C#` 的升降符与字母还重叠 / 又过宽"）：**插件也实测字体**。
 *
 * 插件此前调用 `renderScoreToSvg(layout)` **不传任何实测值** ⇒ 引擎只能按"估算宽"（角标宽度 = 角标字号）
 * 摆放调号角标；而 ♯/♭ 在简谱字体栈里是**全角字形**（占宽 1em、墨迹仅 0.62em、右侧留白 1.75px），
 * 估算必然让角标与字母之间空出一大截（用户在插件里看到的那条明显缝隙）。
 *
 * 这里按应用 `PreviewPane` 同一套口径用 canvas 实测后传入：
 *  · `w1eq`/`w1sp`/`wTempo`：`1 = ` / `1 ` / `♩` 的**占宽**（adj199/adj629v 的 = 号对齐）；
 *  · `wAcc` + `accInkRight`：`♯` 的**占宽**与**墨迹右缘**——占宽用于拍号定位，两者之差（右侧留白）
 *    交给引擎补偿掉 ⇒ 角标与字母的墨迹净距严格 = 0.2px（adj638）。
 * 无 DOM 环境（冒烟/单测）返回 `undefined`，引擎自动回落到"字体自然留白 + 0.2px"（绝不压字）。
 */
function measureMeta(
  cfg: PageConfig,
): { w1eq?: number; w1sp?: number; wTempo?: number; wAcc?: number; accInkRight?: number } {
  try {
    if (typeof document === 'undefined') return {}
    // adj724b（社区审核）：用 Obsidian 全局 createEl 取代 document.createElement（prefer-create-el）
    const ctx = createEl('canvas').getContext('2d')
    if (!ctx) return {}
    const size = cfg.miaoshu_size
    const font = cfg.miaoshu_font
    const adv = (text: string, px = size): number => {
      ctx.font = `${px}px ${font}`
      return ctx.measureText(text).width
    }
    const accPx = size * (3 / 4)
    ctx.font = `${accPx}px ${font}`
    const inkRight = ctx.measureText('♯').actualBoundingBoxRight
    return {
      w1eq: adv('1 = '),
      w1sp: adv('1 '),
      wTempo: adv('♩'),
      wAcc: adv('♯', accPx),
      ...(Number.isFinite(inkRight) ? { accInkRight: inkRight } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * adj647（用户要求"墨迹来源也统一"）：**插件也实测变音角标的字形度量**。
 *
 * 与应用 `preview/fontMeta.ts` 同一套口径（两个宿主各自量、引擎消费）：
 * `#`/`b`/`♮` 的**墨迹宽与左偏**（比值 = px ÷ 实测字号），交给 `layoutScore` 的 `fontMeta` 第 4 参
 * ⇒ 布局按**本机字体**算角标占宽（不再假设默认字体栈），并把解析结果写进 `PlacedToken.accidentalGeo`
 * 供渲染直接消费。量不到（无 DOM / 老引擎）时返回 `undefined`，引擎自动回退内置常量表。
 */
function measureAccidentalInk(cfg: PageConfig): AccidentalInkMetrics | undefined {
  try {
    if (typeof document === 'undefined') return undefined
    // adj724b（社区审核）：同 measureText 处——改用 createEl（prefer-create-el）
    const ctx = createEl('canvas').getContext('2d')
    if (!ctx) return undefined
    // ⚠ 必须用**大基准字号**量：角标实际只有 ~8.67px，这个尺寸上浏览器会把墨迹包围盒量化到整像素
    // （实测 `#` 的 inkW 比值 0.605 → 0.808、偏大 ~33%）⇒ 只取比值，让引擎按真实角标字号换算
    const REF = 100
    const font = noteFontFamily(cfg.shuzi_font) // 必须与渲染用同一串 font-family
    const one = (ch: string): { inkW: number; lsb: number } | undefined => {
      ctx.font = `${REF}px ${font}`
      const m = ctx.measureText(ch)
      const left = m.actualBoundingBoxLeft
      const right = m.actualBoundingBoxRight
      if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined
      return { inkW: (right + left) / REF, lsb: -left / REF }
    }
    return { '#': one('#'), b: one('b'), '♮': one('♮') }
  } catch {
    return undefined
  }
}

/** 渲染 .jps → 每页 SVG 字符串（**错误**才返回 error 信息；告警随 `warnings` 一并返回，不阻断） */
export function renderScore(
  source: string,
  pageConfig: PageConfig,
): { svgs: string[]; error?: string; warnings?: ParseIssue[] } {
  const parsed = parseJps(source)
  const { errors, warnings } = splitParseIssues(parsed)
  if (errors.length > 0) return { svgs: [], error: errors.map((e) => e.text).join('\n'), warnings }
  const layout = layoutScore(parsed, pageConfig, undefined, { accidentalInk: measureAccidentalInk(pageConfig) })
  return {
    svgs: renderScoreToSvg(layout, measureMeta(layout.config)),
    warnings: warnings.length > 0 ? warnings : undefined,
  }
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
  const layout = layoutScore(parsed, pageConfig, undefined, { accidentalInk: measureAccidentalInk(pageConfig) })
  return {
    svgs: renderScoreToSvg(layout, measureMeta(layout.config)),
    layout,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
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
  /**
   * adj450：与应用同源的可选字段——引擎 `PlayheadSeg` 已经给出，插件侧此前**只透传 x/y/width**，
   * 于是多声部/临时段的色块退化成单声部默认高度、也拿不到音色与声部角色：
   *  - `yTopMin` / `yBottomMax`：色块按曲行几何的**上下边界**（多声部按声部中线分块、临时段按上下层分块）；
   *  - `instrument` / `playVoice`：音色与声部角色（色块着色用）；
   *  - `gain`（adj451）：**力度倍率**（与音频事件同源，缺省 1）——预留给强弱单（渐强/渐弱）与力度记号。
   */
  instrument?: string
  yTopMin?: number
  yBottomMax?: number
  playVoice?: 'accomp' | 'main' | 'second'
  gain?: number
}

export async function playScore(
  source: string,
  pageConfig: PageConfig = defaultPageConfig,
  opts?: { hqVoice?: number | null; workletUrl?: string; bankFiles?: BankFileStore | null },
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
    // adj352：SpessaSynth 高保真试听——音源远端下载 + IndexedDB 缓存，worklet 由插件提供
    // adj729：音源取用顺序改为 **插件目录文件 → IndexedDB → 下载**（见 soundbank.ts），
    //         这样"下载/导入过的音源"会以文件形式留在插件目录里、随文库一起同步。
    const bank = await loadHqBank(getHqLibrary(), new HqCache(), opts?.bankFiles ?? null)
    await backend.load(bank, opts.workletUrl)
  } catch (e) {
    backend.dispose()
    throw e instanceof Error ? e : new Error(String(e))
  }
  backend.setVoice(opts?.hqVoice ?? null)
  // 200ms 起播延迟（与 iJipu PLAY_FIRST_DELAY_MS 一致，声画同步）
  const control = schedulePlay(seq, backend, undefined, undefined, 200)
  // 构建播放色块轨道（与 iJipu 一致：按 playheadSegs 拍段，每段 ≤1 拍）
  // adj450：把引擎给出的边界/音色/声部角色/力度一并透传（此前只传 x/y/width，多声部色块退化）
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
      ...(s.instrument !== undefined ? { instrument: s.instrument } : {}),
      ...(s.yTopMin !== undefined ? { yTopMin: s.yTopMin } : {}),
      ...(s.yBottomMax !== undefined ? { yBottomMax: s.yBottomMax } : {}),
      ...(s.playVoice !== undefined ? { playVoice: s.playVoice } : {}),
      ...(s.gain !== undefined ? { gain: s.gain } : {}),
    })),
  )
  return { ...control, track }
}
