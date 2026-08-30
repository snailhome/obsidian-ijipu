/**
 * engine/layout/guides.ts — 排版辅助虚线数据（纯函数）
 * 供预览页叠加可拖拽虚线（边距/行距）使用。
 */
import type { ScoreLayout } from '../types'

/** 音符数字基线到行顶的偏移（noteSize×1.1，随字号；默认 18） */
const baselineOffset = (noteSize: number) => noteSize * 1.1

/** 每页的行顶 y 列表（从音符基线 y 推导，去重排序） */
export function computeRowTops(layout: ScoreLayout, noteSize = 18): number[][] {
  const off = baselineOffset(noteSize)
  return layout.pages.map((page) => {
    const tops = new Set<number>()
    for (const n of page.notes) {
      tops.add(Math.round((n.y - off) * 10) / 10)
    }
    return [...tops].sort((a, b) => a - b)
  })
}

/** 一行歌词的结构位置（adj72 词部行虚线用） */
export interface LyricRowGuide {
  /** 歌词基线 y */
  y: number
  /** 歌词行区域中心 y（基线 - 0.3×geci，字区中心，adj72） */
  center: number
}

/** 行的结构位置：曲部行（含多声部）/ 歌词行（adj10/72 虚线用） */
export interface RowGuide {
  /** 曲部行（声部行）顶 y */
  yTop: number
  /** 曲行底 y（数字下方，容纳减时线） */
  yBottom: number
  /** 曲部行数字中心 y（基线 - 0.4×noteSize，adj72 虚线基准） */
  yCenter: number
  /** 多声部块内声部序号（0 = 行首/单声部；块内第 2+ 声部 = 1,2…，adj72） */
  voiceIdx: number
  /** 每行歌词（多行歌词多条；无歌词为空数组） */
  lyricRows: LyricRowGuide[]
  /** 第一行歌词基线 y（无歌词为 null） */
  lyricTop: number | null
  /** 最后一行歌词底部 y（无歌词为 null） */
  lyricBottom: number | null
}

/** 计算每页每行的结构位置（供曲词间距/词曲间距虚线） */
export function computeRowGuides(
  layout: ScoreLayout,
  cfg: { quci: number; geci: number },
  noteSize = 18,
): RowGuide[][] {
  const off = baselineOffset(noteSize)
  return layout.pages.map((page) => {
    // 多声部块（adj72：用于判定声部序号 voiceIdx）
    const blocks = page.voiceBlocks.map((vb) => [vb.yTop, vb.yBottom] as const)
    const rowMap = new Map<number, { yTop: number; lyricYs: number[] }>()
    for (const n of page.notes) {
      const yTop = Math.round((n.y - off) * 10) / 10
      if (!rowMap.has(yTop)) rowMap.set(yTop, { yTop, lyricYs: [] })
    }
    const tops = [...rowMap.keys()]
    for (const l of page.lyrics) {
      let best = -1
      let bestD = Infinity
      for (const yTop of tops) {
        const d = Math.abs(l.y - (yTop + off + cfg.quci))
        if (d < bestD) {
          bestD = d
          best = yTop
        }
      }
      if (best >= 0) rowMap.get(best)!.lyricYs.push(l.y)
    }
    // 声部序号：yTop 落在哪个多声部块内、按 yTop 升序第几个（块外 = 0）
    const voiceIdxOf = (yTop: number): number => {
      for (const [by, bb] of blocks) {
        if (yTop >= by - 0.5 && yTop < bb - 0.5) {
          const inBlock = tops.filter((t) => t >= by - 0.5 && t < bb - 0.5).sort((a, b) => a - b)
          return Math.max(0, inBlock.indexOf(yTop))
        }
      }
      return 0
    }
    return [...rowMap.values()].map((r) => {
      r.lyricYs.sort((a, b) => a - b)
      // adj72：每行歌词一条（同一行歌词字 y 相同，去重）
      const rowYs = [...new Set(r.lyricYs.map((y) => Math.round(y * 10) / 10))].sort((a, b) => a - b)
      const base = r.yTop + off // 音符基线
      const lyricTop = rowYs.length > 0 ? rowYs[0] : null
      return {
        yTop: r.yTop,
        // adj69：曲部内容下沿（减时线区）随音符字号（0.6×noteSize）
        yBottom: r.yTop + off + noteSize * 0.6,
        // adj72：数字中心（基线 - 0.4×noteSize，数字字高 0.8em 的中心）
        yCenter: Math.round((base - noteSize * 0.4) * 10) / 10,
        voiceIdx: voiceIdxOf(r.yTop),
        lyricRows: rowYs.map((ly) => ({
          y: ly,
          center: Math.round((ly - cfg.geci * 0.3) * 10) / 10,
        })),
        lyricTop,
        lyricBottom: rowYs.length > 0 ? rowYs[rowYs.length - 1] + cfg.geci : null,
      }
    })
  })
}

