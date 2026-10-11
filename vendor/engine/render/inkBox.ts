/**
 * render/inkBox.ts — **由布局推墨迹盒**（adj873，CLI `render --crop score` 用）
 *
 * ## 为什么需要它（不是"再写一份范围几何"）
 * 「范围」的唯一实现是 `render/range.ts`：它**接收**调用方量到的墨迹盒，负责加留白、过两道可信度闸、
 * 改写 SVG 外框。有 DOM 的宿主（应用预览 / Obsidian 面板）用 `getBBox()` 实测即可 ✓；
 * 而 **Node 里的 CLI 没有 DOM** ✗ —— `getBBox()` 无从谈起。
 *
 * 于是这里补的是「**布局级估算**」这一件事：从 `ScoreLayout`（布局自己算出来的坐标）反推一个墨迹盒，
 * 交给 `rangeBox({ range: 'score', ink })` 用 ✓。**几何口径依旧只在 `range.ts` 一处**（本模块不写
 * 留白、不做回退、不碰 SVG 外框），调用方也只多传一个 `ink` ✓。
 *
 * ## 口径（AGENTS §五.9「以墨迹为准」）
 * - **数字**：左缘 = `note.x`（有左伸元素的音符取 `inkLeftX`）、右缘 = `x + min(占宽, digitSlotW)`；
 *   **有附点 / 增时线才延伸到块右端**（`x + width`）；隐藏休止符 `8` 不占墨迹 ✓。
 * - **纵向**：数字用 `digitTopY`/`digitBottomY`；有高八度点抬到 `octaveTopY`；
 *   有减时线压到 `beamBottomY`；有低八度点压到 `lowDotY(...) + DOT_R`（与布局 `layout/index.ts` 同口径）✓。
 * - **连音线按弧顶**（`slurApexY` = `y − 垂度/2`）、渐强渐弱 `±DYN_HALF_H`、小节线按 `yTop..yBottom`、
 *   `&zkh/&ykh/&hx` 按 `x ± width/2`、段层大括号按 `braceTop..braceBottom`、方框小节序号按框高 ✓。
 *
 * ## ⚠ 这是**估算**，与浏览器 `getBBox()` 有差（写在明面上）
 * - **描述头（标题/作者/调式/节拍）与谱尾 `S:` 说明**：按**区域矩形**整块计入（不做逐字宽估算）。
 *   方向是"**宁多不少**"，最坏情况是短标题的窄谱两侧多留一点白；**绝不会把标题裁掉** ✓。
 * - **未建模的少量字形**（音符注释、装饰记号、倚音上的记号等）：靠四周 `INK_ESTIMATE_SLACK` px
 *   安全余量覆盖。因此**估算盒只会比真实墨迹大、不会小**（差 ≤ 该余量 + 描述头区域的富余）✓。
 * - 实测口径差量级：数字/减时线/低八度点的纵向坐标与渲染端**同函数**（差 0）；横向因字体不同
 *   可能有 **≤ 3px** 的差（`digitSlotW` 是槽宽、真实字形宽随字体变）✓。
 * 所以 CLI 的 `--crop score` 允许 `--ink x,y,w,h` **显式覆盖**（真机量到盒的宿主可以把实测值喂进来）✓。
 */
import type { PageConfig, ScoreLayout, ScorePage, PlacedToken } from '../types'
import type { RangeBox } from './range'
import { digitSlotW } from '../layout/spaceLayout'
import {
  DOT_R,
  DYN_HALF_H,
  VOLTA_BAR_GAP,
  barNumberBoxH,
  barNumberBoxW,
  beamBottomY,
  digitBottomY,
  digitTopY,
  lowDotY,
  lyricCommentFontSize,
  lyricCommentWidth,
  noteScaleOf,
  notesRowBaseline,
  octaveTopY,
  slurSagOf,
} from '../layout/spacing'

/**
 * 估算盒四周的安全余量（px）：覆盖**未逐字建模**的少量字形（音符注释、装饰记号、倚音记号……）。
 * 方向性很关键 —— 它只让盒**变大**，于是"多留一点白"而不是"裁掉内容" ✓。
 */
export const INK_ESTIMATE_SLACK = 6

