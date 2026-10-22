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
}

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
    // 只保证中心落在页内（允许取景框探出页边 ⇒ 色块才能真的落在 1/4 处）
    cx = Math.max(0, Math.min(paper.width, cx))
    const last = pans[pans.length - 1]
    if (last && Math.abs(last.cx - cx) < 0.5) continue
    pans.push(
      isRowStart
        ? { t: r.t0, cx, from: r.t0, dur: 0 }
        : { t: r.t0, cx, from: Math.max(rowStartT, r.t0 - panMs), dur: panMs },
    )
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
  const { row, prev } = rowAt(cam, t)

  // 片头进度：0 = 整页满宽，1 = 完全进入跟拍。缩放、横移、纵移都按这一个 k 走，
  // 否则会出现"先跳过去再推近"（用户实测："刚开始播放时没有平移，色块不在视界里"）。
  // 片头推近：**在第一拍之前完成**（第一拍响起时画面已经到位）
  const introK =
    cam.introMs <= 0
      ? 1
      : ease((t - (cam.firstT - cam.introMs)) / Math.max(1, cam.introMs))
  const zoom = cam.zoomFit + (cam.zoomFollow - cam.zoomFit) * introK

  // 纵向：换行的平移从行边界开始（不提前离开上一行）
  let cy = row.cy
  if (prev && row.t0 > prev.t0) {
    const k = ease((t - row.t0) / Math.max(1, cam.lineMs))
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
