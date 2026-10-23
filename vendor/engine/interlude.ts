/**
 * engine/interlude.ts — 「间奏时长」的唯一口径（`{jz N}` 与注记 `间奏N拍`）
 *
 * 用户口径（2026-10-24 拍板，见 `docs/EXTERNAL-ACCOMPANIMENT-PLAN.md` §4-A）：
 *  · 写法：`{jz N}` 跟在**休止符**后面（`0{jz 16}` / `0 {jz 16}` / `0---{jz 16}` 都行；
 *    `{jz16}` 也认，`}` 是硬边界）；
 *  · **替换**口径：`0{jz 16}` = 这个休止符**一共响 16 拍**（不是"再加 16 拍"）；
 *  · **零宽**：只改播放时间轴，排版占用宽一个像素都不动（`tokenDuration` 不参与）；
 *  · 等价写法：注记里的 `间奏N拍` / `N拍间奏`（如 `0"16拍间奏略"`）——**只从 comment 现读**，
 *    不写进 token，解析器一个字段都不用加；
 *  · `{jz N}` 优先于注记（两个都写时以显式为准）。
 *
 * 为什么单独一个模块：播放序列（`playback/sequence.ts`，本该多久）、小节校验
 * （`measures.ts`，这一小节要不要豁免）与宿主（色块要不要罩住整段）都要问同一个问题
 * ——按过 AGENTS「数值口径必须同源」，只在这里定义一次。
 */
import type { MusicLine, MusicToken, ParseError, ParseResult } from './types'
import { errAt } from './parser/errors'
import { tokenDuration } from './duration'

/** `间奏 16 拍` / `16 拍间奏`（注记里的等价写法）——两种语序都认 */
const COMMENT_PATTERNS: readonly RegExp[] = [
  /间奏\s*(\d+(?:\.\d+)?)\s*拍/,
  /(\d+(?:\.\d+)?)\s*拍\s*间奏/,
]

/**
 * 这个 token 的**间奏总拍数**（已按「替换」口径解释）；没有间奏标记 → `null`。
 *
 * · 只认休止符（`0` 可见 / `8` 隐藏）——间奏是"静默多久"，挂在音符上没有意义；
 * · `{jz N}` 显式值优先；否则看注记文本；
 * · 非法/非正数一律当"没有"（解析端已给告警，这里不再重复报）。
 */
