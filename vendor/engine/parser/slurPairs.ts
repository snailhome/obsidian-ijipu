/**
 * engine/parser/slurPairs.ts — **连音线配对**（纯逻辑：token 序列 → 成对的连音线 + **没画出来的那些**）
 *
 * ## 为什么要单独一个模块（此前这段内嵌在 `layout/index.ts` 里）
 *
 * 用户 2026-10-18 实报：「`Q: (4/ 6/ | (2'- 2'/) 1'/ (y7/ 6/ 3/) | 5)` 这一段里，内层的 1 个连音线
 * 和 1 个等时值连音线都没有画出来」—— 查下来**根因不是这一段本身**，而是**上一行多了一个 `(`**：
 * 它让整栈深度 +1，内层两条落到 `depth ≥ 2`，而配对里有条渲染层数限制（`adj91`：**最多两层嵌套**）
 * 会在弹栈时把它们**静默丢掉**；最后那个 `)` 配掉的是 depth 1 那条（于是画出来的是**配错**的一条），
 * 行首那个多余 `(` 从头到尾没人关、也静默消失。⇒ 用户看到的就是"两条连音线不见了"，**一句提示都没有**。
 *
 * 要发告警，就必须**知道配对结果**（"哪几条被丢了"）；而配对此前只有布局里那份实现。
 * 若在别处再写一份"看起来一样"的配对来做检查，迟早会与布局那份**漂开**（本项目的老毛病：
 * 同一口径两处实现必然漂）⇒ 把它抽成**唯一一份**纯函数：
 *   · `parseJps()` 跑它一次：拿 `pairs` 给几何用、把 `problems` 并进 `parseResult.errors`
 *     （于是**应用 / Obsidian 插件 / 命令行 lint 三处零改动**就能在问题面板里看到这些告警）；
 *   · `layout/index.ts` 只消费 `parseResult.slurPairs`，**不再自己配对**。
 *
 * ## 配对规则（全部沿用既有口径，逐个标注来历，勿凭感觉改）
 *
 * · **先进后出**（LIFO 栈，`adj55`）：最近打开的先闭合，标准括号嵌套；**栈跨行保留**
 *   （上一行未闭合的 `(` 延续到下一行配对 ⇒ 跨行连音线画两半）；
 * · **同起点嵌套**（`adj56`）：一个音符要把栈里**所有**还没锚定起点的开括号都锚上
 *   （`((3 2/) 4)` 内层与外层都从 3 开始）；
 * · **连接点规则**（`adj321`）：`(1 (2) 3)` 里那个退化对内层（只覆盖 1 个音符）不是嵌套，
 *   而是"前一连音终止于 2、并以 2 起一条新连音"⇒ 两条；多音符内层（`(1(2 3))`）才算真嵌套；
 * · **渲染层数**（`adj91`）：`depth < 2` 才产出（最多两层）。**超出即丢** —— 本轮就是在这里丢的，
 *   现在会**发告警**（见 `problems`）；
 * · **跨跳房子延续线**（`adj651`）：后面房子里的**孤立 `)`** 连回"跨过房子起始线那条连音线"的起点。
 */
import type { MusicToken, ParseError, ParseResult, SlurPair } from '../types'

export type { SlurPair }

export interface SlurPairing {
  /** 要画的那些（布局按它算几何） */
  pairs: SlurPair[]
  /** `adj651c`：延续类连音线的（起点, 终点）音符索引对——交给播放端把两半并成一个长音 */
  continuationTies: { start: number; end: number }[]
  /** **没画出来的那些**（都按 `warning`：谱面照常渲染，只是这几条线没有）+ 括号本身的问题 */
  problems: ParseError[]
}

/** 「正确写法」提示（告警里跟着给出，别只告诉用户"哪里错了"） */
const HINT_PAIRED = '`(` 与 `)` 必须成对；连音线至少要连接 **2 个音符**，如 `(1 2)`'
const HINT_DEPTH = '连音线**最多嵌套两层**；本条在第三层及更深处、因此没有绘制。' +
  '常见原因是**前面多写了一个 `(`**（会把内层的线整体挤到第三层）——请检查括号是否配对'
const HINT_STRAY_CLOSE = '多了一个 `)`（前面没有未闭合的 `(`）。' +
  '若这是跳房子里那条"延续连线"，要确保前面已有一条**跨过该房子起始小节线**的连音线'

