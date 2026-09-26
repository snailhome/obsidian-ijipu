/**
 * engine/playback/gmVoices.ts — GM 128 音色表（音色名 ↔ program）的唯一来源（adj447）
 *
 * 为什么要收敛到 engine：这张表同时被三处需要——
 *  ① 应用内「设置 → 音色库」勾选列表与试听「音色」下拉（显示 `N 名称`）；
 *  ② 试听/导出把选中的 GM program 还原成音色名（`firstEnabledInstrumentRef`）；
 *  ③ **谱面里的乐器指定**（描述头 `Y:` 行、曲内 `@乐器名@`）把名称解析回 program。
 * 此前 ① 在 app（`spessaSynthBackend.ts`）、③ 另有一张只有约 40 个中文名的表
 * （`midi.ts` 的 `GM_NAME_PROGRAMS`），于是**用户在列表里看到的音色名，写进 `Y:` 多半解析不出本音色**
 * ——实测 128 项里 **101 项**解析不到自己的 program（如「钢片琴」→八音盒 10、「教堂风琴」→风琴 16、
 * 「弦乐合奏1/2」→同一个 48），多声部两份音色因此可能落到**同一个 program** ⇒ 试听只剩一种音色
 * （用户报「多个 `Y:` 音色只用了第一个」）。本模块把表收敛成唯一来源后，三者天然一致。
 *
 * 纯数据 + 字符串匹配，零 DOM 依赖，可单测。
 */

/** GM 音色：`label` 为应用内显示名（`N 名称`，N = program 且 0 基） */
export interface GmVoice {
  program: number
  label: string
}

