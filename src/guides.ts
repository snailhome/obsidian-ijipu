/**
 * guides.ts — 排版辅助虚线的几何（纯逻辑，零 Obsidian 依赖，可单测）
 *
 * 与 iJipu 预览层（`PreviewPane` 的辅助虚线层）**同一套语义**：
 *  · 四边距（上/下/左/右）——拖动改 margin_*
 *  · 描述头区下沿线——改 descAreaH；另有"描述头水平中线"纯标注不可拖
 *  · 每行曲部行虚线（数字中心）——第 1 行改 body_margin_top；多声部块内第 2+ 声部改 height_shengbu；
 *    上一行有歌词 → height_ciqu_lyric；否则 → height_ciqu
 *  · 每行歌词行虚线——第 1 行改 height_quci，后续行改 height_cici
 *
 * 这里只产出"页面坐标里的线"（pos + 跨轴范围 + 拖拽参数），
 * DOM 定位与拖拽换算由 scorePane 负责（页面坐标 → 显示百分比需知道当前显示模式的裁剪框）。
 */
import {
  GUIDE_LIMITS,
  GUIDE_LIMITS_EX,
  computeRowGuides,
  metaAreaH,
  type PageConfig,
  type ScoreLayout,
} from '@ijipu/engine'

/** 可拖拽字段（核心 5 项 + 扩展 6 项） */
export type GuideKey = keyof typeof GUIDE_LIMITS | keyof typeof GUIDE_LIMITS_EX

/** 一条辅助虚线 */
export type GuideLine = {
  key: GuideKey
  /** 拖拽方向：v = 上下拖（**水平**虚线，改纵向数值）；h = 左右拖（**竖直**虚线，改横向数值） */
  dir: 'v' | 'h'
  /** 反向：线在"页面高/宽 − 值"处（下拉/右拉 = 线跟随） */
  invert?: boolean
  /** 线在页面坐标中的位置：dir='h' → x；dir='v' → y */
  pos: number
  /** 线在另一轴上的范围（页面坐标）——描述头相关线只跨内容区 */
  from: number
  to: number
  title: string
  readonly?: boolean
  kind: 'margin' | 'desc' | 'row' | 'lyric'
}

/** 取字段可调范围（核心表与扩展表合一，缺省 [0,400]） */
export function guideLimits(key: GuideKey): [number, number] {
  const core = (GUIDE_LIMITS as Record<string, [number, number]>)[key]
  if (core) return core
  return (GUIDE_LIMITS_EX as Record<string, [number, number]>)[key] ?? [0, 400]
}

/**
 * 计算某一页的全部辅助虚线。
 * @param layout 排版结果（`layoutScore` 产物）
 * @param cfg 当前生效配置（拖拽过程中传草稿）
 * @param pageIndex 页序号
 */
export function computeGuideLines(layout: ScoreLayout, cfg: PageConfig, pageIndex: number): GuideLine[] {
  const page = layout.pages[pageIndex]
  if (!page) return []
  const out: GuideLine[] = []
  const contentL = cfg.margin_left
  const contentR = page.width - cfg.margin_right
  const descBottom = metaAreaH(cfg) - cfg.body_margin_top // 描述头内容区下沿

  // —— 四边距（跨整页）——
  out.push({ key: 'margin_top', dir: 'v', pos: cfg.margin_top, from: 0, to: page.width, kind: 'margin', title: '上边距（拖动调整）' })
  out.push({
    key: 'margin_bottom', dir: 'v', invert: true, pos: page.height - cfg.margin_bottom,
    from: 0, to: page.width, kind: 'margin', title: '下边距（拖动调整）',
  })
  out.push({ key: 'margin_left', dir: 'h', pos: cfg.margin_left, from: 0, to: page.height, kind: 'margin', title: '左边距（拖动调整）' })
  out.push({
    key: 'margin_right', dir: 'h', invert: true, pos: page.width - cfg.margin_right,
    from: 0, to: page.height, kind: 'margin', title: '右边距（拖动调整）',
  })

  // —— 描述头：下沿线（可拖，改 descAreaH）+ 水平中线（纯标注）——
  out.push({
    key: 'descAreaH', dir: 'v', pos: descBottom, from: contentL, to: contentR,
    kind: 'desc', title: '描述头高度（拖动调整）',
  })
  out.push({
    key: 'descAreaH', dir: 'h', pos: (contentL + contentR) / 2, from: cfg.margin_top, to: descBottom,
    kind: 'desc', readonly: true, title: '描述头区域中线（标注）',
  })

  // —— 行结构线（曲部行 / 词部各行）——
  const rows = computeRowGuides(layout, { quci: cfg.height_quci, geci: cfg.geci_size }, cfg.note_size)[pageIndex] ?? []
  rows.forEach((rg, ri) => {
    const prevHasLyric = ri > 0 ? (rows[ri - 1]?.lyricRows.length ?? 0) > 0 : false
    const key: GuideKey = ri === 0 ? 'body_margin_top' : rg.voiceIdx > 0 ? 'height_shengbu' : prevHasLyric ? 'height_ciqu_lyric' : 'height_ciqu'
    const title =
      ri === 0
        ? '曲部上间距（与描述头间距，拖动调整）'
        : rg.voiceIdx > 0
          ? '声部行间距（拖动调整）'
          : prevHasLyric
            ? '曲部与上一行词部间距（拖动调整）'
            : '曲部与曲部间距（拖动调整）'
    out.push({ key, dir: 'v', pos: rg.yCenter, from: contentL, to: contentR, kind: 'row', title })
    rg.lyricRows.forEach((lr, k) => {
      out.push({
        key: k === 0 ? 'height_quci' : 'height_cici', dir: 'v', pos: lr.center, from: contentL, to: contentR,
        kind: 'lyric', title: k === 0 ? '曲-词间距（拖动调整）' : '词-词间距（拖动调整）',
      })
    })
  })
  return out
}

/** 显示裁剪框（页面坐标）：'page'/'full' 为整页；'score' 为内容区（裁掉四边距） */
export type CropRect = { x: number; y: number; w: number; h: number }

/** 按显示模式给出裁剪框（与 scorePane 里设置 SVG viewBox 的逻辑一致） */
export function cropRectFor(
  mode: 'page' | 'full' | 'score',
  cfg: PageConfig,
  pageW: number,
  pageH: number,
): CropRect {
  if (mode !== 'score') return { x: 0, y: 0, w: pageW, h: pageH }
  const ml = cfg.margin_left
  const mt = cfg.margin_top
  return { x: ml, y: mt, w: Math.max(1, pageW - ml - cfg.margin_right), h: Math.max(1, pageH - mt - cfg.margin_bottom) }
}

/**
 * 线的 DOM 定位（显示盒内的百分比）与拖拽换算所需的比例。
 * 返回的 left/top/right/bottom 直接给样式用；`scale` = 显示像素 / 页面单位。
 */
export function guidePlacement(
  line: GuideLine,
  crop: CropRect,
  pageW: number,
  pageH: number,
  boxWPx: number,
): { style: Record<string, string>; scale: number } {
  const pctX = (v: number): string => `${(((v - crop.x) / crop.w) * 100).toFixed(3)}%`
  const pctY = (v: number): string => `${(((v - crop.y) / crop.h) * 100).toFixed(3)}%`
  const scale = boxWPx / crop.w
  if (line.dir === 'v') {
    return {
      style: { top: pctY(line.pos), left: pctX(line.from), right: pctX(pageW - line.to) },
      scale,
    }
  }
  return {
    style: { left: pctX(line.pos), top: pctY(line.from), bottom: pctY(pageH - line.to) },
    scale,
  }
}
