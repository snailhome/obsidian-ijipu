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
  /**
   * adj1118：**间奏块**（`{jz N}` 的休止段）——固定中性灰，不按音色着色。
   *
   * 为什么必须单独标：间奏是"在这里等"，用主旋律的红色会让人以为还在唱。
   * 由 `buildPlaySequence` 的 `collapseSegsForInterlude` 打上，经 `buildRectTrack` /
   * 试听轨道一路透传给 `playheadBaseOf`。
   */
  interlude?: boolean
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
 * adj427 / **adj1095（用户 2026-10-23 实报「多声部各声部色块颜色没有区分开」）**：
 * 按 **（声部, 音色）** 分配调色板序号——**不同声部不同颜色**，同一声部内再按音色分。
 *
 * 以前只按音色名去重 ⇒ 两个声部用同一个音色（都写 `Y: 大钢琴`、或都没写 Y 而落到同一个默认音色）时
 * 色块**同色**，多声部在谱面上分不出来。用户口径是"各声部要能一眼分清"⇒ 声部先于音色：
 * 同一音色在不同声部也分色；同一"声部 + 音色"仍恒定同色。
 *
 * 分配规则（保证既有观感不回退）：① 先把 voice 1 的键排到最前（单声部仍是红块、主声部仍是红）；
 * ② 其余按在轨道里出现的先后依次取色。
 *
 * ⚠ **adj905（用户实测）：规则 ① 必须排除"段内声部"（带 `playVoice` 的项）**。
 *
 * 原来的写法是 `if (t.voice === 1) push(t.instrument)` —— 而 `{bz}` 段的伴奏音符
 * **`voice` 也是 1**（它跟主旋律同一条曲行，只是临时分出一层）。于是当伴奏音色
 * 在轨道里**先于主旋律出现**时（首页「铃儿响叮当」正是：`{bz …}` 写在段外主旋律之前），
 * 「手风琴」会抢走第 0 位（红），把主旋律的「大钢琴」挤到第 1 位 = **蓝**；
 * 而 `{bz}` 段本身靠 `playVoice === 'accomp'` 取**固定蓝** ⇒
 * **两块同色**，视觉上连成一片，用户看到的就是「宽度不一致、颜色没区分」。
 *
 * 段内声部（`accomp` / `second` / `main`）的颜色由 `segVoiceColor` 固定给出，
 * **不该参与调色板分配** —— 排除它们，主旋律才能稳稳拿回红色。
 *
 * @param track 只读 `voice` / `instrument` / `playVoice` 三个字段（视频侧的 `TimedRect`
 *   也能直接传进来，所以参数用最小形状而不是 `PlayheadSegAt`）
 */
const colorKeyOf = (voice: number, instrument?: string): string => `${voice}|${instrument ?? ''}`
let colorTrackCache: unknown = null
let colorCache = new Map<string, number>()
export function instrumentColorMap(
  track: readonly {
    voice: number
    instrument?: string
    playVoice?: 'accomp' | 'main' | 'second'
  }[],
): Map<string, number> {
  if (colorTrackCache === track) return colorCache
  const order: string[] = []
  const push = (t: { voice: number; instrument?: string }): void => {
    const k = colorKeyOf(t.voice, t.instrument)
    if (!order.includes(k)) order.push(k)
  }
  /** 段内声部（有 playVoice）有固定色，不参与调色板（adj905） */
  const isInsideSegment = (t: { playVoice?: 'accomp' | 'main' | 'second' }): boolean =>
    t.playVoice !== undefined
  for (const t of track) if (t.voice === 1 && !isInsideSegment(t)) push(t)
  for (const t of track) if (!isInsideSegment(t)) push(t)
  const map = new Map<string, number>()
  order.forEach((k, i) => map.set(k, i % PLAYHEAD_COLORS.length))
  colorTrackCache = track
  colorCache = map
  return map
}

/**
 * adj905b（用户口径）：**同一拍位、同样时值、且短于 1 拍的上下两层，色块取「交集」对齐**。
 *
 * 用户原话：
 * > 「多声部首先**拍子对齐**，这一步应该是没有问题的；**小于 1 拍的**，如果上下的时值一样
 * > **右边界最小的那个对齐**，这个就**不会压到下一音符的左边界**的情况；这样处理应该可以解决。」
 *
 * ## 为什么取 `min`（交集）而不是 `max`（并集）
 *
 * 实测同拍位两层各自的槽是：
 * ```
 * 伴奏层 1,   62.4 ~ 91.2
 * 主旋律 3    56.0 ~ 87.2
 * ```
 * 取**并集**（右界取 `max`）会让窄的那层**越出自己的槽** —— 正是 `Z8e` 守着的、
 * 用户早年报过的「色块盖到后一个音符」。取**交集**则两侧都不越界，两块还完全对齐。
 *
 * ## 三条限定（缺一不可）
 *
 * - **只处理 < 1 拍的段**：长音（含增时线/附点）右界另有口径（`adj374` 要求盖住末格增时线），
 *   一起取 min 会盖不住增时线；
 * - **时值必须相同**（分组键含 `beats`）：上下时值不同时右界本就该不同，硬对齐是错的；
 * - **必须是不同声部角色**（组内 `playVoice` 至少两种）：同一层的多拍拆分不动。
 *
 * ## 为什么在"色块显示层"做
 *
 * `playheadSegs` 是**只服务于色块**的数据（音频走 `atMs`/`durationMs`/`pitch`/`instrument`）
 * ⇒ 调它的水平几何**只影响色块显示**，播放层与布局层**一个字节都不动**
 * （用户原话：「播放层不变，只是色块显示层有变化」）。
 */
