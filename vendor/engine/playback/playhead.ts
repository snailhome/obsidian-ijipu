/**
 * engine/playback/playhead.ts — 试听**色块**的位置、分组与配色（纯函数，零 DOM）
 *
 * 用户 2026-10 要求：「**播放及色块显示**……等共性的功能都可以独立到引擎层面」，
 * 并且「应用端也应同样处理」。此前这份逻辑**两端各写一遍**：
 * 应用在 `src/preview/PreviewPane.tsx`、Obsidian 插件在 `src/playhead.ts`
 * （插件的文件头当时就写着"与应用逐条对齐"—— 靠人肉同步，早晚漂移）。
 * 现在收到引擎：两端只做"把色块画到 DOM/SVG"这一段宿主工作。
 *
 * 口径（逐字搬自两端既有实现，行为不变）：
 *  - 分组键 = `页 | 曲行 | 声部 | 音色 | 声部角色`——**必须含 `playVoice`**：
 *    重叠区上下两层音色可能相同（谱面只写一条 `Y:`），只用前四项会把两层并成一组 ⇒ 只画一个色块（E-2026-171）；
 *  - 配色 = 声部角色固定色（`accomp` 蓝 / `second` 绿 / `main` 红）优先 → 否则按音色分配调色板序号
 *    （先把 voice 1 的音色排到第 1 位 ⇒ 单声部仍是红块）；同一音色恒定同色；
 *  - 定位 = 在**该组**里二分"最后一个 `atMs <= currentMs` 的段"，且要求该段**正在发声**
 *    （`currentMs < atMs + durationMs`）—— 段间空隙（反复/跳房子跳跃）不残留旧块（adj313）；
 *  - 上下边界优先用引擎给的 `yTopMin`/`yBottomMax`（多声部/临时段按中线分块，不互相覆盖、不压歌词），
 *    缺一时回退单声部默认 `[y − 1.6×字号, y + 0.6×字号]`。
 */
/**
 * 色块轨道的**一项**（两端轨道项的最小公共字段集）。
 *
 * 为什么不用 `PlayheadSeg` 交叉 `{atMs,durationMs}`：两端建轨道的方式不同 ——
 * 插件从 `event.playheadSegs`（带 `beat`/`beats`）展开；应用是直接按事件建（没有那两个字段）。
 * 所以这里只声明**色块逻辑真正用到**的字段；两端的结构都天然满足（结构化类型）。
 */
export type PlayheadSegAt = {
  atMs: number
  durationMs: number
  pageIndex: number
  x: number
  y: number
  width: number
  voice: number
  group: number
  instrument?: string
  /** adj429：色块按曲行几何动态定界的上/下边界（引擎给出；缺省走单声部默认公式） */
  yTopMin?: number
  yBottomMax?: number
  /** adj432：段内声部角色（bz upper = 'accomp' / dsb upper = 'main' / dsb lower = 'second'） */
  playVoice?: 'accomp' | 'main' | 'second'
}

/** 播放色块调色板（两端一致：红/蓝/绿/橙/紫/青/粉/橄榄） */
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
 * 结果按 track 引用缓存（track 每次开播才换新对象），避免逐帧重建分组。
 */
let groupTrackCache: unknown = null
let groupCache = new Map<string, PlayheadSegAt[]>()
export function trackKeysOf(track: PlayheadSegAt[]): Map<string, PlayheadSegAt[]> {
  if (groupTrackCache === track) return groupCache
  const m = new Map<string, PlayheadSegAt[]>()
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
export function instrumentColorMap(track: PlayheadSegAt[]): Map<string, number> {
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
 */
export function playheadPosIn(
  segs: PlayheadSegAt[],
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
  // adj313：只在该段「正在发声」期间显示（段间空隙不残留旧行色块）
  if (currentMs >= a.atMs + a.durationMs) return null
  if (a.pageIndex !== pageIndex) return null
  let yTop: number
  let yBottom: number
  if (a.yTopMin !== undefined && a.yBottomMax !== undefined) {
    yTop = a.yTopMin
    yBottom = a.yBottomMax
  } else {
    /**
     * 单声部默认 —— 取**应用**那一版（`ext = 0.5×字号`，上下各留延伸）：
     * `yTop = y − 1.1n − ext = y − 1.6n`、`yBottom = y + 0.6n + ext = y + 1.1n`。
     *
     * ⚠ 收敛说明：插件此前写的是 `yBottom = y + 0.6n`（**少了下沿那 0.5n 延伸**），
     * 两端因此长得不一样（应用高一点、插件矮一点）。既然这次要"一份实现"，
     * 就按应用那版统一 —— 插件侧的色块会比以前**略高**（下沿多 0.5 字号）。
     */
    const ext = noteSize * 0.5
    yTop = a.y - noteSize * 1.1 - ext
    yBottom = a.y - noteSize * 1.1 + noteSize * 1.7 + ext
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
