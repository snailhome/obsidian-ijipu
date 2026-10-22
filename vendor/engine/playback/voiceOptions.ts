/**
 * engine/playback/voiceOptions.ts — 试听底栏「音色」下拉的选项表（adj1030）
 *
 * 由来（用户 2026-10-21）：「选择完民乐音色后，在试听底栏的音色列表里看不到」。
 *
 * 原因：底栏列表原来是"把已勾选的 GM program 列出来"（`playbackHqEnabled`），
 * 而民族乐器是**另一个页签里勾的名字**（`ethnicVoicesEnabled`）——两套数据没合并，
 * 所以勾了「二胡」也看不到它。
 *
 * 这里给一条纯函数：**同一张表，program 去重，民乐优先显示名字**，
 * 且名字旁标出它落到哪个 GM 音色（`二胡（拟 · 110 民谣提琴）`）——
 * 用户在底栏能选、也知道实际听到的是什么采样。
 */
import { GM_VOICES, type GmVoice } from './gmVoices'
import { ETHNIC_ALIASES, ethnicAliasOf } from './ethnicVoices'

export interface VoiceOption {
  /** 实际发给音频后端的 program */
  program: number
  /** 下拉里显示的文字 */
  label: string
  /** 是否来自「民族乐器（拟）」 */
  ethnic: boolean
}

const zhOf = (voices: readonly GmVoice[], program: number): string =>
  voices.find((v) => v.program === program)?.label ?? `program ${program}`

/**
 * 生成底栏音色选项。
 *
 * @param enabledPrograms 「音色清单」页签勾选的 program
 * @param enabledEthnicNames 「民族乐器（拟）」页签勾选的名字
 *
 * 规则：
 *  · 两个来源**按 program 合并去重**（同一个 110 只出现一次）；
 *  · 该 program 有民乐名字时，标签用民乐名字（`二胡（拟 · 110 民谣提琴）`），
 *    多个名字落到同一 program 就并列（`二胡/高胡（…）`）；
 *  · 其它照 GM 表显示（`110 民谣提琴`）。
 */
export function playbackVoiceOptions(
  enabledPrograms: readonly number[],
  enabledEthnicNames: readonly string[],
  voices: readonly GmVoice[] = GM_VOICES,
): VoiceOption[] {
  const byProgram = new Map<number, string[]>()
  for (const p of enabledPrograms) {
    if (Number.isInteger(p) && p >= 0 && p < 128) byProgram.set(p, [])
  }
  for (const name of enabledEthnicNames) {
    const alias = ethnicAliasOf(name)
    if (!alias) continue
    const list = byProgram.get(alias.program) ?? []
    // 名字按表里的顺序稳定排列（同一个 program 可能有 二胡/高胡/中胡…）
    const display = alias.name
    if (!list.includes(display)) list.push(display)
    byProgram.set(alias.program, list)
  }
  const order = (name: string): number => ETHNIC_ALIASES.findIndex((a) => a.name === name)
  return [...byProgram.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([program, names]) => {
      const sorted = names.slice().sort((a, b) => order(a) - order(b))
      return {
        program,
        label: sorted.length > 0 ? `${sorted.join('/')}（拟 · ${zhOf(voices, program)}）` : zhOf(voices, program),
        ethnic: sorted.length > 0,
      }
    })
}