/** 累加器：逐个元素把 [x, x+w] × [y, y+h] 并进来 */
interface Acc {
  x0: number
  y0: number
  x1: number
  y1: number
}

const add = (a: Acc, x: number, y: number, w: number, h: number): void => {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(w >= 0) || !(h >= 0)) return
  if (x < a.x0) a.x0 = x
  if (y < a.y0) a.y0 = y
  if (x + w > a.x1) a.x1 = x + w
  if (y + h > a.y1) a.y1 = y + h
}

/** 单个音符/休止符/节奏符的墨迹（口径见文件头；隐藏休止符 `8` 无墨迹） */
function addNoteInk(a: Acc, n: PlacedToken, ns: number): void {
  const t = n.token
  if (t.kind === 'rest' && t.hidden) return
  const s = noteScaleOf(ns)
  const left = n.inkLeftX ?? n.x
  /** 有附点/增时线 ⇒ 墨迹延伸到**块右端**；否则只到"数字槽宽"（AGENTS §五.9） */
  const hasTail = t.dots > 0 || t.augmentCount > 0
  const right = hasTail ? n.x + n.width : n.x + Math.min(n.width, digitSlotW(ns))
  const oct = t.kind === 'note' ? t.octaveShift : 0
  const dc = t.diminishCount
  let top = digitTopY(n.y, ns)
  if (oct > 0) top = Math.min(top, octaveTopY(n.y, oct, ns) - DOT_R * s)
  // 音符注释（`1"渐强"`）画在音符上方：没有逐字建模，给一整行富余（宁可多留白）
  if (t.comment !== undefined && t.comment !== '') top = Math.min(top, digitTopY(n.y, ns) - ns * 1.2)
  let bottom = digitBottomY(n.y, ns)
  if (dc > 0) bottom = Math.max(bottom, beamBottomY(n.y, dc, ns))
  if (oct < 0) bottom = Math.max(bottom, lowDotY(n.y, -oct - 1, dc, ns) + DOT_R * s)
  add(a, left, top, Math.max(0, right - left), bottom - top)
}

/** 小节线（含跳房子线）、方框小节序号 */
function addBarlineInk(a: Acc, b: ScorePage['barlines'][number], ns: number): void {
  const half = Math.max(b.width, 1) / 2
  let top = b.yTop
  if (b.voltaStart !== undefined || b.voltaEnd === true || b.voltaEndSlash === true) {
    // 跳房子线画在 (voltaYTop ?? yTop) 上方 VOLTA_BAR_GAP 处，番号注释再往上一档
    top = Math.min(top, (b.voltaYTop ?? b.yTop) - VOLTA_BAR_GAP - ns * 0.6)
  }
  add(a, b.x - half, top, half * 2, Math.max(0, b.yBottom - top))
}

/** 歌词字（含紧跟的标点、引号注释） */
function addLyricInk(a: Acc, l: ScorePage['lyrics'][number], cfg: PageConfig): void {
  const size = cfg.geci_size
  const c = l.char
  if (c.skip) return
  const text = `${c.text}${c.trailing ?? ''}`
  const w = estTextW(text, size)
  add(a, l.x, l.y - size * 0.9, w, size * 1.1)
  if (c.note !== undefined && c.note !== '') {
    const fs = lyricCommentFontSize(size)
    const nx = l.noteX ?? l.x - lyricCommentWidth(c.note, fs) - 3
    add(a, nx, (l.noteY ?? l.y) - fs * 0.9, lyricCommentWidth(c.note, fs), fs * 1.1)
  }
}

/**
 * 粗略文本宽估算（px）：CJK/全角按 1em、其余按 0.55em。
 * ⚠ 这是**估算**（引擎零 DOM，量不到字形）；只用于歌词/说明这类"字形宽随字体变"的地方，
 * 且与"宁可多留白"同向（CJK 取满字身宽，不会少算）✓。
 */
function estTextW(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 127 ? size : size * 0.55
  return w
}

