/**
 * engine/layout/hairpins.ts — 渐强/渐弱（hairpin）语义与定位（adj393）
 *
 * 语法（docs/JPS-SPEC.md 第 4 节）：`<` 渐强起点、`>` 渐弱起点、`!` 终点，
 * 都写在该音符后 → 起点/终点取「**紧邻其前**的那个音符」的数字槽中心；`<+`/`>++`
 * 的 `+` 数量 = 抬升级数（每级 `VOLTA_RAISE` 2px）。
 *
 * 为什么单独成模块（adj393）：`<`/`>`/`!` 是**装饰 token**，此前只有「拍级（duration）
 * 布局」路径（`placeMusicRow`）处理它们，而**默认配置**是「空间优先（space）」
 * （`defaultPageConfig.noteSpaceLayout = 'space'`）→ 用默认设置写渐强/渐弱**完全不显示**
 * 且不报错（静默丢弃）；多声部块同样不处理。现把语义收敛到本模块的纯函数，
 * 各布局路径只负责「按源码顺序喂事件 + 提供音符中心 x」，杜绝"两处各写一份、只改一处"的漂移
 * （参见 docs/ERRORS-LOG.md E-2026-129 的同类教训）。
 */
import type { MusicToken } from '../types'

/** 行内事件：音符（用于数「第几个音符」）/ hairpin 起点 / hairpin 终点 */
export type DynEvent =
  | { kind: 'note' }
  | { kind: 'open'; type: 'crescendo' | 'decrescendo'; plus: number }
  /** `endOn`：`!` 写在哪类时值元素之后（note=音符数字后 / aug=增时线后 / dot=附点后，adj394） */
  | { kind: 'close'; endOn: 'note' | 'aug' | 'dot' }

/** 一个音符可供 hairpin 停靠的位置（绝对 x） */
export interface NoteAnchors {
  /** 数字槽中心：起点 `<`/`>` 与「`!` 写在音符后」的终点 */
  center: number
  /** 末时值元素（增时线/附点）的右缘：`!` 写在该元素之后时的终点 */
  end: number
}

/** 解析出的一对起止（x 为绝对坐标：起点 = 所跟音符槽中心，终点 = `!` 所跟音符槽中心或行尾） */
export interface HairpinSeed {
  type: 'crescendo' | 'decrescendo'
  x1: number
  x2: number
  /** 抬升级数（`+` 个数，>0 才有值） */
  plus?: number
}

/**
 * 可绘制的最小开口宽度（px，adj393）：头发夹的开口由 `M x1 midY L x2 midY±h` 两条线组成，
 * 起止 x 相同时两条线重合 → 看上去是**一根竖线**（用户报过这个现象）。
 * 小于此宽度的一律不产出（宁可不画，也不画一条毫无意义的竖线）。
 */
export const MIN_HAIRPIN_W = 2

/** `+` 个数（`<`/`>` 后允许连续多个） */
const countPlus = (code: string): number => {
  let n = 0
  for (const ch of code) if (ch === '+') n++
  return n
}

/**
 * 从一段 token 里按**源码顺序**取出 hairpin 事件（音符/休止符/节奏符各计一个 `note`）。
 * 各布局路径按行内小节顺序依次调用并拼接，即可得到整行的事件流。
 */
export function hairpinEvents(tokens: MusicToken[]): DynEvent[] {
  const out: DynEvent[] = []
  for (const t of tokens) {
    if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
      out.push({ kind: 'note' })
    } else if (t.kind === 'decoration' && t.dynamics) {
      if (t.dynamics === 'end') out.push({ kind: 'close', endOn: t.dynamicsEndOn ?? 'note' })
      else out.push({ kind: 'open', type: t.dynamics, plus: countPlus(t.code) })
    }
  }
  return out
}

/**
 * 事件流 → hairpin 对。
 *
 * 起点 `<`/`>`：**紧邻其前的音符**（数字槽中心；没有前导音符时用 `fallbackX`）。
 * 终点 `!`：写在该音符的增时线/附点之后时取**该元素右缘**（`anchors.end`），否则取数字槽中心。
 *
 * @param anchorsOf 第 i 个音符（**行内序号，从 0**）的停靠点；越界返回 undefined
 * @param fallbackX 起点侧没有前导音符时的兜底 x（行内容起点）
 * @param rowEndX  未写 `!` 的开区间在**行尾**收尾的 x（渐强/渐弱不跨行）
 */
export function resolveHairpins(
  events: DynEvent[],
  anchorsOf: (ordinal: number) => NoteAnchors | undefined,
  fallbackX: number,
  rowEndX: number,
): HairpinSeed[] {
  const out: HairpinSeed[] = []
  const at = (ordinal: number, endOn: 'note' | 'aug' | 'dot' = 'note'): number => {
    const a = anchorsOf(ordinal)
    if (!a) return fallbackX
    return endOn === 'note' ? a.center : a.end
  }
  /** 产出前统一做退化防护：起止 x 必须「终点在右且够宽」，否则不产出（避免画成一根竖线） */
  const push = (type: 'crescendo' | 'decrescendo', startX: number, endX: number, plus: number): void => {
    const x1 = Math.min(startX, endX)
    const x2 = Math.max(startX, endX)
    if (x2 - x1 < MIN_HAIRPIN_W) return // 起止落在同一处（如 `<` 紧跟 `!`）→ 不画，避免竖线
    out.push({ type, x1, x2, plus: plus > 0 ? plus : undefined })
  }

  let seen = 0 // 已遇到的音符个数（下一个音符的序号 = seen）
  let open: { type: 'crescendo' | 'decrescendo'; plus: number; start: number } | null = null
  for (const e of events) {
    if (e.kind === 'note') {
      seen++
      continue
    }
    if (e.kind === 'open') {
      // 起点 = 紧邻其前的音符（没有则兜底）；后写的起点覆盖前一个未闭合的起点
      open = { type: e.type, plus: e.plus, start: seen - 1 }
      continue
    }
    if (open) {
      push(open.type, at(open.start), at(seen - 1, e.endOn), open.plus)
      open = null
    }
  }
  if (open) push(open.type, at(open.start), rowEndX, open.plus)
  return out
}
