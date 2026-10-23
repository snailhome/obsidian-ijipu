/**
 * engine/ids.ts — 谱面元素 id 的**字符串形式**（两端共用、零依赖）
 *
 * 为什么要单独一个文件：`noteIdStringOf` 原来定义在 `playback/sequence.ts` 里，
 * 而 `layout/measureMap.ts` 也要用它（把音符 id 摊成"第几小节第几拍"）。
 * 若 layout 直接 import playback，就形成**反向依赖**（引擎数据流只允许 layout → playback）。
 * 放到这个中立模块后，两边都从它取，形状仍与 `data-notepos` / `activeNoteId` 完全一致。
 */
export function noteIdStringOf(id: { page: number; voice: number; group: number; index: number }): string {
  return `${id.page}_${id.voice}_${id.group}_${id.index}`
}