export function interludeBeatsOf(t: MusicToken): number | null {
  if (t.kind !== 'rest') return null
  const explicit = t.interludeBeats
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit
  const comment = t.comment
  if (typeof comment === 'string' && comment.length > 0) {
    for (const re of COMMENT_PATTERNS) {
      const m = re.exec(comment)
      if (!m) continue
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

/**
 * 相对**排版时值**多出来的拍数（`0---{jz 16}` 的排版时值是 4 拍 ⇒ 额外 12 拍）。
 *
 * 播放时间轴只要把这个数加进"小节起点/小节内拍位"的累计里，后面所有事件就整体顺延；
 * 而 layout 用的是 `tokenDuration`（不含它）⇒ 排版不动。
 *
 * @param layoutBeats 该 token 的排版时值（调用方给 `tokenDuration(t)`）
 */
export function interludeExtraBeats(t: MusicToken, layoutBeats: number): number {
  const n = interludeBeatsOf(t)
  if (n === null) return 0
  return n > layoutBeats ? n - layoutBeats : 0
}

/** `Q1"女声": ` 这类前缀的长度——token 的 `pos` 是"行内容内偏移"，加上它才是整行列号 */
function contentPrefixLen(raw: string): number {
  const trimmed = raw.trim()
  const m = /^Q\d*(?:"[^"]*")?\s*:\s*/.exec(trimmed)
  return m ? m[0].length : 0
}

/**
 * adj1118：**间奏写法的两条迁移提示**（只针对"从注记读出来"的老写法）。
 *
 * 为什么只针对注记：`{jz N}` 是用户**显式**写的，语义不会有歧义（N 就是这个休止符的时长）；
 * 而老谱面（`0"16拍间奏略" 0 0 0`）的 N 是**整段间奏的长度**，写在一个"4 拍小节"里——
 * 按替换口径会变成 16 + 3 = 19 拍。不提示的话，这是一条**静默错 3 拍**的播放差异。
 *
 * 两条：
 *  ① 注记里提到「间奏」但**没写拍数**（`0"间奏略"`）⇒ 间奏按谱面时值播放，别指望自动对齐；
 *  ② 注记写了 N 拍、但**本小节还有其它时值** ⇒ 实际播放 N + 其它时值，提示改成 `0---{jz N}`。
 *
 * 返回 `warning`（引擎只有 error/warning 两级；不阻塞渲染/播放，只进问题条）。
 */
export function interludeDiagnostics(result: ParseResult): ParseError[] {
  const out: ParseError[] = []
  /**
   * 小节号**按声部跨行累加**（与 `measures.ts` 同一口径）：同一旋律折成多行 `Q:` 时，
   * 第二行接着上一行数，而不是又从第 1 小节开始——否则提示里的"第几小节"与用户
   * 在标记段下拉里看到的号对不上（AGENTS「数值口径必须同源」）。
   */
  const measureNoByVoice = new Map<number, number>()
  for (const line of result.lines as MusicLine[]) {
    if (line.kind !== 'music') continue
    const prefixLen = contentPrefixLen(line.raw)
    let measureNo = measureNoByVoice.get(line.voice) ?? 0
    let measure: MusicToken[] = []

    const flush = (): void => {
      if (measure.length === 0) return
      measureNo += 1
      const durational = measure.filter(
        (t): t is Extract<MusicToken, { kind: 'note' | 'rest' | 'rhythm' }> =>
          t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm',
      )
      const sum = durational.reduce((a, t) => a + tokenDuration(t), 0)
      for (const t of durational) {
        if (t.kind !== 'rest') continue
        const comment = t.comment ?? ''
        if (comment === '' || !/间奏/.test(comment)) continue
        const explicit = typeof t.interludeBeats === 'number' && t.interludeBeats > 0
        const fromComment = explicit ? null : interludeBeatsOf(t)
        const col = prefixLen + (typeof t.pos === 'number' ? t.pos : 0)
        if (!explicit && fromComment === null) {
          out.push(
            errAt(
              `注记里提到「间奏」但没写几拍（第 ${measureNo} 小节）：间奏会按谱面时值播放`,
              line.pos.line,
              col,
              'warning',
              '要对准伴奏请写 `{jz N}`，如 `0{jz 16}`（N = 这个休止符一共响几拍）；' +
                '想让这一小节还是 4 拍宽就写 `0---{jz 16}`',
            ),
          )
          continue
        }
        if (fromComment !== null) {
          const own = tokenDuration(t)
          const others = sum - own
          if (others > 1e-6) {
            out.push(
              errAt(
                `第 ${measureNo} 小节：注记里的间奏 ${fromComment} 拍按**这个休止符**的时长算，` +
                  `本小节还有 ${Math.round(others * 100) / 100} 拍其它时值 ⇒ 实际播放 ${Math.round((fromComment + others) * 100) / 100} 拍`,
                line.pos.line,
                col,
                'warning',
                `要让整小节就是 ${fromComment} 拍，把它写成 \`0---{jz ${fromComment}}\`（增时线只影响排版宽、不改播放时长）`,
              ),
            )
          }
        }
      }
      measure = []
    }

    for (const t of line.tokens) {
      if (t.kind === 'barline') {
        flush()
        continue
      }
      if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') measure.push(t)
    }
    flush()
    // 该声部的小节号接着下一行用（与 measures.ts 同口径）
    measureNoByVoice.set(line.voice, measureNo)
  }
  return out
}
