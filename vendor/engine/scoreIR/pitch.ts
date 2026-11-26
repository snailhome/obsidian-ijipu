/**
 * engine/scoreIR/pitch.ts — 音高 / 调号 / 简谱数字 的换算（互转的唯一口径）
 *
 * 三件事常被混在一起，这里分开，并**只在这里定义一次**：
 *  1. 调号原文（`C` / `$E` / `F#`）↔ 根音半音数；
 *  2. 简谱「音级 + 八度点 + 变音」↔ MIDI（C4 = 60）；
 *  3. MIDI ↔ 五线谱的「step/alter/octave」与 MusicXML 的 `<fifths>`。
 *
 * 八度点约定（与 jps 一致）：中音 `1` 在主音所在那一组；高一个八度加一个 `'`，
 * 低一个八度加一个 `,`。MIDI 换算：`60 + 调号 + 大调音阶级数 + 12×八度 + 变音`。
 *
 * 为什么不用 `layout/index.ts` 里的 `pitchToName`：那是**排版**内部函数（还带着
 * 字体/宽度一堆依赖），而 scoreIR 要被 OMR 的 Rust 侧与 CLI 共用，必须保持薄。
 * 两边口径一致由 smoke 的「与引擎播放音高逐音相同」断言守住。
 */

const KEY_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}

/** 大调音阶相对主音的半音数（1→根音，2→大二度，…，7→大七度） */
export const DEGREE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]

/** 中音 `1` 的 MIDI（简谱中音 1 = C4 = 60） */
export const BASE_MIDI = 60

/** jps `D:` 的习惯写法（升号用 `#`，降号用 `$`；与引擎既有 `KEY_NAMES` 一致） */
const KEY_JPS_NAMES = ['C', '#C', 'D', '$E', 'E', 'F', '#F', 'G', '#G', 'A', '$B', 'B']

/** 界面/文档里的调名（降号写 b） */
const KEY_DISPLAY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/** 各音级名（十二平均律，升号记法） */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** 自然音字母 → 音高类 */
const NATURAL_PC = [0, 2, 4, 5, 7, 9, 11]

/**
 * 调号根音半音数（C=0）。支持升降号写在字母前/后、`$` 与 `b` 两种降号写法
 * （与引擎 `parseKey` 同一套正则；不合法时按 C 处理，和旧行为一致）。
 */
