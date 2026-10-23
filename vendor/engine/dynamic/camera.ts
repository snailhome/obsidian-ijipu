/**
 * engine/dynamic/camera.ts — 动态谱「相机」：给定时刻，决定看页面的哪一块、放大多少
 *
 * ## 为什么是"相机"而不是"重新排版"
 *
 * 重新排版要把标题/作者/歌词/行距在每种画布比例下重调一遍，永远追不上应用里那套调好的 A4 规则
 * （实测：9:16 下标题会和作者撞在一起）。相机方案**不动版面**，只决定"镜头对着哪、推多近"：
 *   - 用户自己的字体、主题、分页原样进视频；
 *   - "放大"是连续的推镜头，不是改字号；
 *   - 9:16 / 1:1 / 16:9 只是取景框比例不同。
 *
 * ## 片子里的四个阶段
 *
 * ```
 *  t < 第一拍        满宽（zoomFit）：标题、作者、整页都看得见
 *  第一拍 ~ +introMs  平滑推近到 zoomFollow，同时把第一行移到画面中央
 *  跟拍              横向"安全区"推移（与试听的 followScroll 同一套手感），纵向按行平移
 *  最后一拍之后       停在最后一行，不缩回
 * ```
 *
 * ## 纯函数约定
 *
 * `buildCameraTrack` 可以带状态（建表时扫一遍），但 `cameraAt` 必须是 `t` 的纯函数：
 * 不读上一帧、不读时钟。否则视频不可复现（同一个 t 两帧不一样）。
 */
import { PAPER_SIZE, type PageConfig } from '../types'
import type { FlowView, RectTrack } from './types'

/** 默认跟拍倍数（屏幕像素 / 页面单位）。4 倍时 9:16 取景框约覆盖 270×480，音符约 72px */
export const CAMERA_FOLLOW_ZOOM = 4
/** 片头推近时长（ms） */
export const CAMERA_INTRO_MS = 700
/** 换行平移时长（ms）——在"该行第一拍"之前完成 */
export const CAMERA_LINE_MS = 350
/** 横向跟拍过渡时长（ms） */
export const CAMERA_PAN_MS = 450
/** 安全区半宽（占取景框宽的比例）：当前音超出这个范围才推镜头 */
export const CAMERA_SAFE_HALF = 0.25
/**
 * adj1086/adj1089：左右露白的上限（占取景框宽的比例）。
 *
 * 口径：**按行内容**（色块覆盖范围）算，不是纸张边距——
 *   · 行首时，行内容左缘离画面左缘不许超过 10%；
 *   · 行末时，行内容右缘离画面右缘不许超过 10%；
 *   · 整行放得下（行宽 + 两侧 10% 余量 ≤ 视宽）⇒ 取行中心、不平移。
 *
 * 预览（`src/preview/followScroll.ts`）与出片（本文件）**共用这一个值**，
 * 免得两边各写 0.1、改一处忘一处（AGENTS 六之二·4「数值口径必须同源」）。
 */
export const CAMERA_WHITE_MARGIN = 0.1

/**
 * adj1089：把一个"相机中心 cx"夹到某一行内容的允许范围里（出片与预览共用同一套算式）。
 *
 * ## 推导（为什么符号是加 halfW）
 *
 * `cx` 是**取景框中心**，取景框半宽 `halfW = worldW / 2`（都是页面单位）。
 * 行内容左右缘 `x0..x1`，露白上限 `m = worldW × marginRatio`：
 * ```
 * 行首露白 = x0 − (cx − halfW) ≤ m   ⇒ cx ≥ x0 + halfW − m
 * 行末露白 = (cx + halfW) − x1 ≤ m   ⇒ cx ≤ x1 − halfW + m
 * ```
 * ⇒ `cx ∈ [x0 + halfW − m, x1 − halfW + m]`。
 *
 * 区间为空（`leftLimit ≥ rightLimit`，即 `行宽 + 2m ≤ worldW`）⇒ 整行放得下，取行中心。
 *
 * ⚠ **adj1089 修正**：adj1088 提交时把两个 halfW 的符号写反了
 * （写成 `x0 − halfW + m` / `x1 + halfW − m`），那组边界实际只约束"露白 ≤ 90%"，
 * 于是行首/行末可以露出大半个画面，而"整行放得下"分支永远不会命中。
 * 断言见 smoke `[D] 相机平移模式`。
 *
 * @param x0/x1     行内容的左右缘（页面单位；没量到可传 ±Infinity）
 * @param worldW    取景框宽（页面单位，= 画布像素宽 / 缩放）
 * @param marginRatio 露白上限占取景框宽的比例（正常是 `CAMERA_WHITE_MARGIN`）
 * @param want      想放的中心
 */
