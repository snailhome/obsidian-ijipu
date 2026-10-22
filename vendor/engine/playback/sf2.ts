/**
 * engine/playback/sf2.ts — SoundFont2 **头部元数据**解析（adj1009，纯函数、零 DOM）
 *
 * ## 为什么自己解析，而不用 spessasynth 的 `soundBankManager.presetList`
 *
 * 1. **不需要真加载就能显示**：用户刚选完 `.sf2`、库还没挂到 AudioWorklet 时，界面就要能报
 *    "这是什么库、有几个音色、哪些 bank"。走 `presetList` 得先把 141 MB 塞进 worklet 才有答案。
 * 2. **可断言**：本模块是纯函数，`npm run smoke` 用一份手搓的几十字节夹具就能逐字节验证；
 *    真文件（`resources/soundfonts/*.sf2`）只在"文件在"时再验一遍。
 * 3. **唯一出处**：库名与音色条数只从这里出，UI 不二次推断（AGENTS §六之二·4）。
 *
 * ## 只读哪些字节
 *
 * 只走 RIFF 的 `LIST INFO`（INAM/IENG/ISFT/ICMT/ifil）与 `LIST pdta` 的 `phdr`，
 * **不碰 `smpl`/`shdr` 的采样数据**（141 MB 里 99% 是采样）。
 *
 * ## 两个实测坑（2026-10，本机两个真实 sf2）
 *
 * 1. **`phdr` 末条终止记录并不总是全 0**：GeneralUser 与 FluidR3 都把名字写成了字符串 `"EOP"`。
 *    按"名字为空就跳过"来过滤是错的 —— 会把 **0 号音色覆盖成 `EOP`**。规范口径是
 *    **presets 数 = 记录数 − 1**，所以这里一律**无条件丢最后一条**。
 * 2. **记录顺序不可当索引**：FluidR3 的第一条是 `0:127 Gun Shot`。列表必须按 `(bank, program)`
 *    自己排序，否则"第 n 个音色"在库里根本不对应 program n。
 */
import type { HqSampleLibrary } from './soundbanks'
import { HQ_LIBRARIES } from './soundbanks'

/** SF2 的 INFO 段（缺哪个字段就没有哪个字段） */
export interface Sf2Info {
  /** 库名（INAM）——**识别"这是哪个库"的唯一依据**，比文件名可靠 */
  name?: string
  /** 作者（IENG） */
  engineer?: string
  /** 制作工具（ISFT） */
  software?: string
  /** 备注（ICMT；有的库把许可证写在这里） */
  comment?: string
  /** 规范版本（ifil），形如 `2.1` */
  version?: string
}

/** 一条预设（= 用户看到的"一个音色"） */
export interface Sf2Preset {
  /** 库号（SF2 的 wBank；GM 主音色是 0，鼓组常见 128） */
  bank: number
  /** 音色号（0-127；GM 主音色与 program 一一对应） */
  program: number
  /** **库自己的原始名**（多为英文，如 `Flute`） */
  name: string
}

/** 预设统计（界面要如实交代"本库另有 N 个变体/鼓组，暂不可选"） */
export interface Sf2PresetSummary {
  total: number
  /** bank 0（GM 主音色）的条数 */
  bank0: number
  /** 其余 bank（变体/鼓组）的条数 */
  other: number
  /** 用到的 bank 个数 */
  banks: number
}

/** `phdr` 每条记录固定 38 字节（name[20] + wPreset + wBank + wPresetBagNdx + 3×u32） */
const PHDR_RECORD_SIZE = 38
/** 记录里名字字段的长度 */
const PHDR_NAME_SIZE = 20
/** Git LFS 指针文件的首行前缀（用户右键另存 raw 时常见） */
const LFS_PREFIX = 'version https://git-lfs'

/** 4 字节 ASCII 标签 */
function tag(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

/** 统一成字节视图（`ArrayBuffer` / `Uint8Array` 都接） */
function bytesOf(buf: ArrayBuffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf)
}

