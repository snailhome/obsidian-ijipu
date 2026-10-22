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
 * ## 行的判定
 *
 * 用引擎自己的 `computeRowGuides()`（它已经处理了多声部 `voiceIdx`、临时段层、歌词行）。
 * 相邻两条 guide 的纵向间隙小于 `0.8×字号` 就并成**同一视觉行**——多声部堆叠、`{bz}`/`{dsb}`
 * 叠加层的间距都在这个量级，而行与行之间隔着歌词，远大于它。
 */
import { PAPER_SIZE, type PageConfig, type ScoreLayout } from '../types'
import { computeRowGuides } from '../layout/guides'
import type { FlowRow, FlowView, RectTrack } from './types'

/** 纵向间隙小于这个比例（×字号）的相邻行并入同一条视觉行 */
export const ROW_MERGE_RATIO = 0.8

export interface FlowViewOptions {
  /** 可视高（缺省 = 页面高）。视频里就是画布高 */
  viewH?: number
}

/** 页面上的一条视觉行（含多声部/歌词的纵向范围） */
interface VisualRow {
  top: number
  bottom: number
  /**
   * **只算音符**的下沿（不含歌词）。合并判定必须用它。
   *
   * 为什么：带歌词时，上一行的歌词几乎顶到下一行的音符，按"行底（含歌词）"算间隙会 ≤ 0，
   * 于是相邻几行全被并成一行 —— 相机对到整块中间，第一行的色块掉出取景框（用户实报）。
   */
  notesBottom: number
}

/** 每页的视觉行 */
function visualRowsOfPage(layout: ScoreLayout, pageIndex: number, cfg: PageConfig): VisualRow[] {
  const nSize = cfg.note_size
  const guides = computeRowGuides(layout, { quci: cfg.height_quci, geci: cfg.geci_size }, nSize)[pageIndex] ?? []
  const rows: VisualRow[] = []
  const sorted = [...guides].sort((a, b) => a.yTop - b.yTop)
  for (const g of sorted) {
    // 行底取"曲部内容下沿"与"歌词下沿"的较大者：歌词也是这一行的内容，不能被切掉
    const notesBottom = g.yBottom
    const bottom = Math.max(g.yBottom, g.lyricBottom ?? g.yBottom)
    const last = rows[rows.length - 1]
    // 合并判定只看**音符**间隙（歌词会填满行间空档，用它判会把相邻行并成一行）
    if (last && g.yTop - last.notesBottom <= nSize * ROW_MERGE_RATIO) {
      last.bottom = Math.max(last.bottom, bottom)
      last.notesBottom = Math.max(last.notesBottom, notesBottom)
      last.top = Math.min(last.top, g.yTop)
    } else {
      rows.push({ top: g.yTop, bottom, notesBottom })
    }
  }
  return rows
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
