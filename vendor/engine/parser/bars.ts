/**
 * engine/parser/bars.ts — 「按小节切分」的唯一口径（P1）
 *
 * 为什么抽出来：`splitBars()` 原来只写在 `layout/index.ts` 里，而“组首空 seg 算不算小节”
 * 在排版、播放小节号、解析期边界归一化、重排四处都要用。各写一份必然漂移
 * （行首 barline 曾让播放小节号多 1，见 `ERRORS-LOG` 的 adj1323 记录）。
 *
 * 口径：
 *  - 每遇到一根 barline 就收一段：`bar` = 这一段的**收尾**小节线；
 *  - 行首 barline 会解析出一个 `notes: []` 的组首空 seg —— 它只是“行首边界”，**不是小节**；
 *  - `countMeasures()` 只排除**组首**空 seg；中间真的空 seg（`| &dc |` 那种）仍算一格，
 *    由上层判断是否要合并。
 */
import type { MusicToken } from '../types'

/** 按小节切分（每小节音符 + 小节后的 barline；行首 barline 在 segs[0].bar） */
export interface BarSeg {
  notes: MusicToken[]
  bar: Extract<MusicToken, { kind: 'barline' }> | null
}

/** 把一行/一个声部的 token 流按 barline 切成小节段 */
export function splitBars(tokens: MusicToken[]): BarSeg[] {
  const segs: BarSeg[] = []
  let cur: MusicToken[] = []
  for (const t of tokens) {
    if (t.kind === 'barline') {
      segs.push({ notes: cur, bar: t })
      cur = []
    } else {
      cur.push(t)
    }
  }
  if (cur.length > 0) segs.push({ notes: cur, bar: null })
  return segs
}

/**
 * 这一串 token 里**真实小节数**：排除“组首空 seg”（行首 barline / 行首 voltaOnly 注释）。
 *
 * 中间的空 seg 仍计入 —— 是否要保留空小节由调用方（归一化/重排）决定，
 * 这里不做二次解释，避免“计数”和“绘制”两套口径。
 */
export function countMeasures(tokens: MusicToken[]): number {
  return splitBars(tokens).filter((s, i) => !(i === 0 && s.notes.length === 0)).length
}