export function clampRowCenter(
  x0: number,
  x1: number,
  worldW: number,
  marginRatio: number,
  want: number,
): number {
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return want
  const halfW = worldW / 2
  const m = worldW * marginRatio
  const leftLimit = x0 + halfW - m
  const rightLimit = x1 - halfW + m
  if (leftLimit >= rightLimit) return (x0 + x1) / 2
  return Math.max(leftLimit, Math.min(rightLimit, want))
}

export interface CameraOptions {
  /** 成片画布像素宽高 */
  viewW: number
  viewH: number
  /** 跟拍倍数（缺省 4） */
  followZoom?: number
  introMs?: number
  lineMs?: number
  panMs?: number
  safeHalf?: number
  /**
   * 跳过"满宽片头"（标记段导出用）。
   *
   * 片头满宽是给整曲开头展示曲名的；从中间某段开始导出时，先给一整页再猛地推回段首，
   * 观众会晕 ⇒ 段导出直接以跟拍倍数起步。
   */
  skipIntro?: boolean
  /**
   * 片头要对准的纵向中心（页面坐标）——一般是**描述头**（标题/作者/调号）的中间。
   * 缺省按页高 15% 兜底。
   */
  headerCy?: number
  /**
   * adj1086（用户口径）：行中平移方式（取值见 `PanMode`）。
   *
   * - `follow`：色块到画面右 4/5 才推，一次推到左 1/5；
   * - `beat`：每**拍**移一次，尽量把当前拍的色块放在画面中间；
   * - `bar`：每**小节**移一次，同上（小节内越过 4/5 时另有安全推）。
   *
   * 三种都受"左右露白 ≤ 画面 10%"约束（见 `CAMERA_WHITE_MARGIN` / `clampRowCenter`）。
   * ⚠ 引擎缺省仍是 `follow`（库层不猜用户偏好）；**应用/命令行宿主默认传 `beat`**（adj1094 起）。
   */
  panMode?: PanMode
  /** 一拍多少毫秒（`beat` 模式要） */
  beatMs?: number
  /** 小节起点时刻（`bar` 模式要；与 track 同一时间轴，升序） */
  bars?: readonly number[]
  /**
   * adj1094：**行末提前平移量**（ms）——换到下一行（横向平移 + 纵向换行）提前这么多毫秒**完成**。
   *
   * 用户口径：默认半拍、可调到最多 2 拍；`0` = 正好在行首那一下换行（旧行为）。
   * 宿主按 `beatMs × 拍数` 换算后传进来，引擎不猜拍速。
   */
  rowLeadMs?: number
}

/**
 * adj1089：行中平移方式（`uiStore` 的 L1 偏好、出片与试听共用这一份取值）。
 *
 * 为什么放进引擎：它是**相机行为的取值域**，不是界面文案——宿主只负责记住用户选了哪个，
 * 校验规则必须与 `buildCameraTrack` 认的三种一致（写错一个值就静默变成 follow）。
 */
export type PanMode = 'follow' | 'beat' | 'bar'

/** 相机某一刻的位置（页面坐标系 + 缩放） */
export interface CameraFrame {
  pageIndex: number
  /** 画面中心（页面坐标） */
  cx: number
  cy: number
  /** 屏幕像素 / 页面单位 */
  zoom: number
}

/** 条带上的一行 → 相机的一段（时间、页、纵向中心） */
export interface CameraRow {
  t0: number
  t1: number
  pageIndex: number
  cy: number
}

