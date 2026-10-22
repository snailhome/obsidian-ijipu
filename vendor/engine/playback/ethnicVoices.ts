/**
 * engine/playback/ethnicVoices.ts — 民族乐器名的**拟声映射**（adj1019）
 *
 * ## 为什么需要它
 *
 * GM 的 128 个 program 里**没有**二胡、琵琶、古筝、唢呐这些乐器。用户照常写
 * `Y: 二胡` / `@琵琶@` 时，旧行为会落到"认不出 ⇒ 钢琴 0"——听起来完全不对。
 * 这里给一张**明确的对应表**：民族乐器名 → 最接近的 GM program。
 *
 * ## 为什么所有地方都要带「拟」
 *
 * 这些映射**只是"像"，不是"是"**：Fiddle 不是二胡、Koto 不是古筝。
 * 如果界面上只显示 `二胡 → 110`，用户会以为音源里真有二胡采样，拿去做正式作品才发现不对。
 * 所以「拟」要标出来 —— 但**标在页签/说明上，不标在名字上**（adj1029）：
 * 名字是给用户写进 `@二胡@` 的，带后缀就写不进去。页签标题「民族乐器（拟）」+ 一句说明足够。
 *
 * 要真实民乐，请用外部音源（Ample China / Kong Audio 等 VST），应用侧只负责排谱与导出 MIDI。
 *
 * ## 两条维护约束
 *
 * 1. `program` 按 **MIDI 标准**取（决定听到的声音）；显示名取 `GM_VOICES` 的中文名。
 *    ⚠ `GM_VOICES` 是个别条目与标准有偏差的老表（如 45/46 的竖琴/定音鼓错位），
 *    所以**声音按 program 走、显示按表走**，两者可能看着不一致——这是老问题，不在本模块修。
 * 2. 表里**只放 GM 里没有的名字**（二胡/琵琶…）；`长笛`/`小提琴` 这类 GM 已有的名字
 *    必须继续走 `GM_VOICES`，smoke 有负对照守着。
 */
import { GM_VOICES } from './gmVoices'

/** 一条拟声映射 */
export interface EthnicAlias {
  /** 谱面里可写的中文名（尽量收常见写法） */
  name: string
  /** 落到哪个 GM program（0–127，按 MIDI 标准） */
  program: number
  /** 可选的一句说明（为什么选它 / 它的局限） */
  note?: string
}

/**
 * 民族乐器 → GM program（**拟声**）。
 *
 * 选型原则：优先"发声方式相同"（弓弦→弓弦、拨弦→拨弦、双簧→双簧），
 * 其次才是音域。所以二胡→110(Fiddle)、琵琶→105(Banjo)、唢呐→111(Shanai)。
 */
export const ETHNIC_ALIASES: EthnicAlias[] = [
  // ── 弓弦 ──
  { name: '二胡', program: 110, note: '弓弦；没有滑音与揉弦技巧' },
  { name: '高胡', program: 110 },
  { name: '中胡', program: 110 },
  { name: '板胡', program: 110 },
  { name: '京胡', program: 110 },
  { name: '马头琴', program: 110 },
  // ── 拨弦 ──
  { name: '琵琶', program: 105, note: '短促颗粒感接近' },
  { name: '柳琴', program: 105 },
  { name: '月琴', program: 105 },
  { name: '阮', program: 105 },
  { name: '中阮', program: 105 },
  { name: '三弦', program: 106 },
  { name: '古筝', program: 107, note: '拨弦+余韵最接近' },
  { name: '筝', program: 107 },
  { name: '古琴', program: 107 },
  { name: '箜篌', program: 46 },
  { name: '扬琴', program: 15, note: '同是击弦' },
  // ── 吹管 ──
  { name: '笛子', program: 73 },
  { name: '竹笛', program: 73 },
  { name: '曲笛', program: 73 },
  { name: '梆笛', program: 72, note: '梆笛音区高' },
  { name: '箫', program: 77 },
  { name: '洞箫', program: 77 },
  { name: '南箫', program: 77 },
  { name: '尺八', program: 77 },
  { name: '唢呐', program: 111, note: '同样是双簧哨片' },
  { name: '海笛', program: 111 },
  { name: '管子', program: 111 },
  { name: '笙', program: 20 },
  { name: '芦笙', program: 20 },
  { name: '葫芦丝', program: 20 },
  { name: '埙', program: 79 },
  { name: '陶笛', program: 79 },
  { name: '排箫', program: 75 },
  // ── 打击 ──
  { name: '堂鼓', program: 116 },
  { name: '大鼓', program: 116 },
  { name: '排鼓', program: 116 },
  { name: '木鱼', program: 115 },
  { name: '梆子', program: 115 },
  { name: '编钟', program: 14 },
  { name: '编磬', program: 14 },
  { name: '锣', program: 118, note: '锣没有专门采样，只能用近似的打击音' },
  { name: '大锣', program: 118 },
  { name: '小锣', program: 118 },
  { name: '镲', program: 119 },
  { name: '钹', program: 119 },
]

