/**
 * engine/linear/measures.ts — 从排版结果里提「源小节表」（adj1258）
 *
 * 单行谱要按**小节**拼接，所以先得知道"排版结果里哪些元素属于哪一小节"。
 *
 * 为什么不按 `PlacedToken.barIndex` 分组：`barIndex` 是"曲部/声部块内部的小节序号"，
 * 跨 Q 行、跨页都会重新起算，直接拿来当"全曲小节号"会错。这里改用**几何**判：
 *  - 行 = `rowSpansOfPage()`（与试听/相机同一套曲行判定，不靠间距猜）；
 *  - 小节边界 = 该行内小节线的 x（去重、排序）；
 *  - **音符**归属 = 看它的 x 落在哪两个边界之间；
 *  - **歌词**归属 = 看它挂的那个音符落在哪一小节（`adj1267`：按字的 x 判会丢掉全曲第 1 个字，
 *    因为字是居中放在数字下方的，左缘比数字左缘更靠左）。
 *
 * ⚠ 行首小节线（用户 2026-11-08 特别点出的坑）：
 *  · 普通 `|` 在行首**不画**（`layout/index.ts:2101`，"行从边距开始"）；
 *  · `|/`（隐藏小节线）**不显示也不占位**（`types.ts:295`、`spacing.ts:106`）。
 *  ⇒ 一旦把行拼成一条线，行与行的交界处就**没有可见的线**了。
 *  所以这里把"边界线类型"原样记下来，由 `strip.ts` 在条带上**补一根普通线**。
 */
import type { BarlineType, PageConfig, PlacedBarline, PlacedLyric, PlacedToken, ScoreLayout } from '../types'
import { rowSpansOfPage } from '../layout/guides'

/** 源小节（排版里的一小节；还没按演奏顺序展开） */
export interface SrcMeasure {
  /** 源小节号（1 起，顺序编号） */
  no: number
  pageIndex: number
  rowIndex: number
  /** 内容左缘（= 左边界线 x；没有线时就是内容起点） */
  x0: number
  /** 内容右缘（= 右边界线 x） */
  x1: number
  /** 该行的主基线（音符基线 y） */
  baselineY: number
  /**
   * adj1273：该行谱表的**上下沿**（相对 `baselineY` 的偏移；负 = 基线之上）。
   *
   * 条带原来用"字号 × 1.75 / 0.55"估算小节线长度，与预览里排出来的不一样长
   * （预览的小节线从行顶到行底，上下比例随字号/配置走）。这里把真实值带出去，
   * 条带照抄 ⇒ 看起来和预览同一张谱，只是放大了。
   */
  staffTop: number
  staffBottom: number
  /** 左边界那根线（源类型；可能是隐藏线 `|/`，也可能没有） */
  leadType?: BarlineType
  /** 右边界那根线 */
  endType?: BarlineType
  notes: PlacedToken[]
  lyrics: PlacedLyric[]
}

/** 一条曲行里的小节线（按 x 去重后） */
interface RowLines {
  xs: number[]
  byX: Map<number, PlacedBarline>
}

function roundX(v: number): number {
  return Math.round(v * 2) / 2
}

/** 取该行的小节线（x 去重；同一位置可能既有 `|` 又有跳房子线） */
function linesOfRow(bars: PlacedBarline[], top: number, bottom: number): RowLines {
  const xs: number[] = []
  const byX = new Map<number, PlacedBarline>()
  for (const b of bars) {
    const mid = (b.yTop + b.yBottom) / 2
    if (mid < top - 1 || mid > bottom + 1) continue
    const x = roundX(b.x)
    if (!byX.has(x)) {
      byX.set(x, b)
      xs.push(x)
    }
  }
  xs.sort((a, b) => a - b)
  return { xs, byX }
}

/** 中位数（偶数个取中间两数均值） */
function median(v: number[]): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 提出全曲的源小节表（按阅读顺序：页 → 行 → 小节）。
 *
 * 只做几何切分，不做"哪一遍"的展开 —— 那是 `strip.ts` 的事。
 */
export function extractMeasures(layout: ScoreLayout, cfg: PageConfig): SrcMeasure[] {
  const out: SrcMeasure[] = []
  for (let pi = 0; pi < layout.pages.length; pi++) {
    const page = layout.pages[pi]
    const spans = rowSpansOfPage(layout, pi, {
      quci: cfg.height_quci,
      geci: cfg.geci_size,
      noteSize: cfg.note_size,
    })
    for (let ri = 0; ri < spans.length; ri++) {
      const span = spans[ri]
      const notes = page.notes.filter((n) => n.y >= span.top - 1 && n.y <= span.bottom + 1)
      if (notes.length === 0) continue
      const lines = linesOfRow(page.barlines, span.top, span.bottom)
      const lyrics = page.lyrics.filter((l) => l.y >= span.top - 1 && l.y <= span.bottom + 1)
      out.push(...splitRow(pi, ri, span.top, span.bottom, notes, lyrics, lines, out.length + 1, cfg.note_size))
    }
  }
  return out
}