/** 横向关键帧（只在"该推了"的时候记一条） */
export interface CameraPan {
  t: number
  cx: number
  /** 这次推移从何时开始（缺省 = t − panMs）。**换行时 = t**：绝不提前离开上一行 */
  from: number
  /** 推移时长（换行时约 0：在行边界上直接归位） */
  dur: number
}

export interface CameraTrack {
  viewW: number
  viewH: number
  pageW: number
  pageH: number
  /** 满宽（整页并排进去）的缩放 */
  zoomFit: number
  zoomFollow: number
  /** 推近结束时刻（= 第一拍 + introMs） */
  zoomEnd: number
  firstT: number
  rows: CameraRow[]
  pans: CameraPan[]
  /** 每条矩形的起始时间（升序；相机按"当前正在响的那条"反推行，保证和色块同页同排） */
  rectT0: number[]
  /** 每条矩形归属的行下标（与 `rectT0` 等长） */
  rectRow: number[]
  introMs: number
  lineMs: number
  panMs: number
  /**
   * adj1094：**行末提前平移量**（ms）——换行（横向 + 纵向）提前这么多毫秒**完成**。
   * 0 = 正好在行首那一下换行（旧行为）；默认由宿主按"半拍"换算传进来。
   */
  rowLeadMs: number
  /** 片头对准的纵向中心（描述头中间） */
  headerCy: number
}

/** 平滑缓动（0→1，两端速度为 0） */
function ease(x: number): number {
  const c = Math.max(0, Math.min(1, x))
  return c * c * (3 - 2 * c)
}

/**
 * 建相机表。
 *
 * @param view 用**用户自己的页面配置**建出来的流式视图（行按演奏顺序，含反复）
 * @param cfg  同一份 `PageConfig`（只取 `page` 定页宽页高）
 */