export function keySemitoneOf(key: string | undefined): number {
  if (!key) return 0
  const m = /^([#$b]?)([A-G])([#$b]?)$/.exec(key.trim())
  if (!m) return 0
  const semis = KEY_SEMITONE[m[2]]
  const acc = m[1] || m[3]
  return semis + (acc === '#' ? 1 : acc === '$' || acc === 'b' ? -1 : 0)
}

/** 半音数 → jps `D:` 写法 */
export function keyJpsNameOf(semitone: number): string {
  return KEY_JPS_NAMES[((Math.round(semitone) % 12) + 12) % 12]
}

/** 半音数 → 界面显示名（降号写 b） */
export function keyDisplayNameOf(semitone: number): string {
  return KEY_DISPLAY_NAMES[((Math.round(semitone) % 12) + 12) % 12]
}

/**
 * 调号根音半音数 → MusicXML `<fifths>`（正数升号数、负数降号数）。
 *
 * 用的是「常用写法」：C# 记 7 个升号、Eb 记 3 个降号（而不是等音的另一边）。
 * 等音调（C#/Db、F#/Gb）按这个表固定，写五线谱时谱号里升降号才是常见写法。
 */
export function keyFifthsOf(semitone: number): number {
  const table = [0, 7, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5]
  return table[((Math.round(semitone) % 12) + 12) % 12]
}

/** MusicXML `<fifths>` → 调号根音半音数 */
export function keySemitoneOfFifths(fifths: number): number {
  // -7..7 → Cb/Gb/Db/Ab/Eb/Bb/F/C/G/D/A/E/B/F#/C#
  const table: Record<number, number> = {
    [-7]: 11,
    [-6]: 6,
    [-5]: 1,
    [-4]: 8,
    [-3]: 3,
    [-2]: 10,
    [-1]: 5,
    0: 0,
    1: 7,
    2: 2,
    3: 9,
    4: 4,
    5: 11,
    6: 6,
    7: 1,
  }
  const v = table[Math.max(-7, Math.min(7, Math.round(fifths)))]
  return v === undefined ? 0 : v
}

/** 简谱音（音级 + 八度 + 变音）→ MIDI */
export function jpsPitchToMidi(
  degree: number,
  octaveShift: number,
  accidental: '#' | '$' | '=' | null,
  keySemitone: number,
): number {
  const acc = accidental === '#' ? 1 : accidental === '$' ? -1 : 0
  const idx = Math.max(0, Math.min(6, Math.round(degree) - 1))
  return BASE_MIDI + keySemitone + DEGREE_SEMITONES[idx] + octaveShift * 12 + acc
}

/** 简谱音（含 MIDI） */
export interface JpsPitch {
  degree: number
  octaveShift: number
  accidental: '#' | '$' | '=' | null
  midi: number
}

/**
 * MIDI + 调号 → 简谱音。
 *
 * 调外音按「最近的调内音级 + 升/降号」处理，与 jps 的变音写法一致：
 * 先看低半音（写成 `#`），再看高半音（写成 `$`）；实在找不到才退回 `1`。
 * 这样 `midiToJpsPitch` 与 `jpsPitchToMidi` 在调内音上严格互逆。
 */
export function midiToJpsPitch(midi: number, keySemitone: number): JpsPitch {
  const rel = Math.round(midi) - (BASE_MIDI + keySemitone)
  const octaveShift = Math.floor(rel / 12)
  const pc = ((rel % 12) + 12) % 12
  const exact = DEGREE_SEMITONES.indexOf(pc)
  if (exact >= 0) {
    return { degree: exact + 1, octaveShift, accidental: null, midi: Math.round(midi) }
  }
  const lower = DEGREE_SEMITONES.indexOf((pc + 11) % 12)
  if (lower >= 0) {
    return { degree: lower + 1, octaveShift, accidental: '#', midi: Math.round(midi) }
  }
  const upper = DEGREE_SEMITONES.indexOf((pc + 1) % 12)
  if (upper >= 0) {
    return { degree: upper + 1, octaveShift, accidental: '$', midi: Math.round(midi) }
  }
  return { degree: 1, octaveShift, accidental: null, midi: Math.round(midi) }
}

/** MIDI → 音名（`C4` 风格，升号记法） */
export function midiToPitchName(midi: number): string {
  const n = Math.round(midi)
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`
}

/** 五线谱写法：step（C–B）+ alter（半音）+ octave（科学音高八度） */
export interface StaffPitch {
  step: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B'
  alter: number
  octave: number
}

const STEPS: StaffPitch['step'][] = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

/** 音名（大小写不敏感）→ 字母下标（C=0） */
function letterIndexOf(step: string): number {
  const i = STEPS.indexOf(step.toUpperCase() as StaffPitch['step'])
  return i < 0 ? 0 : i
}

/**
 * MIDI + 调号 → 五线谱写法。
 *
 * 先按简谱音级取「调内字母」（C 调 1=C、D 调 1=D、Eb 调 1=Eb…），再把目标音高类
 * 与这个字母的自然音高类相减得到 `alter`。这样 D 大调的 `7` 会写成 C#（而不是 Db），
 * Eb 大调的 `3` 会写成 G（而不是 F##），与调号一致。
 */
export function spellMidiForStaff(midi: number, keySemitone: number): StaffPitch {
  const jps = midiToJpsPitch(midi, keySemitone)
  const fifths = keyFifthsOf(keySemitone)
  // 调号含升号（含 C 大调）用升号音名取主音字母；含降号用降号音名
  const sharpLetters = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]
  const flatLetters = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6]
  const tonicPc = ((keySemitone % 12) + 12) % 12
  const tonicLetter = (fifths < 0 ? flatLetters : sharpLetters)[tonicPc]
  const letter = (tonicLetter + jps.degree - 1) % 7
  const targetPc = ((Math.round(midi) % 12) + 12) % 12
  let alter = targetPc - NATURAL_PC[letter]
  if (alter > 6) alter -= 12
  if (alter < -6) alter += 12
  // 八度按「字母的自然音高」反推：C4=60、G4=67 都是 4，不是拿 MIDI/12 直接取整
  const octave = Math.round((Math.round(midi) - alter - NATURAL_PC[letter]) / 12) - 1
  return { step: STEPS[letter], alter, octave }
}

/** MusicXML step/alter/octave → MIDI（alter 可为负；临时记号用） */
export function staffPitchToMidi(step: string, alter: number, octave: number): number {
  return (Math.round(octave) + 1) * 12 + NATURAL_PC[letterIndexOf(step)] + Math.round(alter)
}

/** 拍号原文（`6/8` / `4/4 (2/4)`）→ 分子/分母（取第一组；不合法回 4/4） */
export function parseMeter(meter: string | undefined): { beats: number; beatType: number } {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec((meter ?? '').trim())
  if (!m) return { beats: 4, beatType: 4 }
  const beats = Math.max(1, Number(m[1]))
  const beatType = Math.max(1, Number(m[2]))
  return { beats, beatType }
}
