/**
 * engine/layout/metaAnchors.ts — 描述头元素锚点（adj16/adj31）
 *
 * 描述头元素以「描述头区域锚点 + 相对偏移」定位；区域宽/高变化时元素跟随各自锚点：
 *  - top-center    标题/副标题    —— 描述头区域上边中点
 *  - bottom-right  词曲作者       —— 描述头区域右下角
 *  - bottom-left   调式/拍号/速度 —— 描述头区域左下角
 *
 * 描述头区域 = descAreaH（adj30 拆分的内容区），元素锚定其角且不超出区域（adj31）。
 * metaPos[key] = { x, y } 为相对锚点的偏移（x 向右、y 向下为正，SVG 坐标）。
 */
import { clamp } from './guides'

export type MetaAnchor = 'top-center' | 'bottom-right' | 'bottom-left' | 'notes'

/** key → 锚点类型（title/subtitle_i → 上居中，author_i → 右下，keyline/tempo → 左下；instrument_i 上居中，notes_i 谱尾） */
export function metaAnchorOf(key: string): MetaAnchor {
  if (key === 'title' || key.startsWith('subtitle') || key.startsWith('instrument')) return 'top-center'
  if (key.startsWith('author')) return 'bottom-right'
  if (key.startsWith('notes')) return 'notes'
  return 'bottom-left'
}

export interface MetaAreaCfg {
  margin_top: number
  margin_left: number
  margin_right: number
  body_margin_top: number
  descAreaH: number
  /** 标题/副标题字号（用于顶部安全边距，adj32） */
  biaoti_size?: number
  fubiaoti_size?: number
}

/** 锚点绝对坐标（页面 pt；描述头区域 = descAreaH，adj31） */
export function metaAnchorPt(
  anchor: MetaAnchor,
  pageW: number,
  cfg: MetaAreaCfg,
): { x: number; y: number } {
  const areaW = pageW - cfg.margin_left - cfg.margin_right
  const areaH = cfg.descAreaH
  switch (anchor) {
    case 'top-center':
      return { x: cfg.margin_left + areaW / 2, y: cfg.margin_top }
    case 'bottom-right':
      return { x: pageW - cfg.margin_right, y: cfg.margin_top + areaH }
    case 'bottom-left':
      return { x: cfg.margin_left, y: cfg.margin_top + areaH }
    case 'notes':
      // 谱尾说明文字：基准 = 页面水平居中（y 由调用方用页面高计算，此处仅占位）
      return { x: pageW / 2, y: 0 }
  }
}

/**
 * 描述头元素偏移钳制（相对各自锚点，adj16/adj31）：元素不超出描述头区域（descAreaH）。
 * 区域宽 = 页宽 - 左右边距，区域高 = descAreaH。
 * 调式/拍号/节拍（左下锚）向右偏移留 40 防文本越界。
 */
export function clampMetaPos(
  key: string,
  relX: number,
  relY: number,
  pageW: number,
  cfg: MetaAreaCfg,
): { x: number; y: number } {
  const areaW = pageW - cfg.margin_left - cfg.margin_right
  const areaH = cfg.descAreaH
  // 说明文字（谱尾）：偏移相对页面底部默认位置，宽松钳制（页面区域内）
  if (key.startsWith('notes')) {
    return { x: clamp(relX, -areaW, areaW), y: clamp(relY, -600, 200) }
  }
  switch (metaAnchorOf(key)) {
    case 'top-center': {
      // 标题/副标题文字顶部不越过区域上沿（adj32）：基线最低到 字号×0.85
      const topPad =
        key === 'title'
          ? (cfg.biaoti_size ?? 30) * 0.85
          : key.startsWith('subtitle')
            ? (cfg.fubiaoti_size ?? 16) * 0.85
            : 0
      return { x: clamp(relX, -areaW / 2, areaW / 2), y: clamp(relY, topPad, areaH) }
    }
    case 'bottom-right':
      return { x: clamp(relX, -areaW, 0), y: clamp(relY, -areaH, 0) }
    case 'bottom-left': {
      const xMax =
        key.startsWith('keyline') || key.startsWith('tempo') ? Math.max(0, areaW - 40) : areaW
      return { x: clamp(relX, 0, xMax), y: clamp(relY, -areaH, 0) }
    }
    case 'notes':
      // 已在函数开头处理，此处仅为类型穷尽
      return { x: relX, y: relY }
  }
}