export function buildCameraTrack(
  view: FlowView,
  track: RectTrack,
  cfg: PageConfig,
  opts: CameraOptions,
): CameraTrack {
  const paper = PAPER_SIZE[cfg.page]
  const viewW = opts.viewW
  const viewH = opts.viewH
  const skipIntro = opts.skipIntro === true
  const zoomFollow = opts.followZoom ?? CAMERA_FOLLOW_ZOOM
  const introMs = skipIntro ? 0 : (opts.introMs ?? CAMERA_INTRO_MS)
  const lineMs = opts.lineMs ?? CAMERA_LINE_MS
  const panMs = opts.panMs ?? CAMERA_PAN_MS
  /**
   * adj1094：行末提前平移量（换行完成的时刻 = 行首 − 它）。
   * 默认 0（引擎不猜拍速）；宿主按"半拍/1 拍…"换算后传进来。
   */
  const rowLeadMs = Math.max(0, opts.rowLeadMs ?? 0)

  // 段导出不演"满宽片头"：一上来就是跟拍倍数
  const zoomFit = skipIntro ? zoomFollow : viewW / paper.width
  const firstT = view.rows.length > 0 ? view.rows[0].t0 : 0
  const headerCy = opts.headerCy ?? paper.height * 0.15

  const rows: CameraRow[] = view.rows.map((r) => ({
    t0: r.t0,
    t1: r.t1,
    pageIndex: r.pageIndex,
    // 按**行内容**居中（音符 + 歌词），不按取图带——第一行的带是从页顶起的，会把标题拉进画面
    cy: (r.contentTop + r.contentBottom) / 2,
  }))

  /**
   * 横向关键帧：**两段式**（用户口径）——色块走到画面右 4/5 才推，一次推到左 1/5。
   *
   * 换算：色块在 4/5 处 ⇒ 距画面中心 +0.6×半宽（= (2×0.8−1)）；
   * 要把它放到 1/5 处 ⇒ 新中心 = 色块 + 0.6×半宽（对称，偏移量相同）。
   * 于是色块在 20%~80% 之间自由走，越界就平移半个多一点，观感像翻谱。
   */
  const halfW = viewW / zoomFollow / 2
  const sweep = halfW * 0.6
  /**
   * adj1086（用户口径）：**左右露白 ≤ 画面 10%**，三种平移模式共用的夹紧。
   *
   * - 一行谱整行放得下（行宽 + 两侧 10% 余量 ≤ 视宽）⇒ **不平移**，取行中心；
   * - 放不下 ⇒ 行首时左侧露白 ≤10%，行末时右侧露白 ≤10%。
   *
   * "露白"按**行内容**（色块覆盖范围）算，不看纸张边距。
   * 算式与常量都收敛在 `clampRowCenter`（adj1089 修正符号；预览侧共用同一个函数）。
   */
  const rowX0: number[] = rows.map(() => Number.POSITIVE_INFINITY)
  const rowX1: number[] = rows.map(() => Number.NEGATIVE_INFINITY)
  for (let i = 0; i < track.rects.length; i++) {
    const ri = view.rectRow[i]
    if (ri < 0 || ri >= rows.length) continue
    rowX0[ri] = Math.min(rowX0[ri], track.rects[i].x)
    rowX1[ri] = Math.max(rowX1[ri], track.rects[i].x + track.rects[i].w)
  }
  const worldW = viewW / zoomFollow
  const clampRow = (rowIdx: number, want: number): number =>
    clampRowCenter(rowX0[rowIdx], rowX1[rowIdx], worldW, CAMERA_WHITE_MARGIN, want)
  const pans: CameraPan[] = []
  let cx = paper.width / 2
  let lastRow = -1
  let rowStartT = firstT
  for (let i = 0; i < track.rects.length; i++) {
    const r = track.rects[i]
    const rowIdx = view.rectRow[i]
    if (rowIdx < 0) continue
    // 换行：本行的第一个音 ⇒ 横移**在行边界上归位**，不许提前（否则上一行最后一个音会被挤出框）
    const isRowStart = rowIdx !== lastRow
    if (isRowStart) {
      lastRow = rowIdx
      rowStartT = r.t0
    }
    const rectCx = r.x + r.w / 2
    if (!isRowStart) {
      if (rectCx > cx + sweep) cx = rectCx + sweep
      else if (rectCx < cx - sweep) cx = rectCx - sweep
      else continue
    } else {
      cx = rectCx + sweep
    }
    // adj1086：先按"露白 ≤10%"夹紧（整行放得下就居中、不平移），再保证中心落在页内
    cx = clampRow(rowIdx, cx)
    cx = Math.max(0, Math.min(paper.width, cx))
    const last = pans[pans.length - 1]
    if (last && Math.abs(last.cx - cx) < 0.5) continue
    pans.push(
      isRowStart
        ? { t: r.t0, cx, from: r.t0, dur: 0 }
        : { t: r.t0, cx, from: Math.max(rowStartT, r.t0 - panMs), dur: panMs },
    )
  }
  /**
   * adj1086：`beat` / `bar` 两种模式——按拍或按小节，把当前色块尽量放到画面中间，
   * 再走同一套"露白 ≤10%"夹紧。换行时仍以行首那条色块为准。
   */
  const panMode = opts.panMode ?? 'follow'
  if (panMode !== 'follow') {
    const rectIndexAt = (t: number): number => {
      for (let i = 0; i < track.rects.length; i++) {
        const r = track.rects[i]
        if (r.t0 <= t && t < r.t1) return i
      }
      return -1
    }
    /** 此刻没有色块（休止/呼吸缝）⇒ 找**下一块**：镜头先到它那儿等着，别留在上一块 */
    const nextRectAtOrAfter = (t: number): number => {
      let best = -1
      for (let i = 0; i < track.rects.length; i++) {
        const r = track.rects[i]
        if (r.t0 >= t && (best < 0 || r.t0 < track.rects[best].t0)) best = i
      }
      return best
    }
    const bt = opts.beatMs ?? 0
    const barList = (opts.bars ?? []).filter((b) => b >= firstT && b <= track.endMs)
    /** 拍/小节 tick；`rectIndex` = 行首那条（时间取该行第一块自己的 t0，不取网格时刻） */
    const ticks: { t: number; rowStart: boolean; rectIndex?: number }[] = []
    if (panMode === 'beat' && bt > 0) {
      for (let t = firstT; t <= track.endMs; t += bt) ticks.push({ t, rowStart: false })
    } else if (panMode === 'bar') {
      for (const b of barList) ticks.push({ t: b, rowStart: false })
    }
    /**
     * adj1092（用户实报「按小节时，从行末移到行首不会平移，行首那一小节看不到」）：
     * **每个曲行无条件补一条行首关键帧**。
     *
     * 为什么必须无条件：拍/小节网格的时刻来自 `seq.barStartsMs`（按拍数累加），
     * 而色块时刻来自事件（含呼吸缝/附点/倚音，二者会差几毫秒）；网格落在**上一块还没结束**的地方时，
     * `rectIndexAt(网格时刻)` 拿到的是**上一行**的块 ⇒ 那条关键帧把镜头对回旧行，
     * 新行行首就没有自己的平移（用户看到的就是"行首一小节看不到"，要等下一小节才回来）。
     *
     * 所以：行首关键帧的时刻取**该行第一块自己的 `t0`**、目标取**这一块的夹紧中心**，
     * 并把同一时刻附近的拍/小节 tick **让位**（保留会互相覆盖，且那条可能是按旧行算的）。
     */
    const rowFirstRect: number[] = rows.map(() => -1)
    for (let i = 0; i < track.rects.length; i++) {
      const ri = view.rectRow[i]
      if (ri < 0 || ri >= rows.length) continue
      if (rowFirstRect[ri] < 0) rowFirstRect[ri] = i
    }
    for (const i of rowFirstRect) {
      if (i < 0) continue
      const t0 = track.rects[i].t0
      // adj1094：换行**提前** rowLeadMs 完成（默认半拍）；0 = 正好在行首那一下
      const t = Math.max(firstT, t0 - rowLeadMs)
      for (let k = ticks.length - 1; k >= 0; k--) {
        // 让位窗口：从"提前量的起点"到行首。窗口内的小节/拍 tick 若保留，会在行首平移**之后**
        // 把镜头又拉回上一行（提前量越大越明显），所以一律让给行首平移。
        if (ticks[k].t >= t - 0.5 && ticks[k].t <= t0 + 0.5) ticks.splice(k, 1)
      }
      ticks.push({ t, rowStart: true, rectIndex: i })
    }
    /**
     * adj1093（用户 2026-10-23 实报）：**行内 4/5 安全推**。
     *
     * 用户原话：「有时下一小节已经很贴近右视界了，而按小节平移也要到色块接近小节线再平移，
     * 这会导致一小节视谱偏晚而衔接不上……在到达视界 4/5 的时候，如果还没到达下一小节，也要平移；
     * （除非是在一行的最后一个小节，可以不遵守 4/5 的要求，因为有露白 10% 的限制）」
     *
     * 做法：`bar` 模式下，除"行首"与"小节线"两个时刻外，**每个色块起点也作为检查点**：
     * 当前镜头下它的中心越过 4/5（`cx + sweep`）就推一次（推到 1/5，与跟随模式同一手感），
     * 但**本行最后一个小节里不推**——那里由"行末右侧露白 ≤10%"的夹紧接管，
     * 推了反而看不到行末那几拍。
     */
    const lastBarOfRow: number[] = rows.map((r) => {
      let last = Number.NEGATIVE_INFINITY
      for (const b of barList) if (b >= r.t0 - 0.5 && b <= r.t1 - 0.5 && b > last) last = b
      return last
    })
    type Checkpoint = { t: number; kind: 'row' | 'tick' | 'push'; rectIndex: number }
    const checks: Checkpoint[] = []
    for (const k of ticks) checks.push({ t: k.t, kind: k.rowStart ? 'row' : 'tick', rectIndex: k.rectIndex ?? -1 })
    if (panMode === 'bar') {
      for (let i = 0; i < track.rects.length; i++) {
        const ri = view.rectRow[i]
        if (ri < 0 || ri >= rows.length) continue
        // 本行最后一个小节：不推（交给 10% 露白夹紧）
        if (!Number.isFinite(lastBarOfRow[ri])) continue
        if (track.rects[i].t0 >= lastBarOfRow[ri] - 0.5) continue
        checks.push({ t: track.rects[i].t0, kind: 'push', rectIndex: i })
      }
    }
    const rank = (k: Checkpoint['kind']): number => (k === 'row' ? 0 : k === 'tick' ? 1 : 2)
    checks.sort((a, b) => a.t - b.t || rank(a.kind) - rank(b.kind))
    pans.length = 0
    let cx = paper.width / 2
    for (const k of checks) {
      let i = k.rectIndex
      if (k.kind !== 'push') {
        if (i < 0) i = rectIndexAt(k.t)
        if (i < 0) i = nextRectAtOrAfter(k.t)
        if (i < 0) continue
      } else if (i < 0) continue
      const ri = view.rectRow[i]
      const rectCx = track.rects[i].x + track.rects[i].w / 2
      if (k.kind === 'push' && rectCx <= cx + sweep) continue // 还没到 4/5
      const wantCx = Math.max(0, Math.min(paper.width, clampRow(ri, rectCx)))
      if (Math.abs(wantCx - cx) < 0.5) {
        cx = wantCx
        continue
      }
      cx = wantCx
      pans.push(
        k.kind === 'row'
          ? { t: k.t, cx, from: k.t, dur: 0 }
          : { t: k.t, cx, from: Math.max(rows[ri]?.t0 ?? firstT, k.t - panMs), dur: panMs },
      )
    }
  }

  if (pans.length === 0) pans.push({ t: firstT, cx: paper.width / 2, from: firstT, dur: 0 })

  return {
    viewW,
    viewH,
    pageW: paper.width,
    pageH: paper.height,
    zoomFit,
    zoomFollow,
    zoomEnd: firstT + introMs,
    firstT,
    rows,
    pans,
    rectT0: track.rects.map((r) => r.t0),
    rectRow: [...view.rectRow],
    introMs,
    lineMs,
    panMs,
    rowLeadMs,
    headerCy,
  }
}

