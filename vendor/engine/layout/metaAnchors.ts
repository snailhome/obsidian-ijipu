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
 * 默认偏移（无 metaPos）= 贴角排布，见 `metaCornerOffsets` / `metaAuthorRowY`（adj629u）。
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

// ============================================================
// adj629u：描述头**贴角默认**纵向偏移
// ============================================================

/**
 * 描述头默认纵向偏移（相对各自锚点；负 = 由下沿往上）。
 *
 * 用户口径（adj629u）：**左栏（调式/拍号、节拍）靠左下角、右栏（作者）靠右下角、
 * 居中栏（标题/副标题/乐器）靠区域上沿**，各行按顺序排列。
 *
 * 此前默认值是几处与字号脱钩的硬编码（标题 30.6 = 旧字号 36×0.85、调式 −44、节拍 −12），
 * 字号改成 20（adj213）后这些魔数就悬空了：空设置下三块恰好都落在描述头区域中部、不贴角。
 * 现在一律按「**该栏末行贴下沿**」推导，且行距随字号缩放——拍号分母会向基线下方探出
 * ≈0.85em，行距写死 px 在大字号下必然重叠。
 *
 * @param p.mSize       描述头字号（调式/节拍/乐器/作者基准）
 * @param p.biaotiSize  标题字号
 * @param p.hasKeyRow   该谱是否有「调式/拍号」行（决定节拍行是否为末行）
 * @param p.hasTempoRow 该谱是否有「节拍」行
 */
export function metaCornerOffsets(p: {
  mSize: number
  biaotiSize: number
  hasKeyRow: boolean
  hasTempoRow: boolean
}): { title: number; keyline: number; tempo: number } {
  const edgePad = p.mSize * 0.45 // 末行基线距区域下沿（下伸/CJK 字底 ≈0.12em，净距 ≈0.33em）
  const keyGap = p.mSize * 1.85 // 调式/拍号行 → 节拍行（拍号分母下探 0.85em + 节拍字高 0.72em）
  return {
    // 0.85 = 字顶贴线（CJK 字身 ≈0.88em，与 clampMetaPos 的下限同口径），0.1 = 视觉余量
    title: p.biaotiSize * 1.1,
    // 末行贴下沿；有节拍行时调式/拍号行上移一行；只有调式行时它自己就是末行
    keyline: p.hasKeyRow ? -edgePad - (p.hasTempoRow ? keyGap : 0) : -edgePad,
    tempo: -edgePad,
  }
}

/** 作者第 i 行的默认纵向偏移（右下锚，**末行贴下沿**、从下往上排；adj629u） */
export function metaAuthorRowY(i: number, count: number, mSize: number): number {
  const edgePad = mSize * 0.45
  const rowGap = Math.max(9, mSize - 1) * 1.42 // 作者字号 = 描述头字号 - 1
  return -edgePad - (count - 1 - i) * rowGap
}
