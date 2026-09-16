/**
 * obsidian-ijipu/src/playhead.ts — 试听色块定位与配色（纯函数，零 DOM）
 *
 * adj452：与 iJipu 应用 `src/preview/PreviewPane.tsx` 的色块逻辑**逐条对齐**（用户要求
 * 「先按你的建议补上 yTopMin/yBottomMax（高度）与 playVoice（声部角色），后面再考虑怎么完善」）。
 *
 * 插件此前只有「每个曲行取一个当前拍段」的一版简版：既不受引擎的**动态上下边界**
 * （`yTopMin/yBottomMax`，多声部/临时段按中线分块）约束，也不按**音色/声部角色**配色。
 * 抽成本模块的原因：纯函数可单测（`npm run smoke` 直接断言），且 scorePane 只做 DOM 绘制。
 */
import type { PlayheadSeg } from './render'

/** 播放色块调色板（与应用一致：红/蓝/绿/橙/紫/青/粉/橄榄） */
export const PLAYHEAD_COLORS = [
  'rgba(255, 93, 108,', // 红（第 1 个音色——单声部红块与 Q1 红）
  'rgba(87, 170, 255,', // 蓝
  'rgba(63, 122, 46,', // 绿（声部 3）
  'rgba(255, 200, 87,', // 橙（声部 4）
  'rgba(138, 95, 184,', // 紫（声部 5）
  'rgba(0, 188, 178,', // 青
  'rgba(226, 118, 176,', // 粉
  'rgba(150, 150, 90,', // 橄榄
]

/**
 * adj432：段内声部角色对应的**固定色**（优先于按音色推断）
 *  - `'accomp'`（`{bz}` 上层）= 蓝——伴奏声部
 *  - `'second'`（`{dsb}` 下层）= 绿——第二声部
 *  - `'main'`（`{dsb}` 上层）= 红——与主旋律同色
 */
export function segVoiceColor(role: 'accomp' | 'main' | 'second'): string {
  if (role === 'accomp') return 'rgba(87, 170, 255,'
  if (role === 'second') return 'rgba(63, 122, 46,'
  return 'rgba(255, 93, 108,'
}

/**
 * 按 (页, 曲行, 声部, 音色, 声部角色) 分组——**每组建一个色块**。
 *
 * 为什么键要含 `playVoice`：重叠区两层音色可能相同（谱面只写一条 `Y:` ⇒ 主旋律与 bz 伴奏
 * 回退到同一音色），只用 (页,曲行,声部,音色) 会把两层并成一组 ⇒ 只画一个色块。
 * 结果按 track 引用缓存（track 每次开播才换新对象），避免逐帧重建分组。
 */
let groupTrackCache: unknown = null
let groupCache = new Map<string, PlayheadSeg[]>()
export function trackKeysOf(track: PlayheadSeg[]): Map<string, PlayheadSeg[]> {
  if (groupTrackCache === track) return groupCache
  const m = new Map<string, PlayheadSeg[]>()
  for (const t of track) {
    const k = `${t.pageIndex}|${t.group}|${t.voice}|${t.instrument ?? ''}|${t.playVoice ?? ''}`
    const arr = m.get(k)
    if (arr) arr.push(t)
    else m.set(k, [t])
  }
  for (const arr of m.values()) arr.sort((a, b) => a.atMs - b.atMs)
  groupTrackCache = track
  groupCache = m
  return m
}

/**
 * adj427：按**音色**分配调色板序号——不同音色不同颜色，同一音色恒定同色。
 * 分配规则（保证既有观感不回退）：① 先把 voice 1 的音色排到第 1 位
 * （⇒ 单声部仍是红块、多声部 Q1 仍红、Q2 仍蓝）；② 其余按在轨道中出现的先后依次取色。
 */
let colorTrackCache: unknown = null
let colorCache = new Map<string, number>()
export function instrumentColorMap(track: PlayheadSeg[]): Map<string, number> {
  if (colorTrackCache === track) return colorCache
  const order: string[] = []
  const push = (inst: string | undefined): void => {
    const k = inst ?? ''
    if (!order.includes(k)) order.push(k)
  }
  for (const t of track) if (t.voice === 1) push(t.instrument)
  for (const t of track) push(t.instrument)
  const map = new Map<string, number>()
  order.forEach((inst, i) => map.set(inst, i % PLAYHEAD_COLORS.length))
  colorTrackCache = track
  colorCache = map
  return map
}

/** 取某拍段的半透明基色（adj432：声部角色优先 → 音色 → 声部序号） */
export function playheadBaseOf(
  pos: { voice: number; instrument?: string; playVoice?: 'accomp' | 'main' | 'second' },
  map: Map<string, number>,
): string {
  if (pos.playVoice) return segVoiceColor(pos.playVoice)
  const idx = map.get(pos.instrument ?? '') ?? (pos.voice - 1) % PLAYHEAD_COLORS.length
  return PLAYHEAD_COLORS[idx]
}

/** 色块位置（绝对坐标，与布局同一坐标系） */
export interface PlayheadPos {
  x: number
  yTop: number
  yBottom: number
  width: number
  voice: number
  instrument?: string
  playVoice?: 'accomp' | 'main' | 'second'
}

/**
 * 在一组的拍段序列里定位当前色块（二分：最后一个 `atMs <= currentMs` 的段）。
 * 返回 null = 未播放 / 不在本页 / 该段已播完（段间空隙不残留旧块）。
 *
 * adj429/adj452：**上下边界优先用引擎给的 `yTopMin`/`yBottomMax`**（多声部按声部中线分块、
 * 临时段按上下层分块，互不重叠、不压歌词）；两者缺一时回退到单声部默认
 * `[y − 1.6×字号, y + 0.6×字号]`（与应用 `PreviewPane.playheadPosIn` 同一公式与容差）。
 */
export function playheadPosIn(
  segs: PlayheadSeg[],
  currentMs: number,
  pageIndex: number,
  noteSize: number,
): PlayheadPos | null {
  if (segs.length === 0 || currentMs <= 0) return null
  let lo = 0
  let hi = segs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].atMs <= currentMs) lo = mid + 1
    else hi = mid
  }
  const i = lo - 1
  if (i < 0 || i >= segs.length) return null
  const a = segs[i]
  if (currentMs >= a.atMs + a.durationMs) return null
  if (a.pageIndex !== pageIndex) return null
  let yTop: number
  let yBottom: number
  if (a.yTopMin !== undefined && a.yBottomMax !== undefined) {
    yTop = a.yTopMin
    yBottom = a.yBottomMax
  } else {
    // 单声部默认（与 iJipu 应用同一公式）
    yTop = a.y - noteSize * 1.6
    yBottom = a.y + noteSize * 0.6
  }
  return {
    x: a.x,
    yTop,
    yBottom,
    width: a.width,
    voice: a.voice,
    ...(a.instrument !== undefined ? { instrument: a.instrument } : {}),
    ...(a.playVoice !== undefined ? { playVoice: a.playVoice } : {}),
  }
}