/**
 * 某时刻所在的行段——**由当前音符反推**，而不是按行自己的起始时间。
 *
 * 为什么必须这样：行的时间（`row.t0`=该行第一个音的时刻）与"此刻正在响的是哪一行"在多声部、
 * 临时段层、跨行连音时**不一定同步**；按行时间选行，相机会跑到别的排甚至别的页上，
 * 于是色块被"同页过滤"掉（用户实测：6.7 秒时框里是后面的页，第一行的色块消失）。
 */
function rowAt(cam: CameraTrack, t: number): { row: CameraRow; prev?: CameraRow } {
  const { rows, rectT0, rectRow } = cam
  if (rows.length === 0) {
    return { row: { t0: 0, t1: 0, pageIndex: 0, cy: cam.pageH / 2 } }
  }
  // 二分：最后一个 t0 <= t 的矩形
  let lo = 0
  let hi = rectT0.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rectT0[mid] <= t) lo = mid + 1
    else hi = mid
  }
  const idx = lo - 1
  const ri = idx >= 0 && rectRow[idx] >= 0 ? rectRow[idx] : 0
  const row = rows[ri] ?? rows[0]
  return { row, prev: ri > 0 ? rows[ri - 1] : undefined }
}

/**
 * 出相机。**必须是 t 的纯函数**（同一个 t 永远同一结果）。
 */