/** 描述头区域 + 谱尾 `S:` 说明：按**区域矩形**整块计入（宁多不少，见文件头） */
function addMetaInk(a: Acc, page: ScorePage, cfg: PageConfig): void {
  const m = page.meta
  const hasDesc =
    m.titles.length > 0 || m.authors.length > 0 || m.key !== null || m.meter !== null ||
    m.tempoNum !== null || m.tempoText !== null || m.instruments.length > 0
  const areaW = page.width - cfg.margin_left - cfg.margin_right
  if (hasDesc) add(a, cfg.margin_left, cfg.margin_top, areaW, cfg.descAreaH)
  if (m.notes.length > 0) {
    const size = cfg.notes_size
    /** 换行会把子行数变多（整块自下而上长）⇒ 多留一行，避免裁掉首行 */
    const rows = m.notes.length + 1
    for (let r = 0; r < rows; r += 1) {
      const base = notesRowBaseline({
        pageH: page.height,
        marginBottom: cfg.margin_bottom,
        nSize: size,
        row: r,
        totalRows: rows,
      })
      add(a, cfg.margin_left, base - size * 0.9, areaW, size * 1.1)
    }
  }
}

/**
 * 由布局推**第 `pageIndex` 页**的墨迹盒（页面坐标；四周另加 `INK_ESTIMATE_SLACK` 安全余量）。
 * @returns 量不出来（空页 / 没有任何墨迹）⇒ `null` —— 调用方**必须明确报错**，不许当整页用 ✗
 */
export function inkBoxOfLayout(layout: ScoreLayout, pageIndex = 0): RangeBox | null {
  const page = layout.pages[pageIndex]
  if (page === undefined) return null
  const cfg = layout.config
  const ns = cfg.note_size
  const a: Acc = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const n of page.notes) addNoteInk(a, n, ns)
  for (const b of page.barlines) addBarlineInk(a, b, ns)
  for (const l of page.lyrics) addLyricInk(a, l, cfg)
  for (const s of page.slurs) {
    const sag = slurSagOf(Math.abs(s.x2 - s.x1))
    const y0 = s.below === true ? s.y : s.y - sag / 2
    add(a, Math.min(s.x1, s.x2), y0, Math.abs(s.x2 - s.x1), sag)
  }
  for (const d of page.dynamics) {
    add(a, Math.min(d.x1, d.x2), d.y - DYN_HALF_H, Math.abs(d.x2 - d.x1), DYN_HALF_H * 2)
  }
  for (const br of page.brackets) add(a, br.x - br.width / 2, br.yTop, br.width, ns)
  for (const vb of page.voiceBlocks) add(a, vb.x, vb.yTop, ns, vb.yBottom - vb.yTop)
  for (const bn of page.barNumbers) {
    add(a, bn.x - barNumberBoxW(bn.n, ns) / 2, bn.yBarBottom, barNumberBoxW(bn.n, ns), barNumberBoxH(ns))
  }
  for (const sb of page.segmentBrackets ?? []) {
    const w = sb.inkW ?? Math.max(3, ns * 0.32)
    const top = sb.braceTop ?? sb.yTop
    const bottom = sb.braceBottom ?? sb.yBottom
    add(a, sb.x1, top, sb.x2 + w - sb.x1, bottom - top)
  }
  addMetaInk(a, page, cfg)
  if (!Number.isFinite(a.x0) || !Number.isFinite(a.y0) || a.x1 <= a.x0 || a.y1 <= a.y0) return null
  const x = Math.max(0, a.x0 - INK_ESTIMATE_SLACK)
  const y = Math.max(0, a.y0 - INK_ESTIMATE_SLACK)
  const x1 = Math.min(page.width, a.x1 + INK_ESTIMATE_SLACK)
  const y1 = Math.min(page.height, a.y1 + INK_ESTIMATE_SLACK)
  if (x1 <= x || y1 <= y) return null
  const r2 = (v: number): number => Math.round(v * 100) / 100
  return { x: r2(x), y: r2(y), w: r2(x1 - x), h: r2(y1 - y) }
}

/** 逐页估算（CLI 多页导出用；量不到的页返回 `null`，调用方按页明确报错） */
export function inkBoxesOfLayout(layout: ScoreLayout): (RangeBox | null)[] {
  return layout.pages.map((_, i) => inkBoxOfLayout(layout, i))
}