/** GM 128 音色全集（program 0-127，中文名，与 MIDI 标准程序号一一对应） */
export const GM_VOICES: GmVoice[] = [
  // 0-7 钢琴
  { program: 0, label: '0 大钢琴' }, { program: 1, label: '1 亮音钢琴' }, { program: 2, label: '2 电钢琴' }, { program: 3, label: '3 酒吧钢琴' },
  { program: 4, label: '4 电钢琴1' }, { program: 5, label: '5 电钢琴2' }, { program: 6, label: '6 拨弦古钢琴' }, { program: 7, label: '7 击弦古钢琴' },
  // 8-15 色彩打击
  { program: 8, label: '8 钟琴' }, { program: 9, label: '9 钢片琴' }, { program: 10, label: '10 八音盒' }, { program: 11, label: '11 颤音琴' },
  { program: 12, label: '12 马林巴' }, { program: 13, label: '13 木琴' }, { program: 14, label: '14 管钟' }, { program: 15, label: '15 杜西玛琴' },
  // 16-23 风琴
  { program: 16, label: '16 拉杆风琴' }, { program: 17, label: '17 打击风琴' }, { program: 18, label: '18 摇滚风琴' }, { program: 19, label: '19 教堂风琴' },
  { program: 20, label: '20 簧风琴' }, { program: 21, label: '21 手风琴' }, { program: 22, label: '22 口琴' }, { program: 23, label: '23 探戈手风琴' },
  // 24-31 吉他
  { program: 24, label: '24 民谣吉他' }, { program: 25, label: '25 电吉他(清音)' }, { program: 26, label: '26 电吉他(闷音)' }, { program: 27, label: '27 电吉他(过载)' },
  { program: 28, label: '28 电吉他(失真)' }, { program: 29, label: '29 电吉他(泛音)' }, { program: 30, label: '30 中音吉他' }, { program: 31, label: '31 爵士吉他' },
  // 32-39 贝斯
  { program: 32, label: '32 声学贝斯' }, { program: 33, label: '33 电贝斯(指弹)' }, { program: 34, label: '34 电贝斯(拨片)' }, { program: 35, label: '35 无品贝斯' },
  { program: 36, label: '36 击弦倍低音' }, { program: 37, label: '37 闷音电贝斯' }, { program: 38, label: '38 电贝斯1' }, { program: 39, label: '39 电贝斯2' },
  // 40-47 弦乐
  { program: 40, label: '40 小提琴' }, { program: 41, label: '41 中提琴' }, { program: 42, label: '42 大提琴' }, { program: 43, label: '43 低音提琴' },
  { program: 44, label: '44 拨奏弦乐' }, { program: 45, label: '45 竖琴' }, { program: 46, label: '46 定音鼓' }, { program: 47, label: '47 弦乐合奏' },
  // 48-55 合奏/合唱
  { program: 48, label: '48 弦乐合奏1' }, { program: 49, label: '49 弦乐合奏2' }, { program: 50, label: '50 合成弦乐1' }, { program: 51, label: '51 合成弦乐2' },
  { program: 52, label: '52 合唱啊音' }, { program: 53, label: '53 人声"哦"音' }, { program: 54, label: '54 合成人声' }, { program: 55, label: '55 管弦打击' },
  // 56-63 铜管
  { program: 56, label: '56 小号' }, { program: 57, label: '57 长号' }, { program: 58, label: '58 大号' }, { program: 59, label: '59 闷音小号' },
  { program: 60, label: '60 法国号' }, { program: 61, label: '61 铜管组' }, { program: 62, label: '62 合成铜管1' }, { program: 63, label: '63 合成铜管2' },
  // 64-71 簧片
  { program: 64, label: '64 高音萨克斯' }, { program: 65, label: '65 中音萨克斯' }, { program: 66, label: '66 次中音萨克斯' }, { program: 67, label: '67 上低音萨克斯' },
  { program: 68, label: '68 双簧管' }, { program: 69, label: '69 英国号' }, { program: 70, label: '70 巴松管' }, { program: 71, label: '71 单簧管' },
  // 72-79 管乐
  { program: 72, label: '72 短笛' }, { program: 73, label: '73 长笛' }, { program: 74, label: '74 泛音笛' }, { program: 75, label: '75 竖笛' },
  { program: 76, label: '76 巴乌笛' }, { program: 77, label: '77 尺八' }, { program: 78, label: '78 民族笛' }, { program: 79, label: '79 哨笛' },
  // 80-87 合成主音
  { program: 80, label: '80 排箫' }, { program: 81, label: '81 吹瓶声' }, { program: 82, label: '82 口哨' }, { program: 83, label: '83 民族排箫' },
  { program: 84, label: '84 尺八(合成)' }, { program: 85, label: '85 合成主音1' }, { program: 86, label: '86 合成主音2' }, { program: 87, label: '87 合成主音3' },
  // 88-95 合成垫音
  { program: 88, label: '88 合成垫音1' }, { program: 89, label: '89 合成垫音2' }, { program: 90, label: '90 合成垫音3' }, { program: 91, label: '91 合成垫音4' },
  { program: 92, label: '92 合成垫音5' }, { program: 93, label: '93 合成垫音6' }, { program: 94, label: '94 合成垫音7' }, { program: 95, label: '95 合成垫音8' },
  // 96-103 合成效果
  { program: 96, label: '96 合成雨声' }, { program: 97, label: '97 合成音轨' }, { program: 98, label: '98 合成水晶音' }, { program: 99, label: '99 合成氛围声' },
  { program: 100, label: '100 合成明亮音' }, { program: 101, label: '101 合成妖精声' }, { program: 102, label: '102 合成回声' }, { program: 103, label: '103 合成科幻声' },
  // 104-111 民族乐器
  { program: 104, label: '104 西塔尔琴' }, { program: 105, label: '105 班卓琴' }, { program: 106, label: '106 三味线' }, { program: 107, label: '107 十三弦琴' },
  { program: 108, label: '108 卡林巴' }, { program: 109, label: '109 风笛' }, { program: 110, label: '110 民族琴' }, { program: 111, label: '111 印尼锣' },
  // 112-119 打击乐器
  { program: 112, label: '112 锡塔尔' }, { program: 113, label: '113 钢鼓' }, { program: 114, label: '114 木鱼' }, { program: 115, label: '115 陶鼓' },
  { program: 116, label: '116 民族鼓' }, { program: 117, label: '117 合成鼓' }, { program: 118, label: '118 合成镲' }, { program: 119, label: '119 民族打击' },
  // 120-127 音效
  { program: 120, label: '120 吉他滑音' }, { program: 121, label: '121 呼吸声' }, { program: 122, label: '122 海浪声' }, { program: 123, label: '123 鸟鸣声' },
  { program: 124, label: '124 电话铃' }, { program: 125, label: '125 直升机' }, { program: 126, label: '126 拍手声' }, { program: 127, label: '127 枪声' },
]