/** 把一行按小节线切成若干源小节 */
function splitRow(
  pageIndex: number,
  rowIndex: number,
  top: number,
  bottom: number,
  notes: PlacedToken[],
  lyrics: PlacedLyric[],
  lines: RowLines,
  startNo: number,
  noteSize: number,
): SrcMeasure[] {
  const baselineY = median(notes.map((n) => n.y))
  /**
   * adj1273：谱表上下沿照抄**预览里那几根真小节线**（中位数，避免跳房子线之类的异类）。
   * 一条线都没有（极短片段）才退回"字号 × 1.1 / 0.6"的经验值。
   */
  const barList = [...lines.byX.values()]
  const staffTop = barList.length === 0 ? baselineY - noteSize * 1.1 : median(barList.map((b) => b.yTop))
  const staffBottom = barList.length === 0 ? baselineY + noteSize * 0.6 : median(barList.map((b) => b.yBottom))
  const contentL = Math.min(...notes.map((n) => n.x))
  const contentR = Math.max(...notes.map((n) => n.rightX ?? n.x + n.width))
  // 边界 = 行内所有小节线；两端各补一个"内容边界"，保证首尾小节也有界
  const bounds: number[] = []
  for (const x of lines.xs) if (x > contentL - 2 && x < contentR + 2) bounds.push(x)
  if (bounds.length === 0 || bounds[0] > contentL + 0.5) bounds.unshift(contentL)
  if (bounds[bounds.length - 1] < contentR - 0.5) bounds.push(contentR)

  const out: SrcMeasure[] = []
  let no = startNo
  /** 先按 x 切出各小节的音符，再统一分配歌词（adj1267：歌词要按"它的音符在哪个小节"认） */
  const bars: { x0: number; x1: number; notes: PlacedToken[] }[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const x0 = bounds[i]
    const x1 = bounds[i + 1]
    const inside = notes.filter((n) => n.x >= x0 - 0.5 && n.x < x1 - 0.5)
    // 行首空小节（`Q: |/ ...` 解析出的那一段）没有音符 ⇒ 不是小节，跳过
    if (inside.length === 0) continue
    bars.push({ x0, x1, notes: inside })
  }
  /**
   * adj1267（`E-2026-569`）：歌词**按它挂的那个音符**归小节，不再按字左缘的 x。
   *
   * 为什么：`LyricChar` 是居中放在音符数字下方的，字左缘比数字左缘还要往左
   * （`x = note.x + 半个数字宽 − 半个歌词字宽`）。全曲**第 1 个字**的字左缘因此落在
   * 内容左缘之外，按 x 判就被这一行过滤掉了 —— 实测整首歌的第一个字永远不显示。
   * 挂在行首小节线上的字（小节最后一字的字尾越界）同理。`id` 才是"这个字属于哪个音"
   * （与 `layout/index.ts` 的 `sameNote` 同一口径）。
   */
  const barOfNote = new Map<string, number>()
  const idKey = (id: PlacedToken['id']): string => `${id.page}|${id.voice}|${id.group}|${id.index}`
  bars.forEach((b, i) => {
    for (const n of b.notes) barOfNote.set(idKey(n.id), i)
  })
  const lyricsOfBar: PlacedLyric[][] = bars.map(() => [])
  for (const l of lyrics) {
    const bi = barOfNote.get(idKey(l.id))
    if (bi !== undefined) {
      lyricsOfBar[bi].push(l)
      continue
    }
    // 落不回音符（旧数据 / 音被挤掉）⇒ 退回按字左缘的 x 判，宁可偏也不丢
    const i = bars.findIndex((b) => l.x >= b.x0 - 0.5 && l.x < b.x1 - 0.5)
    if (i >= 0) lyricsOfBar[i].push(l)
  }
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    out.push({
      no,
      pageIndex,
      rowIndex,
      x0: b.x0,
      x1: b.x1,
      baselineY,
      staffTop: Math.round((staffTop - baselineY) * 10) / 10,
      staffBottom: Math.round((staffBottom - baselineY) * 10) / 10,
      ...(lineTypeAt(lines, b.x0) === undefined ? {} : { leadType: lineTypeAt(lines, b.x0) }),
      ...(lineTypeAt(lines, b.x1) === undefined ? {} : { endType: lineTypeAt(lines, b.x1) }),
      notes: b.notes,
      lyrics: lyricsOfBar[i],
    })
    no += 1
  }
  void top
  void bottom
  return out
}

function lineTypeAt(lines: RowLines, x: number): BarlineType | undefined {
  for (const [lx, bar] of lines.byX) if (Math.abs(lx - x) < 1) return bar.type
  return undefined
}