/**
 * 读一段 latin-1 字符串（SF2 的文本字段就是单字节，不是 UTF-8）。
 *
 * 不引 `TextDecoder`：引擎要求零浏览器 API；逐字节取码位在 Node 与浏览器里结果一致。
 * 遇到 `\0` 即止（字段是定长、NUL 补齐的）。
 */
function decodeStr(b: Uint8Array, from: number, len: number): string {
  const end = Math.min(b.length, from + len)
  let s = ''
  for (let i = from; i < end; i++) {
    const c = b[i]
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  // 两端空白一律去掉：有些库把名字补成 "Flute       "
  return s.replace(/^\s+|\s+$/g, '')
}

/** 是不是 SoundFont2（`RIFF....sfbk`） */
export function isSf2Bytes(b: Uint8Array): boolean {
  return b.length >= 12 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'sfbk'
}

/** 是不是 SoundFont2（对外入口，接受 ArrayBuffer / Uint8Array） */
export function isSf2(buf: ArrayBuffer | Uint8Array): boolean {
  return isSf2Bytes(bytesOf(buf))
}

/**
 * 是不是 **Git LFS 指针文件**（不是音源本体）。
 *
 * 为什么单独判：第三方仓库把大文件放 LFS 后，用户在网页上"右键 → 另存链接"拿到的就是
 * 134 字节的指针文本。直接当音源导入会得到一份"不是 SF2"的垃圾，报错要说清原因。
 */
export function isGitLfsPointer(buf: ArrayBuffer | Uint8Array): boolean {
  const b = bytesOf(buf)
  // 指针文件必然很小（百来字节）；大于 4 KB 的不必白读
  if (b.length >= 4096) return false
  return decodeStr(b, 0, Math.min(b.length, LFS_PREFIX.length + 8)).startsWith(LFS_PREFIX)
}

interface RawChunk {
  id: string
  /** 负载起点（id/size 之后） */
  start: number
  /** 负载终点（不含） */
  end: number
}

/** 在 `[from, to)` 里按 RIFF 规则逐个取块（块长度按偶数对齐） */
function readChunks(b: Uint8Array, from: number, to: number): RawChunk[] {
  const out: RawChunk[] = []
  let o = from
  while (o + 8 <= to) {
    const id = tag(b, o)
    const size = u32(b, o + 4)
    const start = o + 8
    const end = start + size
    if (end > to) {
      // 文件被截断：把剩下的当这一块，然后收工（绝不越界读）
      out.push({ id, start, end: to })
      break
    }
    out.push({ id, start, end })
    o = end + (size & 1)
    if (size === 0 && id === '\0\0\0\0') break
  }
  return out
}

/** 找顶层 `LIST <type>`（INFO / sdta / pdta），返回它的**负载**范围（跳过 4 字节 type） */
function findList(b: Uint8Array, type: string): RawChunk | null {
  for (const c of readChunks(b, 12, b.length)) {
    if (c.id !== 'LIST' || c.end - c.start < 4) continue
    if (tag(b, c.start) !== type) continue
    return { id: type, start: c.start + 4, end: c.end }
  }
  return null
}

/**
 * 读 INFO 段。
 *
 * @returns 不是 SF2 ⇒ `null`；是 SF2 但没有 INFO ⇒ 空对象（调用方按"没有库名"处理）
 */
export function readSf2Info(buf: ArrayBuffer | Uint8Array): Sf2Info | null {
  const b = bytesOf(buf)
  if (!isSf2Bytes(b)) return null
  const info: Sf2Info = {}
  const list = findList(b, 'INFO')
  if (!list) return info
  for (const c of readChunks(b, list.start, list.end)) {
    const len = c.end - c.start
    switch (c.id) {
      case 'INAM': {
        const v = decodeStr(b, c.start, len)
        if (v) info.name = v
        break
      }
      case 'IENG': {
        const v = decodeStr(b, c.start, len)
        if (v) info.engineer = v
        break
      }
      case 'ISFT': {
        const v = decodeStr(b, c.start, len)
        if (v) info.software = v
        break
      }
      case 'ICMT': {
        const v = decodeStr(b, c.start, len)
        if (v) info.comment = v
        break
      }
      case 'ifil':
        if (len >= 4) info.version = `${u16(b, c.start)}.${u16(b, c.start + 2)}`
        break
      default:
        break
    }
  }
  return info
}

/**
 * 读 `pdta/phdr` 的预设表（**库自己的名字**，按 `(bank, program)` 升序）。
 *
 * ⚠ 末条终止记录一律丢掉（见文件头"两个实测坑"第 1 条）：规范是"记录数 − 1"，
 * 而现实中它可能被写成 `"EOP"` 而不是空字段。
 *
 * @returns 不是 SF2 ⇒ `null`；是 SF2 但没有 pdta/phdr ⇒ `[]`
 */
export function readSf2Presets(buf: ArrayBuffer | Uint8Array): Sf2Preset[] | null {
  const b = bytesOf(buf)
  if (!isSf2Bytes(b)) return null
  const list = findList(b, 'pdta')
  if (!list) return []
  const phdr = readChunks(b, list.start, list.end).find((c) => c.id === 'phdr')
  if (!phdr) return []
  const records = Math.floor((phdr.end - phdr.start) / PHDR_RECORD_SIZE)
  if (records <= 0) return []
  const out: Sf2Preset[] = []
  for (let i = 0; i < records - 1; i++) {
    const o = phdr.start + i * PHDR_RECORD_SIZE
    const name = decodeStr(b, o, PHDR_NAME_SIZE)
    // 名字为空的记录不是可显示的预设（正常文件里不该出现；防御性跳过）
    if (!name) continue
    out.push({ name, program: u16(b, o + 20), bank: u16(b, o + 22) })
  }
  return out.sort((x, y) => x.bank - y.bank || x.program - y.program)
}

/** 预设统计（界面文案用："共 N 个，当前可选 bank 0 的 M 个"） */
export function summarizeSf2Presets(presets: readonly Sf2Preset[]): Sf2PresetSummary {
  const banks = new Set<number>()
  let bank0 = 0
  for (const p of presets) {
    banks.add(p.bank)
    if (p.bank === 0) bank0++
  }
  return { total: presets.length, bank0, other: presets.length - bank0, banks: banks.size }
}

/** 正则编译缓存（`sf2NamePattern` 是常量串，`matchKnownLibrary` 会被反复调用） */
const patternCache = new Map<string, RegExp>()

/**
 * 按 **INAM** 认领到已知库 id（认不出返回 `null`）。
 *
 * 为什么必须按库名认、而不是按文件名：用户下载到的文件可能叫 `FluidR3_GM.sf2`、
 * `fluid (1).sf2`，甚至被上一个 bug 存进了别的库的键下 —— 只有内容里的 INAM 是可信的。
 * 同一个库的不同版本（GeneralUser 2.0.3 / v1.471）也由此归到同一个 id。
 *
 * @param libs 候选清单（默认引擎的已知库；插件/测试可传自己的）
 */
export function matchKnownLibrary(
  info: Sf2Info | null | undefined,
  libs: readonly HqSampleLibrary[] = HQ_LIBRARIES,
): string | null {
  const name = info?.name?.trim()
  if (!name) return null
  for (const lib of libs) {
    const src = lib.sf2NamePattern
    if (!src) continue
    let re = patternCache.get(src)
    if (!re) {
      try {
        re = new RegExp(src, 'i')
      } catch {
        // 规则写错不该让整个导入失败：跳过这一条（smoke 有断言守着规则本身可编译）
        continue
      }
      patternCache.set(src, re)
    }
    if (re.test(name)) return lib.id
  }
  return null
}
