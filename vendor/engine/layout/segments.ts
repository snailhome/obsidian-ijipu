/**
 * engine/layout/segments.ts — 临时段（`{bz … }` / `{dsb … }`）的**拍位包络**计算（adj427）
 *
 * 语义（依据用户规范 + 图 1/图 2 反推验证）：
 *  - 临时段是**叠加**：出现在曲行中间时**不占主旋律时值**（对主旋律时间轴贡献 0 拍），
 *    段后的 token 从段前同一拍位继续。
 *  - **包络** = `[段所在拍位, 段所在拍位 + 段自身总拍数)`；用户规则「bz 段总宽 =
 *    包裹范围主旋律拍数」即：段内内容按比例映射到该宽度内，段内**小节线**按段内自身
 *    拍位推进后映射到包络内的相对位置。
 *
 * 用图 1 示例验证：`3 4 | {bz 1 2 3 4 | 5 6 7 1'} 5 6 7 1' | 1' 7 6 5 | 5 5`
 *  - `3 4` 占拍 0~2 → 段出现在**拍位 2**
 *  - 段内 8 个音（各 1 拍）= 8 拍 → **包络 [2, 10)**
 *  - 主旋律在 [2, 10) 内恰为 `5 6 7 1' | 1' 7 6 5`（8 拍）—— 即 dsb 的**下层声部**
 *  - 主旋律包络外剩余 `5 5`
 *
 * 本模块只做**纯计算**（零 React/DOM/浏览器 API），layout 与 render 共用；
 * 关键行为在 `scripts/smoke.mts` 有断言。
 */
import type { MusicToken } from '../types'
import { tokenDuration } from '../duration'

/** 计时 token 联合（音符 / 休止符 / 节奏符）——由下方 isDurational 收窄 */
export type DurationalToken = Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }>

/** 可计时的 token 种类判定（音符 / 休止符 / 节奏符）——类型谓词，便于调用处自动收窄 */
export function isDurational(t: MusicToken): t is DurationalToken {
  return t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'
}

/** 一段 token 序列的总拍数（只累加计时 token；段对时间的贡献为 0，天然跳过） */
export function tokensBeats(tokens: MusicToken[]): number {
  let sum = 0
  for (const t of tokens) if (isDurational(t)) sum += tokenDuration(t)
  return sum
}

/** 段内小节线的**拍位**列表（按段内自身拍位从 0 起推进）——供「段内小节线按自身拍位映射」 */
export function segmentBarBeats(tokens: MusicToken[]): number[] {
  const out: number[] = []
  let beat = 0
  for (const t of tokens) {
    if (t.kind === 'barline') {
      out.push(beat)
      continue
    }
    if (isDurational(t)) beat += tokenDuration(t)
  }
  return out
}

/** 一个临时段的包络信息 */
export interface SegmentInfo {
  /** 段类型：bz 临时伴奏 / dsb 临时多声部 */
  type: 'bz' | 'dsb'
  /** 段头（open）token 在 token 序列中的下标 */
  openIndex: number
  /** 段结束（close）token 下标；-1 = 未闭合（tokenizer 兜底路径） */
  closeIndex: number
  /** 包络起始拍（段出现处的主旋律拍位） */
  startBeat: number
  /** 段自身总拍数（= 包络长度） */
  beats: number
  /** 段内 token（段头 token 的 children） */
  tokens: MusicToken[]
  /** 段内小节线拍位（相对段起点，0 起） */
  barBeats: number[]
}

/** 主旋律中一个计时 token 的拍位跨度 */
export interface MainSpan {
  token: DurationalToken
  /** token 在 token 序列中的下标 */
  index: number
  /** 起始拍 */
  startBeat: number
  /** 拍数 */
  beats: number
}

/**
 * 计算曲行内全部临时段的包络信息（按源码顺序）。
 *
 * 段对主旋律时间轴贡献 **0 拍**——因此段后的 token 与段前的拍位连续；
 * `Map<openIndex, SegmentInfo>` 形式便于 layout 在遇到段 token 时 O(1) 取用。
 */
export function computeSegments(tokens: MusicToken[]): SegmentInfo[] {
  const out: SegmentInfo[] = []
  let beat = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'segment') {
      if (t.dir === 'open') {
        const children = t.children ?? []
        // close 配对：tokenizer 保证 open 紧邻 close；此处只探一步，不跨越其它 token
        const next = tokens[i + 1]
        const closeIndex = next && next.kind === 'segment' && next.dir === 'close' && next.type === t.type ? i + 1 : -1
        out.push({
          type: t.type,
          openIndex: i,
          closeIndex,
          startBeat: beat,
          beats: tokensBeats(children),
          tokens: children,
          barBeats: segmentBarBeats(children),
        })
      }
      continue // 段不占主旋律拍位
    }
    if (isDurational(t)) beat += tokenDuration(t)
  }
  return out
}

/**
 * 主旋律的计时 token 跨度表（**跳过临时段**——段不占主旋律拍位）。
 *
 * 用途：
 *  - 取包络内主旋律音（dsb **下层声部**；bz 则用于确认叠加对象）；
 *  - 主旋律 x 坐标与包络 x 区间对齐（layout）。
 */
export function mainSpans(tokens: MusicToken[]): MainSpan[] {
  const out: MainSpan[] = []
  let beat = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!isDurational(t)) continue
    const beats = tokenDuration(t)
    out.push({ token: t, index: i, startBeat: beat, beats })
    beat += beats
  }
  return out
}

/** 取与 [from, to) 有交集的计时 token 跨度（dsb 下层声部 / 包络内取音） */
export function mainSpansInRange(spans: MainSpan[], from: number, to: number): MainSpan[] {
  return spans.filter((s) => s.startBeat < to - 1e-9 && s.startBeat + s.beats > from + 1e-9)
}

/** 段内相对拍位 → 包络内相对比例（钳制到 [0,1]；totalBeats ≤ 0 时返回 0） */
export function beatRatio(beatInSegment: number, totalBeats: number): number {
  if (totalBeats <= 0) return 0
  return Math.min(1, Math.max(0, beatInSegment / totalBeats))
}