/**
 * 把 token 序列配成连音线（**纯函数**，可反复调用）。
 *
 * @param result 解析结果（要用它的 `groups` / 每行的 `raw` 来算告警的行列锚点）
 */
export function pairSlurs(result: ParseResult): SlurPairing {
  const pairs: SlurPair[] = []
  const continuationTies: { start: number; end: number }[] = []
  const problems: ParseError[] = []

  /**
   * 括号 token 在**行内**的列（告警锚点；`pos` 是行内**内容**偏移 ⇒ 加上行首空白与曲行前缀）。
   *
   * ⚠ 前缀这里**不能用** `jpsHighlight` 的 `jpsHeaderOf().headLen`：那条正则**不含冒号后的空格**
   * （`\s*` 在冒号**前**）⇒ 列号会**少 1 格**（实测：告警落在 `(` 前面那个空格上）。
   * 与 `parser.ts` 那条 `^Q(\d*)(?:"([^"]*)")?\s*:\s*(.*)$` 的**前缀部分同形状**；
   * 这条口径由 smoke 的行为判据钉住 ——「告警的列必须**正好落在那个括号字符上**」（拿源码取字符核对）。
   */
  const MUSIC_HEAD_RE = /^Q\d*(?:"[^"]*")?\s*:\s*/
  const colOf = (raw: string, t: MusicToken): number => {
    const leading = raw.length - raw.trimStart().length
    const trimmed = raw.trimStart()
    const headLen = MUSIC_HEAD_RE.exec(trimmed)?.[0].length ?? 0
    return leading + headLen + (t.pos ?? 0)
  }

  interface OpenSlur {
    start: number
    depth: number
    tuplet: boolean
    plus: number
    minus: number
    barSeq: number
    /** 开括号 token 的位置（行号 + 行内列）—— 告警要知道"说的是哪一个 `(`" */
    line: number
    col: number
  }

  const sQueue: OpenSlur[] = []
  let gNote = 0
  let lastNote = -1
  /**
   * `adj651`（用户要求）：**跨跳房子连音线**。
   *
   * `(5/ |["1." 5/)` 这种「起点在小节线**之前**、终点是跳房子**首音**」的连音线，
   * 在后面的房子里用**孤立 `)`**（前面没有未闭合的 `(`）延续——连回**同一条连音线的起点**
   * （用户原话：「跳房子 2、结束句和跳房子 1 的第一个 5 都是与跳房子 1 的小节线前面的 5 连音」）。
   *
   * 为什么不能只认「上一条已闭合的连音线」：房子之间常夹着别的连线
   * （本例 `(5 |["1." 5/)` 后面紧跟 `(6/ 6)`），取"最近闭合"会连到 6 上。
   * 所以只记住**跨过房子起始小节线**那一条的起点。
   */
  let houseTieStart = -1
  /** 已扫描到的小节线根数（含纯跳房子起点）——判断连音线是否跨过房子起始线 */
  let barSeq = 0
  /** 「跳房子首音」音符索引集合 + 各自起始小节线的小节线序号（配对时判定跨线） */
  const voltaFirstNotes = new Set<number>()
  const voltaFirstBarSeq = new Map<number, number>()
  let expectVoltaFirst = false
  let pendingVoltaBarSeq = -1

  /**
   * `adj651`：登记一条连音线；若它「跨过房子起始小节线且终点是该房子首音」，
   * 就记下它的起点，供后续房子里的孤立 `)` 延续。
   */
  const pushSlurPair = (
    start: number,
    end: number,
    depth: number,
    tuplet: boolean,
    plus: number,
    minus: number,
    openBarSeq: number,
    houseTie = false,
  ): void => {
    pairs.push({ start, end, depth, tuplet, plus, minus, houseTie })
    if (voltaFirstNotes.has(end) && openBarSeq < (voltaFirstBarSeq.get(end) ?? -1)) houseTieStart = start
  }

  for (const group of result.groups) {
    const music = group.music
    for (const t of music.tokens) {
      if (t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm') {
        // `adj56`：同起点嵌套 —— 一个音符锚定栈中**所有**尚未设置起点的开括号
        // （如 `((3 2/) 4)`：内层与外层连音线都从 3 开始，不能只锚定队尾）
        for (const s of sQueue) {
          if (s.start === -1) s.start = gNote
        }
        // `adj651`：紧跟跳房子起始小节线的第一个音符 = 该房子首音（供跨线判定）
        if (expectVoltaFirst) {
          voltaFirstNotes.add(gNote)
          voltaFirstBarSeq.set(gNote, pendingVoltaBarSeq)
          expectVoltaFirst = false
        }
        lastNote = gNote
        gNote++
      } else if (t.kind === 'barline') {
        // `adj651`：只需数根数与识别房子起始——连音线跨线判定用
        barSeq++
        if (t.voltaStart) {
          pendingVoltaBarSeq = barSeq
          expectVoltaFirst = true
        }
      } else if (t.kind === 'slur') {
        if (t.dir === 'open') {
          const col = colOf(music.raw, t)
          sQueue.push({
            start: -1,
            depth: sQueue.length,
            tuplet: t.tuplet === true,
            plus: t.plus ?? 0,
            minus: t.minus ?? 0,
            barSeq,
            line: music.pos.line,
            col,
          })
        } else {
          // `adj55`：先进后出 —— pop 最近打开的开括号；栈跨行保留（未闭合延续到后续行）
          const s = sQueue.pop()
          if (s && s.start !== -1 && lastNote >= s.start) {
            if (s.start === lastNote && sQueue.length > 0) {
              // `adj321` 连接点：终止栈内前一个未闭合连音（prev）于 X，并以 X 为起点重开新连音
              const prev = sQueue.pop()
              if (prev && prev.start !== -1 && lastNote >= prev.start) {
                pushSlurPair(prev.start, lastNote, prev.depth, prev.tuplet, prev.plus, prev.minus, prev.barSeq)
              }
              // 新连音从 X 起，层级取被终止的 prev（断开嵌套，保持可渲染）
              sQueue.push({ ...s, start: lastNote, depth: prev ? prev.depth : s.depth })
            } else if (s.depth < 2) {
              // 普通配对（受 `adj91` 的 `depth < 2` 渲染限制：最多两层嵌套）
              pushSlurPair(s.start, lastNote, s.depth, s.tuplet, s.plus, s.minus, s.barSeq)
            } else {
              /**
               * adj973（**用户 2026-10-18 实报**）：**嵌套超过两层 ⇒ 不绘制**，此前**静默**。
               * 本轮用户那份谱就是这个下场（上一行多了一个 `(` ⇒ 内层两条落到第三层）。
               * ⇒ 现在发一条 `warning`，把"哪一行哪个 `(` 没画出来"直接说给用户听。
               */
              problems.push({
                line: s.line,
                col: s.col,
                message: '这条连音线嵌套超过两层（最多两层），没有绘制',
                severity: 'warning',
                hint: HINT_DEPTH,
              })
            }
          } else if (!s && houseTieStart >= 0 && lastNote > houseTieStart) {
            // `adj651`：孤立 `)`（前面没有未闭合的连音线）= **延续那条跨跳房子的连音线**——
            // 一律连回它的起点（不改起点 → 跳房子 2 / 结束句 / 跳房子 1 三条共用同一起音）
            pushSlurPair(houseTieStart, lastNote, 0, false, 0, 0, barSeq, true)
            // `adj651c`：登记给播放端（同音连线要并成一个长音）
            continuationTies.push({ start: houseTieStart, end: lastNote })
          } else {
            /**
             * adj973（ⓑ，用户要求）：**多出来的 `)`** —— 前面没有未闭合的 `(`（也不是跳房子延续线）。
             * 此前同样静默：整条连线凭空消失，而用户只能盯着源码找那个多余的括号。
             * 锚点取**这个 `)` 自己**（它才是多余的那个）。
             */
            const at = colOf(music.raw, t)
            problems.push({
              line: music.pos.line,
              col: at,
              message: '多了一个 `)`（前面没有未闭合的 `(`）',
              severity: 'warning',
              hint: HINT_STRAY_CLOSE,
            })
          }
        }
      }
    }
  }

  /**
   * adj973（ⓑ，用户要求）：**谱面结束时仍有未闭合的 `(`** ⇒ 这些线一条也画不出来，此前静默。
   * 只报"括号后面**有音符**"的那些（`start !== -1`）：`()` 里没音符属于退化写法，没有线可画，不吵人。
   */
  for (const s of sQueue) {
    if (s.start === -1) continue
    problems.push({
      line: s.line,
      col: s.col,
      message: '连音线的 `(` 没有对应的 `)`，这条线没有绘制',
      severity: 'warning',
      hint: HINT_PAIRED,
    })
  }

  return { pairs, continuationTies, problems }
}