export function cameraAt(cam: CameraTrack, t: number): CameraFrame {
  /**
   * adj1094：换行的纵向/换页要**提前 `rowLeadMs` 完成**，因此行判定也提前
   * `rowLeadMs + lineMs`（过渡时长）——这样过渡正好在 `行的第一块 − rowLeadMs` 结束，
   * 而不是像旧行为那样在行首之后才慢慢移过去。
   * `rowLeadMs = 0`（用户明确选"行首那一下才换行"）⇒ 不提前，仍在行首切换（瞬间归位）。
   */
  const leadShift = cam.rowLeadMs > 0 ? cam.rowLeadMs + cam.lineMs : 0
  // `rowAt` 取"最后一个 t0 ≤ t 的矩形"所在行，超出末尾自然停在最后一行，不需要另外钳
  const { row, prev } = rowAt(cam, t + leadShift)

  // 片头进度：0 = 整页满宽，1 = 完全进入跟拍。缩放、横移、纵移都按这一个 k 走，
  // 否则会出现"先跳过去再推近"（用户实测："刚开始播放时没有平移，色块不在视界里"）。
  // 片头推近：**在第一拍之前完成**（第一拍响起时画面已经到位）
  const introK =
    cam.introMs <= 0
      ? 1
      : ease((t - (cam.firstT - cam.introMs)) / Math.max(1, cam.introMs))
  const zoom = cam.zoomFit + (cam.zoomFollow - cam.zoomFit) * introK

  // 纵向：换行的平移**提前 rowLeadMs 完成**（adj1094）；不提前时就是原来的"从行边界开始"
  let cy = row.cy
  if (prev && row.t0 > prev.t0) {
    const lineEnd = row.t0 - cam.rowLeadMs
    const k = ease((t - (lineEnd - cam.lineMs)) / Math.max(1, cam.lineMs))
    cy = prev.cy + (row.cy - prev.cy) * k
  }
  // 片头从整页中心平滑过渡到当前行
  /**
   * adj1063（用户 2026-10-22 实报「动态谱片头没有平移到描述头」）：
   * 片头的纵向中心必须用 `headerCy`（描述头中间），不能用 `pageH/2`——
   * 旧代码虽然把 `headerCy` 建进轨道，但这里从来没读它，片头永远停在整页中心，
   * 描述头（标题/作者/调号）只是缩在画面顶部，看着就是"没平移过去"。
   *
   * 目标 `followCy` 先按**跟拍倍数**夹紧，片头阶段不再二次夹紧：
   * 否则 9:16 满宽时 `pageH/2` 会把 headerCy 顶掉，或者中途被夹到一半跳一下。
   * 片头允许描述头上下留白；推近完成后 `introK=1`，cy 正好等于 followCy，接上正常跟拍。
   */
  const hhFollow = cam.viewH / cam.zoomFollow / 2
  const followCy =
    cam.pageH <= 2 * hhFollow
      ? cam.pageH / 2
      : Math.max(hhFollow, Math.min(cam.pageH - hhFollow, cy))
  cy = cam.headerCy + (followCy - cam.headerCy) * introK

  // 横向：按关键帧的 from/dur 推移；换行那一帧 dur=0，直接在边界上归位
  let cx = cam.pans[0]?.cx ?? cam.pageW / 2
  for (let i = 0; i < cam.pans.length; i++) {
    const p = cam.pans[i]
    const next = cam.pans[i + 1]
    if (p.t <= t) cx = p.cx
    if (next && t < next.t) {
      if (t > next.from && next.dur > 0) {
        const k = ease((t - next.from) / next.dur)
        cx = cx + (next.cx - cx) * k
      }
      break
    }
  }
  // 片头同样从整页中心过渡（与缩放同步，观感才是"推近"而不是"跳"）
  cx = cam.pageW / 2 + (cx - cam.pageW / 2) * introK

  /**
   * 夹紧：
   *  - 取景框比页面宽（片头）⇒ 必须整页居中，否则一侧露白；
   *  - 已经推近 ⇒ 只要求"页面还有一块在框里"，**允许探出页边**——
   *    首行的音靠左边距，不放行的话它就永远停在 18% 的位置（用户实测就是这个）。
   */
  const hw = cam.viewW / zoom / 2
  cx = cam.pageW <= 2 * hw ? cam.pageW / 2 : Math.max(0, Math.min(cam.pageW, cx))

  // 片头那一段属于第一行的页（描述头在第 1 页）
  const pageIndex = introK < 1 ? (cam.rows[0]?.pageIndex ?? row.pageIndex) : row.pageIndex
  return { pageIndex, cx, cy, zoom }
}
