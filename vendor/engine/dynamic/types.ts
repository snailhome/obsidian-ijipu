/**
 * engine/dynamic/types.ts — 动态谱（视频出片 / 后续 H5）的公共数据结构
 *
 * 为什么单独一层：动态谱要的是「**时间 → 画面**」的纯数据，视频（逐帧出图）和网页（逐帧重绘）
 * 消费同一份。把它放在引擎里，才能① 在 Node 里跑断言（视频必须可复现）、② 两端共用、
 * ③ 不把出片管线绑死在某个宿主上。
 *
 * 口径一律来自**试听**：`TimedRect` 的时间与几何就是 `PlaybackDialog` 建色块轨道时的算法
 * （`atMs = e.atMs + seg.beat × beatMs`、`durationMs = seg.beats × beatMs`），
 * 所以"视频里亮的"和"试听里亮的"必然是同一块。
 */
/**
 * 一个**定时矩形**（页面坐标）：在 `[t0, t1)` 这段时间里，页面上这一块要高亮。
 *
 * 为什么不是"每拍一条"：一拍里可能有多个声部同时发声（`{bz}` 伴奏、`{dsb}` 第二声部），
 * 它们各有自己的矩形。所以这一层是**扁平**的：一拍 N 个声部 = N 条，交给 `frameAt` 取"此刻哪些在响"。
 * 这样不需要"合并同拍"的规则，也就不会因为合并把某个声部弄丢（断言 D7）。
 */
export interface TimedRect {
  /** 起（含） */
  t0: number
  /** 止（不含）——半开区间，相邻两拍首尾相接不重叠 */
  t1: number
  pageIndex: number
  /** 左上角（页面坐标；`y` 已是矩形上沿，不是音符基线） */
  x: number
  y: number
  w: number
  h: number
  /**
   * 该音符的**基线 y**（= `PlayheadSeg.y`）。
   *
   * 为什么要单独留一份：`y` 是矩形上沿，可能被 `yTopMin` 改过（多声部/临时段），
   * 从 `y` 反推基线就不再可靠；而行归属必须按基线判，否则多声部里上下两排会被分到不同的行。
   */
  baselineY: number
  voice: number
  group: number
  /** 该段所用乐器（色块按音色着色，见 `playback/playhead.ts`） */
  instrument?: string
  /** 段内声部角色：`accomp` / `main` / `second`（决定固定配色） */
  playVoice?: 'accomp' | 'main' | 'second'
  /** 力度倍率（与音频事件同源，预留给强弱记号） */
  gain?: number
}

/**
 * 一条可查询的时间轴（矩形 + 预计算的跨度）。
 *
 * 为什么要包一层而不是直接传数组：`rectsActiveAt()` 要"往前扫到不可能再命中为止"，
 * 这需要一个**最大时长**做上界。每次调用都现算一遍是 O(n)，而视频要跑几千帧 ⇒ 预先算好。
 */
export interface RectTrack {
  /** 按 `t0` 升序（同刻按 页 → y → x → 声部 稳定排序，保证可复现） */
  rects: TimedRect[]
  /** 最长的一条时长（ms）——查当前时刻时的回溯上界 */
  maxSpanMs: number
  /** 整条时间轴的起止（空轨道时都是 0） */
  startMs: number
  endMs: number
  /** 参与建轨的拍段总数（含被丢弃的零时长段，仅供排查） */
  segCount: number
}

/**
 * 流式视图的一行 = 条带上的一"段"。
 *
 * 只记「**从哪一页的哪一段取图、贴到条带哪个位置**」，不存重排后的音符：
 *  - 反复时同一段音乐出现多次 ⇒ 多条 `FlowRow` 指向**同一组** `srcTop/srcBottom`，
 *    `stripY` 与 `pass` 不同。这样反复展开不用复制任何几何数据，也不额外占位图内存。
 *  - 行边界取相邻行中缝，所以各行的取图区间**不重叠、不漏**。
 */
export interface FlowRow {
  index: number
  pageIndex: number
  /** 页面坐标系里的取图区间（渲染时按它裁） */
  srcTop: number
  srcBottom: number
  /**
   * 这一行**内容**的上下界（音符 + 歌词，不含标题/页边）——相机按它居中。
   *
   * 为什么不能直接用 `srcTop/srcBottom`：第一行的取图带是从页顶起的（为了把标题带进条带），
   * 拿它居中会把镜头拉高、标题被放大到画面里（实测过）。两个用途，两对边界。
   */
  contentTop: number
  contentBottom: number
  /** 贴到条带上的纵坐标（条带坐标 = 页面 y 平移后的结果） */
  stripY: number
  /** 这一行在时间轴上的起止（含反复展开后的这一遍） */
  t0: number
  t1: number
  /** 第几遍（从 1 起；同一源行第二次出现 = 2） */
  pass: number
}

export interface FlowView {
  rows: FlowRow[]
  /** `RectTrack.rects` 每一项归属的条带行下标（等长；-1 = 没归进去，理论上不该出现） */
  rectRow: number[]
  /** 条带总高（像素坐标，不是位图） */
  stripHeight: number
  /** 画布尺寸（= 预设的宽高） */
  viewW: number
  viewH: number
  noteSize: number
}

/** 一帧里要画的高亮块（**条带坐标**，已按所在行平移） */
export interface FrameRect {
  x: number
  y: number
  w: number
  h: number
  voice: number
  group: number
  instrument?: string
  playVoice?: 'accomp' | 'main' | 'second'
}

/** `frameAt()` 的输出：这一帧滚动到哪、亮哪几块（纯数据，不含像素） */
export interface Frame {
  t: number
  /** 当前行在 `FlowView.rows` 里的下标 */
  row: number
  /** 竖直滚动量（0 ~ stripHeight - viewH） */
  scrollY: number
  rects: FrameRect[]
}