type AlignSeg = {
  pageIndex: number
  group: number
  voice: number
  x: number
  width: number
  /** 引擎内部生成时带（`PlayheadSeg`）；色块消费侧（`PlayheadSegAt`）没有也不影响本函数 */
  beat?: number
  beats?: number
  playVoice?: 'accomp' | 'main' | 'second'
}

export function alignSameBeatSegs(
  events: readonly { atMs: number; playheadSegs?: AlignSeg[] }[],
): void {
  /** 键 = 页|曲行|声部|绝对时间|段内拍位|时值（同键 = 同一拍位、同样时值的段） */
  const groups = new Map<string, AlignSeg[]>()
  for (const e of events) {
    for (const s of e.playheadSegs ?? []) {
      /**
       * 限定 ①：只处理**不超过 1 拍**的段。
       *
       * ⚠ 最初写的是 `< 1`（照用户"小于 1 拍的"字面），结果**一个都没生效** ——
       * `{bz}` 那一层与主旋律的段都**正好是 1 拍**。用户举例说"小于 1 拍"说的是**细分音符**那类，
       * 而对齐的目标本身常常就是 1 拍 ⇒ 取 **`≤ 1`**。
       * 长音（>1 拍，含增时线/附点）仍不参与：它们的右界另有口径（`adj374` 要盖住末格增时线）。
       */
      if (!(typeof s.beats === 'number' && s.beats > 0 && s.beats <= 1)) continue
      const k = `${s.pageIndex}|${s.group}|${s.voice}|${Math.round(e.atMs)}|${s.beat ?? 0}|${s.beats}`
      const arr = groups.get(k)
      if (arr) arr.push(s)
      else groups.set(k, [s])
    }
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    // 限定 ③：确实是"上下两层"（角色不同）才动；同层多段保持原样
    const roles = new Set(arr.map((s) => s.playVoice ?? 'main'))
    if (roles.size < 2) continue
    /**
     * 限定 ②：同组内时值已经相同（键含 `beats`）。
     *
     * ⚠ **只统一右边界，左边界一律不动** —— 这是用户口径的原话（「**右边界最小的那个对齐**」），
     * 而且实测也证明必须如此：
     *  · 左边界是"起始音符"的锚点，`AL6` 明确要求「左端 = 起始音符」；
     *    `{dsb}` 上层在 141.71、下层的起始音符在 152.90，把上层拉到 152.90 或把下层拉到 141.71
     *    都会破坏那条断言（我第一版连左边一起取 min，正是这样撞红的）；
     *  · 用户对左边界的态度是「拍子对齐，这一步应该是没有问题的」—— 即**不要求改左**。
     *
     * 取 `min`（最小右缘）而不是 `max`：后者会让窄的那层越出自己的槽（`Z8e` 守着的旧问题）。
     * 结果：**两层的右边界完全对齐**，左边界各自保持 → 宽度可能仍略有差异，但视觉上的
     * "一条块的右端"是齐的。
     */
    let right = Number.POSITIVE_INFINITY
    for (const s of arr) right = Math.min(right, s.x + s.width)
    for (const s of arr) {
      if (right > s.x) s.width = right - s.x
    }
  }
}

/**
 * adj1118：**间奏块**的固定色（中性灰）。
 *
 * 为什么不用调色盘里的任何一色：间奏段在谱面上就是一个 `0`，"红块停在 0 上 16 拍"
 * 看起来像还在唱；灰色是"此处静默等待"的通用语言（与色块/跳跳球同一套透明度）。
 */
export const INTERLUDE_COLOR = 'rgba(120, 124, 130,'

/**
 * 取某拍段的半透明基色（adj432：声部角色优先 → **声部 + 音色**盘 → 声部序号兜底）。
 *
 * adj1095：调色键与 `instrumentColorMap` 同源（`声部|音色`），所以"同音色不同声部"也分色。
 * adj1118：间奏块优先取中性灰（`interlude: true`）。
 */
export function playheadBaseOf(
  pos: { voice: number; instrument?: string; playVoice?: 'accomp' | 'main' | 'second'; interlude?: boolean },
  map: Map<string, number>,
): string {
  if (pos.interlude) return INTERLUDE_COLOR
  if (pos.playVoice) return segVoiceColor(pos.playVoice)
  const idx = map.get(colorKeyOf(pos.voice, pos.instrument)) ?? (pos.voice - 1) % PLAYHEAD_COLORS.length
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
  /** adj1118：间奏块（中性灰） */
  interlude?: boolean
}

/**
 * 在一组的拍段序列里定位当前色块（二分：最后一个 `atMs <= currentMs` 的段）。
 * 返回 null = 未播放 / 不在本页 / 该段已播完（段间空隙不残留旧块）。
 *
 * adj1062：**时间源只有一个 = 色块的 `atMs`**。球的拍点会吸附到同一个 `atMs`
 * （见 `dynamic/ball.ts` 的 `beatTimesOf`），所以这里不需要任何提前/容差；
 * 两边在同一个数上切换。
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
    // adj1118：间奏块一路传到取色（`playheadBaseOf` 见 interlude 就返回中性灰）
    ...(a.interlude === true ? { interlude: true } : {}),
  }
}
