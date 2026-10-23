/**
 * engine/dynamic/flowView.ts — 竖屏「流式视图」：把分页的谱面拼成一条可滚动的带
 *
 * ## 为什么不能直接滚 A4 页
 *
 * A4 是"页"思维（一页 8–10 行，翻页看）；短视频是"流"思维（一行一行往下走、当前行居中）。
 * 直接滚页的结果是"卡住 5 行 → 猛跳一页"，看起来像翻 PPT。
 *
 * ## 做法：只记「从哪取图、贴到哪」
 *
 * 不重排、不复制音符，只产出一组 `FlowRow`：
 *  - `srcTop/srcBottom` 是**页面坐标**里的取图区间（每行一条带）；
 *  - `stripY` 是贴到条带上的位置；
 *  - 行边界取**相邻行中缝** ⇒ 各带不重叠、不漏。
 *
 * 反复段展开成"重复行"就是**同一组 src 区间出现多条 FlowRow**（`pass` 递增），
 * 不复制任何几何数据、不多占位图内存。
 *
 * ## 行的判定（adj1091 起：与试听同一套「按曲行」）
 *
 * 行 = **曲行**（`layout/guides.ts` 的 `rowSpansOfPage`）：多声部块内的所有声部行算一行，
 * 临时段层（`{bz}`/`{dsb}`/`{tp}`）并入所属曲行，行底取到**最后一行歌词**。
 *
 * 旧口径是"相邻行空隙 ≤ 0.8×字号就并成同一视觉行"（adj759 时期的估计）——
 * 实测多声部行距**把歌词区一起算了进去**（Q1/Q2 行顶差 87、字号 13 ⇒ 空隙 65），
 * 于是同一组的两个声部被拆成两条行：相机同一时刻在两行之间来回对，
 * 观众看到的就是"唱的时候只框住一个声部"（试听侧同类缺陷见 E-2026-513）。
 * 现在两端共用 `rowSpansOfPage`，**不再按间距猜行**。
 */
import { PAPER_SIZE, type PageConfig, type ScoreLayout } from '../types'
import { rowSpansOfPage } from '../layout/guides'
import type { FlowRow, FlowView, RectTrack } from './types'

export interface FlowViewOptions {
  /** 可视高（缺省 = 页面高）。视频里就是画布高 */
  viewH?: number
}

/** 页面上的一条行（含多声部/段层/歌词的纵向范围） */
interface VisualRow {
  top: number
  bottom: number
}

/**
 * 每页的行（= 曲行）。
 *
 * adj1091：直接复用 `rowSpansOfPage`（试听纵向滚动用的是同一个函数）——
 * 「同一组多声部 + 它的歌词」在两端都是**同一个纵向范围**，不可能一边框住、一边全。
 */
function visualRowsOfPage(layout: ScoreLayout, pageIndex: number, cfg: PageConfig): VisualRow[] {
  return rowSpansOfPage(layout, pageIndex, {
    quci: cfg.height_quci,
    geci: cfg.geci_size,
    noteSize: cfg.note_size,
  }).map((s) => ({ top: s.top, bottom: s.bottom }))
}

/**
 * 视觉行 → 取图带。
 *
 * **带必须紧贴行内容**，不能取到页边：页高 = 视口高时，整页带会让"滚动"退化成整页翻页，
 * 视频里就是 PPT 效果（第一版就是这么错的，截图一看便知）。
 *
 * 规则：
 *  - 相邻两行之间取**中缝**（各让一半），既不重叠也不漏；
 *  - 第一行从页顶起（把标题/调号一并带上，片头能看见曲名）；
 *  - 最后一行只到**行底 + 0.8×字号**，不把整页留白拖进条带。
 */
/** 取图带（只有上下界，不含"行内容"语义） */
interface Band {
  top: number
  bottom: number
}

function bandsOf(rows: VisualRow[], pageH: number, nSize: number): Band[] {
  if (rows.length === 0) return [{ top: 0, bottom: pageH }]
  return rows.map((r, i) => {
    const nextTop = i < rows.length - 1 ? rows[i + 1].top : r.bottom + nSize * 0.8
    const top = i === 0 ? 0 : Math.round((rows[i - 1].bottom + r.top) / 2)
    const bottom = Math.round((r.bottom + nextTop) / 2)
    return { top, bottom: Math.max(top + 1, bottom) }
  })
}

/**
 * 建流式视图。
 *
 * @param layout 用 `dynamicPageConfig()` 排出来的版面（**别传用户自己的 A4 版面**，行宽不一样）
 * @param track  `buildRectTrack()` 的结果
 * @param cfg    与 layout 同一份配置（只用到 `note_size` / `height_quci` / `geci_size` / `page`）
 */
export function buildFlowView(
  layout: ScoreLayout,
  track: RectTrack,
  cfg: PageConfig,
  opts: FlowViewOptions = {},
): FlowView {
  const paper = PAPER_SIZE[cfg.page]
  const viewH = opts.viewH ?? paper.height
  const visualByPage = layout.pages.map((_, pi) => visualRowsOfPage(layout, pi, cfg))
  const bandsByPage = visualByPage.map((rows) => bandsOf(rows, paper.height, cfg.note_size))

  /** 每条矩形落在哪条取图带上（缺省 -1 = 找不到，理论上不该发生） */
  const bandOfRect: number[] = track.rects.map((r) => {
    const bands = bandsByPage[r.pageIndex] ?? []
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]
      const d = r.baselineY < b.top ? b.top - r.baselineY : r.baselineY > b.bottom ? r.baselineY - b.bottom : 0
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  })

  const rows: FlowRow[] = []
  const rectRow: number[] = new Array(track.rects.length).fill(-1)
  const passOf = new Map<string, number>()
  let stripY = 0

  for (let i = 0; i < track.rects.length; i++) {
    const r = track.rects[i]
    const bi = bandOfRect[i]
    if (bi < 0) continue
    const band = bandsByPage[r.pageIndex][bi]
    const last = rows[rows.length - 1]
    // 与上一行是同一页、同一带 ⇒ 这一拍还在这条带上（多声部/同拍的其它声部也走这里）
    const sameBand =
      last !== undefined && last.pageIndex === r.pageIndex && last.srcTop === band.top && last.srcBottom === band.bottom
    if (!sameBand) {
      const key = `${r.pageIndex}|${band.top}`
      const pass = (passOf.get(key) ?? 0) + 1
      passOf.set(key, pass)
      const visual = visualByPage[r.pageIndex]?.[bi]
      rows.push({
        index: rows.length,
        pageIndex: r.pageIndex,
        srcTop: band.top,
        srcBottom: band.bottom,
        contentTop: visual?.top ?? band.top,
        contentBottom: visual?.bottom ?? band.bottom,
        stripY,
        t0: r.t0,
        t1: r.t1,
        pass,
      })
      stripY += band.bottom - band.top
    } else if (last !== undefined && r.t1 > last.t1) {
      last.t1 = r.t1
    }
    rectRow[i] = rows[rows.length - 1].index
  }

  return {
    rows,
    rectRow,
    stripHeight: stripY,
    viewW: paper.width,
    viewH,
    noteSize: cfg.note_size,
  }
}