/**
 * 按名字查拟声映射（全名匹配；不做模糊匹配，避免"笛"误吞"长笛"）。
 *
 * adj1029（用户 2026-10-21）：**兼容带「（拟）」的写法** —— 界面上曾把标签写成
 * `二胡（拟）`，用户可能照着复制；`二胡（拟）` / `二胡(拟)` 都按 `二胡` 认。
 * 这层只是"别让人写不进去"，正常写法仍是裸名。
 */
export function ethnicAliasOf(name: string | undefined | null): EthnicAlias | undefined {
  if (!name) return undefined
  const key = name.trim().replace(/[（(]拟[）)]$/, '').trim()
  if (key === '') return undefined
  return ETHNIC_ALIASES.find((a) => a.name === key)
}

/**
 * adj1028：**用户勾选了哪些民族乐器**（null = 全部可用）。
 *
 * 语义（用户 2026-10-21）：「勾选后，二胡音色名称可用，在 jps 脚本中指定 `@二胡@`
 * 时播放的就是 110 民谣提琴的音色」。所以：
 *  · `null`  ⇒ 宿主没接这个开关（插件 / CLI / 单测）⇒ 保持旧行为，全部可用；
 *  · `[]`    ⇒ 应用里一个都没勾 ⇒ 民族乐器名**不生效**（退回普通解析，通常是钢琴）；
 *  · `[..]`  ⇒ 只有勾选过的名字会落到 `program`。
 *
 * 为什么用模块级状态而不是给 `instrumentToProgram` 加参数：调用链（parser → sequence →
 * midi/播放后端）都在引擎内部，逐个透传参数会改十几个签名；而"当前用户勾了哪些"本来就是
 * 全局设置，不是每次调用的局部参数。宿主只需在设置变化时 `setEnabledEthnicVoices` 一次。
 */
let enabledEthnic: Set<string> | null = null

/** 设置可用集合；传 `null` 恢复"全部可用"（宿主退出/测试复位用） */
export function setEnabledEthnicVoices(names: readonly string[] | null): void {
  enabledEthnic = names === null ? null : new Set(names.map((n) => n.trim()).filter(Boolean))
}

/** 当前可用集合（`null` 表示"全部可用"，界面据此显示"未接管"） */
export function enabledEthnicVoices(): ReadonlySet<string> | null {
  return enabledEthnic
}

/** 这个名字现在能不能按拟声演奏 */
export function isEthnicUsable(name: string | undefined | null): boolean {
  const key = (name ?? '').trim()
  if (!key || !ethnicAliasOf(key)) return false
  return enabledEthnic === null || enabledEthnic.has(key)
}

/**
 * **可书写名**（谱面里写的就是它）：返回裸名字 `二胡`。
 *
 * adj1029（用户 2026-10-21）：「我写民乐乐器时是写 `@高胡@`，还是 `@高胡（拟）@`？」
 * 名字是拿来写进脚本的，带后缀就写不进去；「拟」是**页签的说明**（标题已是
 * 「民族乐器（拟）」），不该粘在名字上。所以这里不再拼「（拟）」。
 */
export function ethnicLabel(alias: Pick<EthnicAlias, 'name'>): string {
  return alias.name
}

/**
 * 显示"它到底会用什么音色"：取 `GM_VOICES` 的 `N 名称`（如 `110 民族琴`）。
 * 取不到就退化成 `program N`（表里没有这个号也不该崩）。
 */
export function ethnicGmLabel(alias: Pick<EthnicAlias, 'program'>): string {
  const v = GM_VOICES.find((x) => x.program === alias.program)
  return v ? v.label : `program ${alias.program}`
}