/**
 * GM 128 音色的**分类**（14 类，按 MIDI 标准程序号区间）——供「音色库」按类分组展示（流式分类列表）。
 *
 * adj631（用户要求：插件的「收藏音色」采用与应用全局设置一致的**流式分类列表**）：
 * 这张表原先只写在应用 `src/dialogs/VoicePickerDialog.tsx` 里，插件用不到 ⇒ 收敛到引擎
 * （`GM_VOICES` 的同一文件），应用与插件共用一份，避免"两处各写一张分类表"漂移。
 */
export const GM_GROUPS: { title: string; range: [number, number] }[] = [
  { title: '钢琴家族（Piano）', range: [0, 7] },
  { title: '色彩打击乐（Chromatic Percussion）', range: [8, 15] },
  { title: '风琴（Organ）', range: [16, 23] },
  { title: '吉他（Guitar）', range: [24, 31] },
  { title: '贝斯（Bass）', range: [32, 39] },
  { title: '弦乐（Strings）', range: [40, 47] },
  { title: '合奏/合唱（Ensemble）', range: [48, 55] },
  { title: '铜管（Brass）', range: [56, 63] },
  { title: '簧管/双簧管（Reed）', range: [64, 71] },
  { title: '笛管（Pipe）', range: [72, 79] },
  { title: '合成领奏/垫音/效果（Synth）', range: [80, 95] },
  { title: '民族/其它（Ethnic / Others）', range: [96, 111] },
  { title: '打击乐（Percussive）', range: [112, 119] },
  { title: '声音效果（Sound Effects）', range: [120, 127] },
]

/**
 * GM program → **音色名 ref**（剥掉显示编号，如 `21 手风琴` → `手风琴`）；无匹配返回 undefined。
 *
 * adj455：这是 `gmVoiceProgram` 的逆映射，供「试听音色」选定具体音色后作为**全篇乐器覆盖**
 * 传给 `buildPlaySequence`（序列里的 `instrument` 字段用的是音色名 ref，不是 program）。
 * 与 `gmVoiceProgram` 天然互逆（同一张表），smoke 对 128 项逐项断言往返一致。
 */
export function gmVoiceRef(program: number | null | undefined): string | undefined {
  if (program === null || program === undefined || !Number.isFinite(program)) return undefined
  const v = GM_VOICES.find((x) => x.program === program)
  return v ? v.label.replace(/^\d+\s+/, '') : undefined
}

/** 音色名（含/不含显示编号）→ GM program；无匹配返回 null */
export function gmVoiceProgram(name: string | undefined | null): number | null {
  if (!name) return null
  const raw = name.trim()
  if (raw === '') return null
  // 纯编号：应用内「音色库」的显示名是 `21 手风琴`，而描述头 `Y:` 只取**第一个词**
  // （adj302「一个 Y 行一种乐器」）⇒ 用户照列表抄下来时实际拿到的是 `21`。
  // 列表编号即 GM program（0 基，与 MIDI 标准程序号一致），故纯编号按 program 解释。
  if (/^\d{1,3}$/.test(raw)) {
    const n = Number(raw)
    return n >= 0 && n < 128 ? n : null
  }
  const m = /^(\d{1,3})\s+(.+)$/.exec(raw)
  const bare = m ? m[2].trim() : raw
  for (const v of GM_VOICES) {
    if (v.label === raw) return v.program
    // label 的 `N ` 前缀剥掉后再比一次：`手风琴` ↔ `21 手风琴`
    if (v.label.replace(/^\d+\s+/, '') === bare) return v.program
  }
  return null
}