/** 歌词文字上升部与字号的比值（微软雅黑 ascent≈0.86em，取 0.85 保守，保证 quci 虚线不穿歌词文字） */
export const LYRIC_ASCENT_RATIO = 0.85

/**
 * quci 虚线显示位置：钳制在「曲部内容下沿」与「歌词文字上沿」之间（adj53）。
 * - 向上最多到曲部内容下沿（不进入曲部内容区）；
 * - 不穿过歌词文字（歌词文字从基线向上延伸约 0.85×字号，旧中点公式在 quci 较小时会穿歌词）。
 * 无歌词返回 null。
 */
export function quciGuideY(g: RowGuide, geci: number): number | null {
  if (g.lyricTop === null) return null
  const mid = (g.yBottom + g.lyricTop) / 2
  const lyricEdge = g.lyricTop - geci * LYRIC_ASCENT_RATIO
  const hi = Math.max(lyricEdge, g.yBottom) // 区间为空（歌词侵入曲部）时贴曲部下沿
  return clamp(mid, g.yBottom, hi)
}

/** 可拖拽的排版项：key 对应 PageConfig 字段，dir 为拖拽方向 */
export interface GuideDragSpec {
  key: 'margin_top' | 'margin_bottom' | 'margin_left' | 'margin_right' | 'height_ciqu'
  /** 拖拽方向：v 垂直（改上下/行距）、h 水平（改左右边距） */
  dir: 'v' | 'h'
  /** 反向（右线向左拖 = 右边距增大） */
  invert?: boolean
}

export const GUIDE_ITEMS: GuideDragSpec[] = [
  { key: 'margin_top', dir: 'v' },
  { key: 'margin_bottom', dir: 'v', invert: true }, // 线在 page.height - margin_bottom：下拉=线跟随（同 margin_right）
  { key: 'margin_left', dir: 'h' },
  { key: 'margin_right', dir: 'h', invert: true },
  { key: 'height_ciqu', dir: 'v' },
]

/** 拖拽增量（显示像素 → 页面 pt），scale = 显示宽度 / 页面宽 */
export function dragDelta(
  spec: { key: string; dir: 'v' | 'h'; invert?: boolean },
  startX: number,
  startY: number,
  curX: number,
  curY: number,
  scale: number,
): number {
  const raw = spec.dir === 'v' ? curY - startY : curX - startX
  let delta = raw / scale
  if (spec.invert) delta = -delta
  return delta
}

/** 数值范围钳制 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/** 描述头区域下沿（adj30：= 上边距 + 描述头内容区高 + 曲部上间距；与 layout.metrics.titleAreaH 一致） */
export function metaAreaH(cfg: {
  margin_top: number
  body_margin_top: number
  descAreaH: number
}): number {
  return cfg.margin_top + cfg.descAreaH + cfg.body_margin_top
}

/**
 * 描述头元素位置钳制见 metaAnchors.ts（adj16 锚点语义：top-center / bottom-right / bottom-left）。
 */

/** 各字段的调整范围 */
export const GUIDE_LIMITS: Record<GuideDragSpec['key'], [number, number]> = {
  margin_top: [20, 400],
  margin_bottom: [20, 400],
  margin_left: [20, 400],
  margin_right: [20, 400],
  height_ciqu: [0, 300],
}

/** 扩展的可拖拽项（adj10：描述头高度/曲下/词下；adj30：描述头内容区高 + 间距下限；adj72：声部间距；adj79：曲部与上一行词部间距） */
export type GuideKeyEx =
  | 'descAreaH'
  | 'body_margin_top'
  | 'height_quci'
  | 'height_cici'
  | 'height_shengbu'
  | 'height_ciqu_lyric'

export const GUIDE_LIMITS_EX: Record<GuideKeyEx, [number, number]> = {
  descAreaH: [40, 400],
  body_margin_top: [4, 400], // 与描述头下端线最小间距 4px（adj30）
  height_quci: [0, 120],
  height_cici: [0, 120],
  height_shengbu: [0, 300], // 声部行间距（adj72）
  height_ciqu_lyric: [-80, 120], // 曲部与上一行词部间距（adj79；adj105 允许负值，用户需进一步压缩行距）
}
