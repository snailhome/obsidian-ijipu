/**
 * voiceChooser.ts — 「音色库 → 收藏音色」的**纯逻辑**（分组 / 过滤 / 勾选运算）
 *
 * adj631（用户要求）：插件的「收藏音色」改成与应用「全局设置 → 音色库」一致的
 * **流式分类列表**（按 GM 14 类分组、可折叠、每类可整组选/消、顶部全选/全消/反选 + 搜索）。
 * 这里只放**不碰 DOM** 的算式（可被冒烟直接核对），渲染在 `settings.ts` 里（薄薄一层）。
 *
 * 分类表来自引擎 `GM_GROUPS`（与应用同一份，唯一来源），音色名来自引擎 `GM_VOICES`。
 */
import { GM_GROUPS, GM_VOICES, type GmVoice } from '@ijipu/engine'

/** 一个分类及其音色 */
export interface VoiceGroup {
  title: string
  range: [number, number]
  voices: GmVoice[]
}

/** 按 GM 14 类分组（**剔除空类**，避免出现"标题下面什么都没有"的组） */
export function groupVoices(voices: GmVoice[] = GM_VOICES): VoiceGroup[] {
  return GM_GROUPS.map((g) => ({
    title: g.title,
    range: g.range,
    voices: voices.filter((v) => v.program >= g.range[0] && v.program <= g.range[1]),
  })).filter((g) => g.voices.length > 0)
}

/** 关键词过滤（按显示名「N 名称」包含匹配；空关键词原样返回） */
export function filterVoices(keyword: string, voices: GmVoice[] = GM_VOICES): GmVoice[] {
  const k = keyword.trim()
  if (!k) return voices
  return voices.filter((v) => v.label.includes(k))
}

/** 归一化：只保留合法 program（0-127 的整数）、去重、升序——写回插件设置前统一走它 */
export function normalizeVoices(enabled: readonly number[]): number[] {
  const set = new Set<number>()
  for (const p of enabled) {
    if (Number.isInteger(p) && p >= 0 && p < GM_VOICES.length) set.add(p)
  }
  return [...set].sort((a, b) => a - b)
}

/** 勾选/取消一个音色（返回新的升序数组，不改原数组） */
export function toggleVoice(enabled: readonly number[], program: number): number[] {
  const set = new Set(normalizeVoices(enabled))
  if (set.has(program)) set.delete(program)
  else set.add(program)
  return [...set].sort((a, b) => a - b)
}

export function selectAllVoices(voices: GmVoice[] = GM_VOICES): number[] {
  return voices.map((v) => v.program)
}

export function clearVoices(): number[] {
  return []
}

/** 反选（按给定音色表；缺省全集） */
export function invertVoices(enabled: readonly number[], voices: GmVoice[] = GM_VOICES): number[] {
  const set = new Set(normalizeVoices(enabled))
  return voices.map((v) => v.program).filter((p) => !set.has(p))
}

/** 某一类里已勾选的个数（用于分类标题右侧的 `n/总数`） */
export function selectedInGroup(enabled: readonly number[], range: [number, number], voices: GmVoice[] = GM_VOICES): number {
  const set = new Set(normalizeVoices(enabled))
  return voices.filter((v) => v.program >= range[0] && v.program <= range[1] && set.has(v.program)).length
}

/** 整组勾选 / 整组取消 */
export function setGroupVoices(
  enabled: readonly number[],
  range: [number, number],
  on: boolean,
  voices: GmVoice[] = GM_VOICES,
): number[] {
  const set = new Set(normalizeVoices(enabled))
  for (const v of voices) {
    if (v.program < range[0] || v.program > range[1]) continue
    if (on) set.add(v.program)
    else set.delete(v.program)
  }
  return [...set].sort((a, b) => a - b)
}

/** 「已选 N / 128」摘要文案 */
export function voiceSummary(enabled: readonly number[], total = GM_VOICES.length): string {
  return `已选 ${normalizeVoices(enabled).length} / ${total}`
}

/** 折叠状态：默认全展开（true = 收起），供渲染层记录 */
export type CollapsedMap = Record<string, boolean>

/** 切换某一类的折叠状态（返回新对象） */
export function toggleCollapsed(collapsed: CollapsedMap, title: string): CollapsedMap {
  return { ...collapsed, [title]: !collapsed[title] }
}
