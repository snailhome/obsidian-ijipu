/**
 * numRanges.ts — 谱面数值字段的「范围」单一来源（与 iJipu 应用同一份口径）
 *
 * 为什么要有这个文件：应用侧 `src/ui/numFieldRanges.ts` 的一张表决定"设置里能调到哪"
 * （拖动 / 步进 / 输入），插件侧若无范围，同一字段在两处能填出不同范围的值
 * ——"设置不一致"由此产生。这里**逐项引用引擎的 `GUIDE_LIMITS` / `GUIDE_LIMITS_EX`**
 * （正是预览区排版辅助虚线拖拽在用的同一份表），不另抄数字。
 *
 * 口径（与应用一致）：**引擎里没有范围的字段就不给硬范围**（保持"可填极值"的既有做法）。
 * 本模块**不依赖 obsidian**，可被冒烟测试直接引入核验。
 */
import { GUIDE_LIMITS, GUIDE_LIMITS_EX } from '@ijipu/engine'

/** 有范围的谱面字段（键名 `segmentRowGap_bz` 表示 `segmentRowGap` 的子项 `bz`） */
export type PageNumKey =
  | 'margin_top'
  | 'margin_bottom'
  | 'margin_left'
  | 'margin_right'
  | 'descAreaH'
  | 'body_margin_top'
  | 'height_ciqu'
  | 'height_quci'
  | 'height_cici'
  | 'height_ciqu_lyric'
  | 'height_shengbu'
  | 'segmentRowGap_bz'
  | 'segmentRowGap_dsb'
  | 'segmentRowGap_tp'
  | 'barCountInterval'

/** 谱面数值字段 → [min, max]（值逐项引用引擎表） */
export const PAGE_NUM_RANGES: Record<PageNumKey, [number, number]> = {
  margin_top: GUIDE_LIMITS.margin_top,
  margin_bottom: GUIDE_LIMITS.margin_bottom,
  margin_left: GUIDE_LIMITS.margin_left,
  margin_right: GUIDE_LIMITS.margin_right,
  height_ciqu: GUIDE_LIMITS.height_ciqu,
  descAreaH: GUIDE_LIMITS_EX.descAreaH,
  body_margin_top: GUIDE_LIMITS_EX.body_margin_top,
  height_quci: GUIDE_LIMITS_EX.height_quci,
  height_cici: GUIDE_LIMITS_EX.height_cici,
  height_ciqu_lyric: GUIDE_LIMITS_EX.height_ciqu_lyric,
  height_shengbu: GUIDE_LIMITS_EX.height_shengbu,
  segmentRowGap_bz: GUIDE_LIMITS_EX.segmentRowGap_bz,
  segmentRowGap_dsb: GUIDE_LIMITS_EX.segmentRowGap_dsb,
  segmentRowGap_tp: GUIDE_LIMITS_EX.segmentRowGap_tp,
  barCountInterval: GUIDE_LIMITS_EX.barCountInterval,
}

/** 取某字段（可含子项）的范围；没有范围的字段返回 undefined（不钳制） */
export function rangeOf(key: string, sub?: string): [number, number] | undefined {
  const k = sub ? `${key}_${sub}` : key
  return (PAGE_NUM_RANGES as Record<string, [number, number] | undefined>)[k]
}

/** 把数值钳到该字段范围内（无范围则原样返回） */
export function clampNum(key: string, sub: string | undefined, v: number): number {
  const r = rangeOf(key, sub)
  if (!r) return v
  return Math.min(r[1], Math.max(r[0], v))
}
