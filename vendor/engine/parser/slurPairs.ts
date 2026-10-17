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
/** adj983：`|:` 之后那个 `)` —— 既是"反复前那条 `(`"的闭合，也是"反复体末尾那条 `(`"跳回的闭合 */
interface WrapCand {
  note: number
  line: number
  col: number
  barSeq: number
  used?: boolean
}
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
  /**
   * adj983（**用户 2026-10-18 实报**）：**反复跳回**的连音线。
   *
   * 用户原话：「上例中如图，最后一个 Q 行的 `(6/[5/]` 因为 `:|` 再跳回 `|:` 接着第一个 Q 行的
   * `6/)`，因此 `(6/[5/]` 的连音线还是有效的跨行连音线，还是要画，且接到第一个 Q 行」。
   *
   * 线性扫描下这一对是**反的**：先遇到首行 `|: 6/)` 那个 `)`（栈为空 ⇒ 以前判"多余"），
   * 再遇到末行 `(6/[5/]` 的 `(`（到谱末仍未闭合 ⇒ 以前判"没配对"）。两条告警都发错了。
   *
   * 规则：孤立 `)` 若出现在**反复起点 `|:` 之后**，并且它后面**还有**一个未闭合的 `(`、
   * 那个 `(` 之后又有**反复终点 `:|`** ⇒ 它们是同一条连音线（唱到末尾跳回开头）。
   * 于是：
   *   · 记下这类"候选孤立 `)`"（每个 `|:` 之后只认**第一个**），暂不报警；
   *   · 谱末再把这个候选取用掉：配成 `wrap: true` 的对（`start` = 末行的音 > `end` = 首行的音），
   *     被用掉的那条 `)` 与那个 `(` **都不再报警**，其余照旧报。
   */
  const strayCloses: { note: number; line: number; col: number; usedForWrap?: boolean; cand?: WrapCand }[] = []
  /** `|:` 之后遇到的**第一个 `)`** —— "跳回"那条连音线的闭合（可能同时闭合了反复前那条 `(`） */
  const wrapCands: WrapCand[] = []
  /** 见过 `|:`（反复起点）⇒ 下一个孤立 `)` 可能是"跳回"的闭合 */
  let repeatStartArmed = false
  /** 最近一次见到 `:|` / `:|:` 时的小节线序号（配对时判定"那个 `(` 之后确实有反复终点"） */
  let lastRepeatEndBarSeq = -1
  /** 「跳房子首音」音符索引集合 + 各自起始小节线的小节线序号（配对时判定跨线） */
  const voltaFirstNotes = new Set<number>()
  const voltaFirstBarSeq = new Map<number, number>()
  let expectVoltaFirst = false
  let pendingVoltaBarSeq = -1

  /**
   * `adj651`：登记一条连音线；若它「跨过房子起始小节线且终点是该房子首音」，
   * 就记下它的起点，供后续房子里的孤立 `)` 延续。
   */
  /**
   * adj984（**用户 2026-10-18 追问**）：「这 4 个告警的连音线都是正确的，你是怎么计算为 3 层的？」
   *
   * 查下来：`depth` 原先取"**打开那一刻**栈里还有几个 `(`"。而"等跳回闭合"的那条 `(`（`(6/[5/]` 之后
   * 就是 `:|`）会一直挂在栈上直到谱末 ⇒ **后面所有括号的深度都被它顶高一层**，于是两层的写法被算成三层 ✗。
   *
   * 正确口径：深度 = **实际有多少条别的连音线把这一段包在里面**（包含关系），与"谁先挂在栈上"无关。
   * 所以这里先照常收对（深度是临时值），**谱末统一按包含关系重算**，再据此判"超过两层"。
   *   · `houseTie`（跳房子延续线）与 `wrap`（反复跳回）是"接续"类，**不参与包含计数、深度固定 0**；
   *   · 退化对（`start === end`，如 `(3)`）不是一层，不计。
   */
  const anchorsOf = new Map<SlurPair, { line: number; col: number }>()
  const pushSlurPair = (
    start: number,
    end: number,
    depth: number,
    tuplet: boolean,
    plus: number,
    minus: number,
    openBarSeq: number,
    houseTie = false,
    anchor?: { line: number; col: number },
  ): void => {
    const p: SlurPair = { start, end, depth, tuplet, plus, minus, houseTie }
    pairs.push(p)
    if (anchor) anchorsOf.set(p, anchor)
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
        // adj983：反复起点 / 终点（`|:` 之后那个孤立 `)` 可能是"跳回"的闭合）
        if (t.type === '|:' || t.type === ':|:') repeatStartArmed = true
        if (t.type === ':|' || t.type === ':|:') lastRepeatEndBarSeq = barSeq
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
          /**
           * adj983：**`|:` 之后遇到的第一个 `)`** 记成"跳回闭合"的候选 —— **哪怕它同时也闭合了
           * 反复之前那条 `(`**（用户补全原谱后的真实情形：前奏行末尾的 `(6/[5/]` 与反复体末尾的
           * `(6/[5/]` **共用** `|: 6/)` 这个 `)`；线性配对只会给前者，后者就被判"没闭合"、
           * 还会把后面 2. 房子里的括号顶到第三层、连带不画）。
           */
          const at983 = colOf(music.raw, t)
          let cand983: WrapCand | undefined
          if (repeatStartArmed) {
            cand983 = { note: lastNote, line: music.pos.line, col: at983, barSeq }
            wrapCands.push(cand983)
            repeatStartArmed = false
          }
          // `adj55`：先进后出 —— pop 最近打开的开括号；栈跨行保留（未闭合延续到后续行）
          const s = sQueue.pop()
          if (s && s.start !== -1 && lastNote >= s.start) {
            if (s.start === lastNote && sQueue.length > 0) {
              // `adj321` 连接点：终止栈内前一个未闭合连音（prev）于 X，并以 X 为起点重开新连音
              const prev = sQueue.pop()
              if (prev && prev.start !== -1 && lastNote >= prev.start) {
                pushSlurPair(prev.start, lastNote, prev.depth, prev.tuplet, prev.plus, prev.minus, prev.barSeq, false, {
                  line: prev.line,
                  col: prev.col,
                })
              }
              // 新连音从 X 起，层级取被终止的 prev（断开嵌套，保持可渲染）
              sQueue.push({ ...s, start: lastNote, depth: prev ? prev.depth : s.depth })
            } else {
              /**
               * 普通配对。**一律先收下**，深度留给谱末按"包含关系"重算（adj984）——
               * 以前在这里按"打开时的栈长度"判 `depth < 2`，会被那条"等跳回闭合、整段挂在栈上"的
               * `(` 顶高一层，把两层的正确写法误判成三层。
               */
              pushSlurPair(s.start, lastNote, s.depth, s.tuplet, s.plus, s.minus, s.barSeq, false, {
                line: s.line,
                col: s.col,
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
             *
             * adj983：**先不报** —— 它可能正是"反复跳回"那条连音线的闭合（见 `wrapCands`），
             * 留到谱末统一判定：被用掉的不报，没被用掉的才报。
             */
            strayCloses.push({ note: lastNote, line: music.pos.line, col: at983, cand: cand983 })
          }
        }
      }
    }
  }

  /**
   * adj983（**用户 2026-10-18 实报**）：把"**反复跳回**"那条配掉。
   *
   * 用户补全原谱后的真实情形：`|:` 后面那个 `)` **同时**是两条 `(` 的闭合 ——
   *   · 反复之前那行末尾的 `(6/[5/]`（线性配对已经用它闭合了 ✓ 画成相邻两行的跨行线）；
   *   · 反复体末尾的 `(6/[5/]`（跳到 `|:` 之后接着唱 ⇒ 也用这个 `)`）。
   * 所以这里**允许候选已被线性配对用过**（`cand.used` 只表示"这条候选已被某条 wrap 用掉"，
   * 不表示"这个 `)` 已经闭过别人"）。
   *
   * 判据（宁可少配、不可错配）：
   *  ① 有未用的 `|:` 之后 `)` 候选；
   *  ② 栈里还有未闭合、已锚到音符、且**在候选之后**（`barSeq >= cand.barSeq`）的 `(` —— 取最内层；
   *  ③ 那个 `(` 之后**确实有反复终点**（`lastRepeatEndBarSeq >= open.barSeq`）——
   *     没有真的跳回去，这种写法仍然算错、要报。
   */
  for (const cand of wrapCands) {
    if (cand.used) continue
    let openIdx = -1
    for (let k = sQueue.length - 1; k >= 0; k--) {
      const s = sQueue[k]
      if (s.start !== -1 && s.barSeq >= cand.barSeq && s.barSeq <= lastRepeatEndBarSeq) {
        openIdx = k
        break
      }
    }
    if (openIdx < 0) continue
    const open = sQueue[openIdx]
    sQueue.splice(openIdx, 1)
    cand.used = true
    // 这个 `)` 若本来被判"多余"，也不许再报 —— 它就是这条跳回连音线的闭合
    for (const c of strayCloses) if (c.cand === cand) c.usedForWrap = true
    pairs.push({
      start: open.start,
      end: cand.note,
      depth: 0,
      tuplet: open.tuplet,
      plus: open.plus,
      minus: open.minus,
      wrap: true,
    })
  }

  /**
   * adj984：**按"实际包含关系"重算深度**，并据此判"超过两层"。
   *
   * 深度 = 有多少条**别的**连音线把这一段包在里面（`q.start <= p.start && p.end <= q.end` 且区间不同）：
   *  · 两层写法（外 `(` 包住内 `(`）⇒ 内层深度 1 ⇒ 都画 ✓（用户那 4 条就属于这种）；
   *  · 三层写法（真的三层套娃）⇒ 最内深度 2 ⇒ 不画并告警；
   *  · `houseTie`（跳房子延续线）/ `wrap`（反复跳回）是接续类 ⇒ **不参与计数、深度固定 0**；
   *  · 退化对（`start === end`）不包任何人、也不被算作"层"。
   *
   * 为什么不能按"打开时的栈长度"：那条"等跳回闭合"的 `(` 会一直挂在栈上，
   * 把**后面所有**括号的深度都顶高一层（用户追问「你是怎么计算为 3 层的？」的答案）。
   */
  {
    const kept: SlurPair[] = []
    for (const p of pairs) {
      if (p.houseTie || p.wrap) {
        p.depth = 0
        kept.push(p)
        continue
      }
      if (p.start === p.end) {
        p.depth = 0
        kept.push(p)
        continue
      }
      let d = 0
      for (const q of pairs) {
        if (q === p || q.houseTie || q.wrap) continue
        if (q.start === q.end) continue
        if (q.start <= p.start && p.end <= q.end && !(q.start === p.start && q.end === p.end)) d++
      }
      p.depth = d
      if (d < 2) {
        kept.push(p)
      } else {
        const a = anchorsOf.get(p)
        problems.push({
          line: a?.line ?? 0,
          col: a?.col ?? 0,
          message: '这条连音线嵌套超过两层（最多两层），没有绘制',
          severity: 'warning',
          hint: HINT_DEPTH,
        })
      }
    }
    pairs.length = 0
    pairs.push(...kept)
  }

  /** 没被"跳回"用掉的孤立 `)` 才报（adj973 ⓑ 的口径不变） */
  for (const c of strayCloses) {
    if (c.usedForWrap) continue
    problems.push({
      line: c.line,
      col: c.col,
      message: '多了一个 `)`（前面没有未闭合的 `(`）',
      severity: 'warning',
      hint: HINT_STRAY_CLOSE,
    })
  }

  /**
   * adj973（ⓑ，用户要求）：**谱面结束时仍有未闭合的 `(`** ⇒ 这些线一条也画不出来，此前静默。
   * 只报"括号后面**有音符**"的那些（`start !== -1`）：`()` 里没音符属于退化写法，没有线可画，不吵人。
   * adj983：被"反复跳回"配掉的那个 `(` 已出栈，不会在这里再报。
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
