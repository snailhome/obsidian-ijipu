/**
 * engine/parser/tokenizer.ts — Q 行（曲行）token 化
 *
 * 将一行音符文本（如 "1 2 3. 4/ |: [ 5 6 ] :|"）解析为 MusicToken[]。
 * 语法依据 .jps V1.0 手册：音符/休止符/节奏符、高低音点、变音（后置 # $ =）、
 * 时值线、附点、装饰符号（& 编码）、渐强渐弱（< > !）、连音线（( ... ) 带空格）、
 * 小节线与反复记号（| || |: :| :|: |/ |*）、跳房子（[] [/ [+）、
 * 虚音符（(1) 括号紧贴数字，adj23）、倚音（1[65] 前 / 1[h65] 后，adj23）。
 * 块间空格规则（adj23）：音符块与音符块、音符块与小节线块之间恰好一个空格。
 */
import type { BarlineMark, BarlineType, GracenoteNote, MusicToken, SourcePos } from '../types'
import { err } from './errors'
import type { ParseError } from '../types'

/**
 * 解析一行曲谱内容（不含 "Q..:" 行头）。
 * @param content 行内容
 * @param pos 行位置（用于错误定位）
 * @param opts.inSegment adj427：当前调用是否为 `{bz/dsb}` 段内的递归调用；为 true 时
 *   段内再遇到 `{bz/dsb` 会报"嵌套"错，段内遇到 `}` 会报"段内不应有 `}`"错。
 */

/**
 * 从小节线引号备注中识别"临时转调"指令 `d:<key>` 或单用 `d:`。
 *
 * 与 `parseKey` 同一调式口径：`<key>` 形如 `C` / `1=D` / `#F` / `Eb` / `bB` 等，
 * 也接受简写 `D` / `F#` / `Eb`（直接传调名）。`d:` 单用 = 恢复描述头 `D:` 的全局调号（"清回"）。
 *
 * 备注里写其它文本（不是 `d:` 开头）→ 一律当成普通注释，**不被本函数消费**。
 *
 * @returns `{ rest, targetKey?, clear? }`：`rest` 是把 `d:...` 前缀剥掉后的剩余文本（用作显示注释）
 *   ；`targetKey` 仅在 `<key>` 合法时返回（半音偏移）；`clear` 仅在 `d:` 单用时为 true。
 */
function parseKeyChange(comment: string): {
  rest: string
  targetKey?: number
  clear?: boolean
  keyText?: string
  plus?: number
  minus?: number
} {
  // 不以 `d:` 开头 → 与本功能无关，原样返回
  if (!/^d:/.test(comment)) return { rest: comment }
  // 截掉 `d:` 前缀，剩下 `1=D强音` / `D` / `Eb` / `F#` / ``（单用）
  let s = comment.slice(2)
  if (s === '') {
    // 单用 `d:` ⇒ 恢复描述头调号
    return { rest: '', clear: true }
  }
  // 允许简谱习惯的 `1=D`（级数 `1=` 只是书写习惯，调名是 `D`；等号两侧可有空格）
  const eq = /^\d+\s*=\s*/.exec(s)
  if (eq) s = s.slice(eq[0].length)
  // 调号紧贴 `d:`（可带 `1=`）之后；调号之后允许继续写普通注释文字（"d:1=D强音" 的"强音"要照常显示）。
  // **音名必须大写**——与描述头 `D:` 同一口径（`D: C` / `D: $B` 都要求大写字母）；
  // 若放宽到小写，"d:abc" 这种普通备注会被误读成"a♭ + 备注 c"。
  const km = /^([#$b]?[A-G][#$b]?)/.exec(s)
  if (!km) return { rest: comment }
  const keyText = km[1]
  const targetKey = parseKeyString(keyText)
  if (targetKey === null) return { rest: comment }
  let rest = s.slice(km[0].length)
  // adj627b（用户要求）：紧跟调名的 `+` / `-` ⇒ 抬升 / 降低**转调记号的显示高度**
  // （与音符注释 `1"注"+`（adj392）同一套记法：每级 NOTE_COMMENT_RAISE px，`+` 向上）
  let plus = 0
  let minus = 0
  while (rest.startsWith('+')) {
    plus++
    rest = rest.slice(1)
  }
  while (rest.startsWith('-')) {
    minus++
    rest = rest.slice(1)
  }
  return { rest, targetKey, keyText, ...(plus ? { plus } : {}), ...(minus ? { minus } : {}) }
}

/** 与 `parseKey` 同一正则（**音名大写**），但只验证并返回根音半音；不合法返回 null（不兜 0，区分"未给"与"非 C"） */
function parseKeyString(s: string): number | null {
  const m = /^([#$b]?)([A-G])([#$b]?)$/.exec(s.trim())
  if (!m) return null
  const semis: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const acc = m[1] || m[3]
  return semis[m[2]] + (acc === '#' ? 1 : acc === '$' || acc === 'b' ? -1 : 0)
}

/**
 * 把一段小节线引号备注写进 token：识别 `d:` 转调指令，其余文本作为显示注释。
 * 单独抽出来是因为**未闭合引号**那条分支也要走同一套（否则 `|"d:1=D` 会丢掉指令）。
 */
function applyKeyChange(
  t: Extract<MusicToken, { kind: 'barline' }>,
  rawNote: string,
): void {
  const parsed = parseKeyChange(rawNote)
  if (parsed.targetKey !== undefined || parsed.clear) {
    // adj627b：`keyText` 保留用户写法（`Ab` 不能显示成 `#G`）；`plus`/`minus` 是转调记号的抬升/降低级数
    t.keyChange = {
      ...(parsed.targetKey !== undefined ? { targetKey: parsed.targetKey } : {}),
      ...(parsed.clear ? { clear: true } : {}),
      ...(parsed.keyText !== undefined ? { keyText: parsed.keyText } : {}),
      ...(parsed.plus ? { plus: parsed.plus } : {}),
      ...(parsed.minus ? { minus: parsed.minus } : {}),
    }
  }
  // 剥掉 `d:` 前缀后的剩余文本才是"给人看的注释"；空则不写 comment
  if (parsed.rest !== '') t.comment = parsed.rest
}

export function tokenizeMusicLine(
  content: string,
  pos: SourcePos,
  opts: { inSegment?: SegmentKind } = {},
): { tokens: MusicToken[]; errors: ParseError[] } {
  const tokens: MusicToken[] = []
  const errors: ParseError[] = []
  let i = 0
  const n = content.length
  const rawAt = (start: number, end: number) => content.slice(start, end)

  // adj393：渐强/渐弱配对的辅助查询（`<`/`>` 后到 `!` 之前为区间；`!` 必须有同一行内的起点）
  /** 行内最后一条渐强/渐弱起点 token 的下标；没有返回 -1 */
  const lastHairpinStart = (): number => {
    for (let k = tokens.length - 1; k >= 0; k--) {
      const t = tokens[k]
      if (t.kind === 'decoration' && (t.dynamics === 'crescendo' || t.dynamics === 'decrescendo')) return k
      if (t.kind === 'decoration' && t.dynamics === 'end') return -1 // 已被 `!` 收尾，之前的起点不算
    }
    return -1
  }
  /** 行内是否存在「已开始但未用 `!` 结束」的渐强/渐弱 */
  const pendingHairpin = (): boolean => {
    for (let k = tokens.length - 1; k >= 0; k--) {
      const t = tokens[k]
      if (t.kind === 'decoration' && t.dynamics === 'end') return false
      if (t.kind === 'decoration' && (t.dynamics === 'crescendo' || t.dynamics === 'decrescendo')) return true
    }
    return false
  }

  // ---- 块间空格提示（adj23）：空格仅用于格式化，缺空格合法；多空格提示规范为单空格 ----
  /** adj394：常用「正确写法」提示文案（与 docs/JPS-SPEC.md 对应条目一致） */
  const HINT_SPACE = '块与块之间用**恰好一个空格**分隔，如 `1 2 3 | 4 5 6 |`（空格只影响格式，不影响解析）'
  const HINT_QUOTE = '引号要成对闭合，如 `1"渐强" 2`；注释里的空格用 `_` 表示（`1"渐强_稍快"`）'
  const HINT_HAIRPIN_OPEN = '一个渐强/渐弱要先用 `!` 结束，再写下一个记号，如 `1 < 2 3 ! 4 > 5 6 !`'
  const HINT_HAIRPIN_MATCH = '`!` 必须与**同一行内**的 `<`/`>` 配对（渐强/渐弱不跨行），如 `1 2 3 < 4 5 6 !`'
  const HINT_HAIRPIN_SPAN =
    '起止之间至少要有音符：`1 2 3 < 4 ! 5`；`!` 也可写在该音符的增时线/附点之后，如 `1 2 3 < 4- ! 5`、`1 2 3 < 4. ! 5`'
  const HINT_AMP = '`&` 后要跟修饰符编码（字母），如 `&tr` 颤音、`&mp` 力度、`&tu` 吐音；独立标记 `&zkh`/`&ykh`/`&hx` 两侧各留一个空格'
  const HINT_GRACE = '倚音用 `[` `]` 紧贴音符成对书写，括号内只允许高低音点 `\'` `,`、变音 `#` `$` `=`、减时线 `/`：前倚音 `1[65]`、后倚音 `1[h6/5]`'
  const HINT_SLUR_ATTACHED =
    '连音线 `(` 与音符之间**应有空格**（与虚音符 `(1)` 区分）；`(` 后的 `+`/`-` 是**连音线的高度级数**（`(+` 抬升、`(-` 降低，每级 2px），**不是**前一个音符的增时线——要给音符增时请写在音符旁，如 `1- (- 2 3)`'
  // adj427：临时段提示文案（adj629：加 `{tp}` 替谱——它只写在歌词行里）
  const HINT_SEGMENT_HEAD = '临时段必须以 `{bz`（临时伴奏）或 `{dsb`（临时多声部）开头，且 `bz`/`dsb` 后要留一个空格，如 `{bz 1 2 3}`'
  const HINT_SEGMENT_CLOSE = '临时段要成对闭合：`{bz … }` / `{dsb … }`，如 `3 4 | {bz 1 2 3 4} 5 6 |`'
  const HINT_SEGMENT_NEST = '临时段**不支持嵌套**；请先 `}` 关闭外层段，再开新段'
  const HINT_SEGMENT_STRAY = '`}` 只能用于关闭 `{bz` / `{dsb` / `{tp` 临时段，不能单独出现'
  const HINT_TP_IN_LYRIC =
    '替谱段 `{tp … }` 写在**歌词行**里（`C:` = 第 1 遍、`C2:` = 第 2 遍……），段内写"这一遍不同"的那几个音；如 `C2: … 借 {tp 4/ 3// 6,/ 6,// 1/ .1 -} 一 丝 懵 懂 …`'
  const HINT_VOLTA = '跳房子 `[` 要紧跟在小节线之后；行首跳房子请先用隐藏小节线 `|/`，如 `|/ ["1." 1 2 3 |]`'
  const HINT_SYMBOL =
    '音符用 `1`-`7`、休止 `0`（隐藏休止 `8`）、节奏 `9`；时值 `-` `/` `.`；高低音点 `\'` `,`；变音 `#` `$` `=`；装饰 `&编码`（如 `&tr`）；注释 `"文字"`；小节线与反复 `|` `||` `|:` `:|`；跳房子 `[` `]`；渐强渐弱 `<` `>` `!`（详见「语法速查」）'
  let lastBlockEnd = -1 // 上一个音符块/小节线块的结束字符偏移
  let lastBlockCounts = false // 上一个块是否参与校验
  const checkBlockGap = (blockStart: number) => {
    if (!lastBlockCounts) return
    const between = content.slice(lastBlockEnd, blockStart)
    if (/^ +$/.test(between) && between.length > 1) {
      errors.push(
        err('音符块与小节线块之间应只有一个空格', {
          line: pos.line,
          col: pos.col + blockStart,
        }, 'warning', HINT_SPACE),
      )
    }
  }
  const registerBlock = (start: number, end: number) => {
    checkBlockGap(start)
    lastBlockEnd = end
    lastBlockCounts = true
  }

  /** 解析 [ 后的跳房子修饰（adj26）：+ 抬高、- 降低（adj356）、/ 不封闭、引号注释（番号） */
  const parseVoltaMods = (start: number): { k: number; slash: boolean; plus: number; minus: number; comment?: string } => {
    let k = start
    let slash = false
    let plus = 0
    let minus = 0
    let comment: string | undefined
    while (k < n) {
      const ch = content[k]
      if (ch === '/') {
        slash = true
        k++
      } else if (ch === '+') {
        plus++
        k++
      } else if (ch === '-') {
        minus++
        k++
      } else if (ch === '"') {
        const close = content.indexOf('"', k + 1)
        if (close === -1) {
          comment = content.slice(k + 1)
          errors.push(err('引号注释未闭合', { line: pos.line, col: pos.col + k }, 'error', HINT_QUOTE))
          k = n
        } else {
          comment = content.slice(k + 1, close)
          k = close + 1
        }
      } else {
        break
      }
    }
    return { k, slash, plus, minus, comment }
  }

  // 收集一个 token 的公共后缀：变音/减时线/增时线/附点/高低音点/装饰/注释
  // （adj392：注释引号后的 + / - 归注释，故一并放进这份后缀基类型）
  type SuffixBase = {
    accidental: '#' | '$' | '=' | null
    augmentCount: number
    diminishCount: number
    dots: number
    octaveShift: number
    symbols: string[]
    comment?: string
    commentPlus?: number
    commentMinus?: number
  }
  const collectSuffix = (start: number, base: SuffixBase): number => {
    let j = start
    while (j < n) {
      const c = content[j]
      if (c === '#') {
        base.accidental = '#'; j++
      } else if (c === '$') {
        base.accidental = '$'; j++
      } else if (c === '=') {
        base.accidental = '='; j++
      } else if (c === '-') {
        base.augmentCount++; j++
      } else if (c === '/') {
        base.diminishCount++; j++
      } else if (c === '.') {
        base.dots++; j++
      } else if (c === "'") {
        base.octaveShift++; j++
      } else if (c === ',') {
        base.octaveShift--; j++
      } else if (c === '&') {
        // & 装饰编码：连续字母（adj109：允许尾部 +，如 &sby+ / &cy+）
        // adj220：不再收数字——&dy5/ 中 5 是下一音符起点（此前被吞进 dy5，
        // 3&dy5/&dy5/… 粘连成一个音符）；编码均为字母（tr/cy/dy/fine 等）
        // adj294：&zkh/&ykh 为独立括号标记——不收集为音符符号，停止收集留给主循环处理
        // adj375：&hx（呼吸记号）同理独立化——不再依附音符
        let k = j + 1
        while (k < n && /[a-zA-Z]/.test(content[k])) k++
        if (content[k] === '+') k++
        if (k > j + 1) {
          const code = content.slice(j + 1, k)
          if (code === 'zkh' || code === 'ykh' || code === 'hx') break
          base.symbols.push(code)
          j = k
        } else {
          break // 孤立 &，停止收集
        }
      } else if (c === '"') {
        // 注释：直到下一个引号；_ 代替空格（adj59：曲部空格仅为分隔，注释内空格用 _ 表示）
        const close = content.indexOf('"', j + 1)
        if (close === -1) {
          base.comment = content.slice(j + 1).replace(/_/g, ' ')
          errors.push(err('引号注释未闭合', { line: pos.line, col: pos.col + j }, 'error', HINT_QUOTE))
          j = n
        } else {
          base.comment = content.slice(j + 1, close).replace(/_/g, ' ')
          j = close + 1
          // adj392：**紧接**注释引号后的 + / - 用于抬升/降低注释文本（与跳房子 [+/[-、
          // 连音线 (+/(- 同一套记法与步长，每级 NOTE_COMMENT_RAISE=2px）。
          // 由此「注释后紧贴的 -」不再算增时线——增时线请写在注释之前（1-"注释"）或与注释间留空格。
          let cPlus = 0
          let cMinus = 0
          while (j < n && (content[j] === '+' || content[j] === '-')) {
            if (content[j] === '+') cPlus++
            else cMinus++
            j++
          }
          if (cPlus > 0) base.commentPlus = cPlus
          if (cMinus > 0) base.commentMinus = cMinus
        }
        // 注释不固定为块末：注释后的 & 等修饰符仍继续收集（对「修饰符在注释后」的写法健壮）；
        // 遇非法字符（数字等）由下方 else break 停止
      } else {
        break
      }
    }
    return j
  }

  while (i < n) {
    const c = content[i]

    // 空白跳过（空格仅用于格式化美观，不影响解析——`(` 修饰其后音符，可紧贴）
    if (c === ' ' || c === '\t') {
      i++
      continue
    }

    // adj427：临时段 `{bz … }`（临时伴奏）/ `{dsb … }`（临时多声部）/ `{tp … }`（adj629 替谱，仅歌词行）。
    // 段内 token 递归 tokenize 后挂在 open token 的 children 上；`}` 生成配对的 close token。
    // 段头边界校验见 matchSegmentHead（段头后必须是空白或 `}`）；段结束扫描见
    // findSegmentEnd（跳过引号内的 `}`）；段内**不嵌套**（段内再遇段头报"嵌套"错）。
    if (c === '{') {
      const segType = matchSegmentHead(content, i)
      if (segType) {
        // adj629：`{tp … }` 的"第几遍"由**歌词行序号**决定（见 types.ts 的 LyricVariant）——
        // 曲行里没有这个依据，写在曲行只能是笔误，直接报错并跳掉该段（不再往下走成"无遍次替谱层"）。
        if (segType === 'tp') {
          const tpEnd = findSegmentEnd(content, i + 1 + segType.length)
          errors.push(
            err('替谱段 "{tp … }" 只能写在歌词行（`C:` / `C2:` / `C3:` …）里', { line: pos.line, col: pos.col + i }, 'error', HINT_TP_IN_LYRIC),
          )
          i = tpEnd === -1 ? n : tpEnd + 1
          continue
        }
        // 嵌套限制：段内不能再开新段（递归调用时 opts.inSegment 已设置）
        if (opts.inSegment) {
          errors.push(
            err(
              '临时段 "{' + segType + '}" 不能嵌套在已有段内（已有 {' + opts.inSegment + '}）',
              { line: pos.line, col: pos.col + i },
              'error',
              HINT_SEGMENT_NEST,
            ),
          )
          i++ // 跳过 `{`，继续解析（不阻塞后续 token）
          continue
        }
        // 段内容起点：跳过 `{bz`/`{dsb` 后的空白
        let j = i + 1 + segType.length
        while (j < n && (content[j] === ' ' || content[j] === '\t')) j++
        const segStart = j
        const segEnd = findSegmentEnd(content, segStart)
        // 段头文本（`{bz` / `{dsb`）——作为 open token 的 raw，与 close 的 `}` 对称
        const headRaw = content.slice(i, i + 1 + segType.length)

        if (segEnd === -1) {
          // 未闭合：报错 + 兜底把段内剩余内容照常 tokenize（让其它错误一并暴露）
          errors.push(
            err(
              '临时段 "{' + segType + '}" 未找到结束 "}"',
              { line: pos.line, col: pos.col + i },
              'error',
              HINT_SEGMENT_CLOSE,
            ),
          )
          // 段内递归：位置基准带上 segStart（列号绝对化），token 位置再右移 segStart
          const innerRes = tokenizeMusicLine(content.slice(segStart), { line: pos.line, col: pos.col + segStart })
          errors.push(...innerRes.errors)
          tokens.push({
            kind: 'segment',
            type: segType,
            dir: 'open',
            pos: i,
            raw: headRaw,
            children: shiftTokenPos(innerRes.tokens, segStart),
          })
          i = n
          continue
        }

        // 递归 tokenize 段内内容：inSegment 让段内再遇 `{bz/dsb` 时报嵌套错；
        // 位置基准 col 加 segStart 使段内错误列号**绝对化**（相对整行内容）
        const innerRes = tokenizeMusicLine(content.slice(segStart, segEnd), { line: pos.line, col: pos.col + segStart }, { inSegment: segType })
        errors.push(...innerRes.errors)
        // open 段 token（含 children；children 的 pos 已右移 segStart）
        tokens.push({
          kind: 'segment',
          type: segType,
          dir: 'open',
          pos: i,
          raw: headRaw,
          children: shiftTokenPos(innerRes.tokens, segStart),
        })
        // close 段 token（`}`）
        tokens.push({
          kind: 'segment',
          type: segType,
          dir: 'close',
          pos: segEnd,
          raw: '}',
        })
        i = segEnd + 1
        continue
      }
      // `{` 后不是合法段头：报"无法识别"（`{bzzy` 这类会被 matchSegmentHead 正确挡下）
      errors.push(
        err(`无法识别的符号 "${c}"`, { line: pos.line, col: pos.col + i }, 'warning', HINT_SEGMENT_HEAD),
      )
      i++
      continue
    }

    // adj427：段外的 `}` —— 段内的 `}` 已被 findSegmentEnd 吃掉，独立出现的 `}` 是书写错误
    if (c === '}') {
      errors.push(
        err('多余的 "}"（没有对应的 "{bz" 或 "{dsb"）', { line: pos.line, col: pos.col + i }, 'warning', HINT_SEGMENT_STRAY),
      )
      i++
      continue
    }

    // 连音线/连音组：`(` 修饰其后音符（起点），`)` 结束；"(y"/"(Y" 前缀 = 平均连音组（均分时值，adj86 大小写不敏感）；
    // adj135："(+"/"(y+" 的 + 数量抬升连音线；adj136："(-"/"(y-" 的 - 数量下降连音线
    if (c === '(') {
      let j = i + 1
      let plus = 0
      let minus = 0
      let tuplet = false
      while (j < n) {
        if (content[j] === '+') {
          plus++
          j++
        } else if (content[j] === '-') {
          minus++
          j++
        } else if (!tuplet && content[j].toLowerCase() === 'y') {
          tuplet = true
          j++
        } else {
          break
        }
      }
      tokens.push({
        kind: 'slur',
        dir: 'open',
        pos: i,
        raw: content.slice(i, j),
        tuplet,
        plus: plus > 0 ? plus : undefined,
        minus: minus > 0 ? minus : undefined,
      })
      // adj394：`(` **紧贴**在音符块后（如 `1(- 2 3`）且带 `+`/`-` 时给出提示——
      // 此时 `-` 是**连音线的降低级数**，不是音符 1 的增时线；规范要求 `(` 与音符之间留空格
      // （与虚音符 `(1)` 区分），紧贴会让人误以为 `-` 在给前一个音符增时。
      if (plus + minus > 0 && i > 0 && /[0-9\-/.,'#$=]/.test(content[i - 1] ?? '')) {
        errors.push(
          err('连音线 "(" 紧贴在音符后且带 "＋/－" 时，符号属于连音线（不是前一个音符的增时线）', { line: pos.line, col: pos.col + i }, 'warning', HINT_SLUR_ATTACHED),
        )
      }
      i = j
      continue
    }
    if (c === ')') {
      tokens.push({ kind: 'slur', dir: 'close', pos: i, raw: ')' })
      i++
      continue
    }

    // 渐强渐弱
    if (c === '<' || c === '>') {
      let j = i + 1
      let plus = 0
      while (content[j] === '+') {
        plus++
        j++
      }
      const code = content.slice(i, j)
      // adj394（语法约定，**不报错**）：渐强/渐弱只有 `+` 抬升，没有 `-` 降低——`-` 在语法里
      // 始终是增时线，写在 `<`/`>` 后会计入前一个音符（如 `3<- 4` = 音符 3 增时一拍，
      // 而 `3<---!` 是"音符 3 增时 3 拍 + 渐强收在其末增时线右缘"的合法写法）。
      // 二者在源码上无法区分"想降低"还是"想增时"，因此这里**不能**发告警（否则误伤合法写法），
      // 只在 docs/JPS-SPEC.md、编辑器提示与「语法速查」里写明。
      // adj393：同一行内上一个渐强/渐弱还没用 "!" 结束就来了新记号——后写的会替换前一个（提示而非报错）
      if (pendingHairpin()) {
        errors.push(
          err('渐强/渐弱尚未用 "!" 结束就遇到新的记号（前一个将被替换）', { line: pos.line, col: pos.col + i }, 'warning', HINT_HAIRPIN_OPEN),
        )
      }
      tokens.push({
        kind: 'decoration',
        code,
        dynamics: c === '<' ? 'crescendo' : 'decrescendo',
        pos: i,
        raw: code,
      })
      i = j
      continue
    }
    if (c === '!') {
      // adj394：`!` 可结束于任意「有时值的元素」之后（音符/增时线 `-`/附点 `.`）——
      // 由紧邻其前的非空格字符判定停靠处，供 layout 决定终点取「数字槽中心」还是「该元素右缘」
      let k = i - 1
      while (k >= 0 && (content[k] === ' ' || content[k] === '\t')) k--
      const prevCh = k >= 0 ? content[k] : ''
      const endOn: 'note' | 'aug' | 'dot' = prevCh === '-' ? 'aug' : prevCh === '.' ? 'dot' : 'note'
      // adj393：`!` 找不到同一行内的起点（含起点写在上一行＝渐强/渐弱跨行），或起止之间没有音符
      // ——两种写法都会「什么都不显示」，此前完全静默；这里给出 warning 说明原因
      const openIdx = lastHairpinStart()
      if (openIdx < 0) {
        errors.push(
          err('"!" 缺少同一行内的起始记号 "<" 或 ">"（渐强/渐弱不能跨行）', { line: pos.line, col: pos.col + i }, 'warning', HINT_HAIRPIN_MATCH),
        )
      } else {
        // adj394：退化判定必须比较**起止锚点**，不能数「`<` 之后的音符」——
        // 起点音符写在 `<` **之前**（如 `3<---!`：起点=音符 3、终点=该音符末增时线右缘，合法且有宽度）。
        // 仅当 `!` 直接跟在音符后（endOn='note'）且与起点落在**同一音符**时才是零宽度退化写法。
        const notesBefore = (upto: number): number =>
          tokens.slice(0, upto).filter((t) => t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm').length
        const sameAnchorNote = endOn === 'note' && notesBefore(openIdx) === notesBefore(tokens.length)
        if (sameAnchorNote) {
          errors.push(
            err('渐强/渐弱起止之间没有音符（起止落在同一音符），不会渲染', { line: pos.line, col: pos.col + i }, 'warning', HINT_HAIRPIN_SPAN),
          )
        }
      }
      tokens.push({ kind: 'decoration', code: '!', dynamics: 'end', dynamicsEndOn: endOn, pos: i, raw: '!' })
      i++
      continue
    }

    // & 装饰编码（行内独立出现）
    if (c === '&') {
      let k = i + 1
      // adj220：只收字母（+ 可选尾部 +）——&dy5/ 中 5 是下一音符起点，不进编码
      while (k < n && /[a-zA-Z]/.test(content[k])) k++
      if (content[k] === '+') k++ // adj109：允许尾部 +（&sby+ 等）
      if (k > i + 1) {
        const code = content.slice(i + 1, k)
        // adj294：&zkh/&ykh 是独立括号标记（无时值元素）——插在源码位置，占宽，不影响音符
        // adj375：&hx 呼吸记号同样独立（可写在音符前或后：`&hx 6 5` / `6 &hx 5`）
        if (code === 'zkh') {
          tokens.push({ kind: 'bracket', code: 'zkh', dir: 'open', pos: i, raw: content.slice(i, k) })
          i = k
        } else if (code === 'ykh') {
          tokens.push({ kind: 'bracket', code: 'ykh', dir: 'close', pos: i, raw: content.slice(i, k) })
          i = k
        } else if (code === 'hx') {
          tokens.push({ kind: 'bracket', code: 'hx', dir: 'open', pos: i, raw: content.slice(i, k) })
          i = k
        } else {
          tokens.push({ kind: 'decoration', code, pos: i, raw: content.slice(i, k) })
          i = k
        }
      } else {
        // adj178：孤立 &（输入中未完成）降为 warning——避免预览在 error 时整页阻断、
        // 输入过程中在正确预览与错误提示间闪动（error 仅用于真正破坏结构的错误）
        errors.push(err(`孤立的 "&" 符号（输入中未完成？）`, { line: pos.line, col: pos.col + i }, 'warning', HINT_AMP))
        i++
      }
      continue
    }

    // adj301/adj337：@乐器名 / @@ 乐器切换指令；支持 `@库id:乐器名["显示名"]@` 包裹（legacy=false）
    if (c === '@') {
      if (content[i + 1] === '@') {
        // @@ → 切回默认乐器
        tokens.push({ kind: 'instrument', name: null, pos: i, raw: '@@' })
        i += 2
        continue
      }
      // 收集 @ 后内容：到空白/小节线/行尾（允许库前缀 `:`、括号 `()`、引号显示名）
      let k = i + 1
      while (k < n && content[k] !== ' ' && content[k] !== '\t' && content[k] !== '|' && content[k] !== '\n') k++
      // `@...@` 包裹：分隔符前若有尾 @ → 整段原样（new syntax）；否则旧写法（legacy=true，待告警）
      const tailAt = content.indexOf('@', i + 1)
      if (tailAt !== -1 && tailAt < k) {
        tokens.push({ kind: 'instrument', name: content.slice(i + 1, tailAt), pos: i, raw: content.slice(i, tailAt + 1), legacy: false })
        i = tailAt + 1
        continue
      }
      if (k > i + 1) {
        tokens.push({ kind: 'instrument', name: content.slice(i + 1, k), pos: i, raw: content.slice(i, k), legacy: true })
        i = k
        continue
      }
      // 孤立 @：略过（作为指令边界）
      i++
      continue
    }

    // 小节线（含反复记号与隐藏线）
    if (c === '|' || (c === ':' && content[i + 1] === '|')) {
      let j = i
      let type: string = ''
      if (content[j] === ':' && content[j + 1] === '|') {
        type = ':|'
        j += 2
        if (content[j] === ':') {
          type = ':|:'
          j++
        }
      } else {
        // 从 '|' 开始
        let bars = 0
        while (content[j] === '|') {
          bars++
          j++
        }
        if (content[j] === ':') {
          type = bars === 2 ? '||:' : '|:'
          j++
        } else if (content[j] === '/') {
          type = bars === 2 ? '||/' : '|/'
          j++
        } else if (content[j] === '*') {
          type = '|*'
          j++
        } else {
          type = bars === 2 ? '||' : '|'
        }
      }
      const t: Extract<MusicToken, { kind: 'barline' }> = {
        kind: 'barline',
        type: type as BarlineType,
        pos: i,
        raw: rawAt(i, j),
      }
      // 跳过小节线后的空格，再处理备注（引号）与跳房子标记；
      // 若无附加内容则回退到空格前（空格留给下一个块做单空格校验，adj23）
      const barEnd = j
      while (content[j] === ' ' || content[j] === '\t') j++
      // adj295：跳房子标记（[ ]）、小节线修饰符（&fine/&dc/&ds/&ty/&hs）、
      // 小节线引号备注（"p:2/4" 临时节拍 / 备注）可**任意顺序共存**——循环处理而非固定顺序；
      // 此前引号只在开头处理一次，& 在引号前时（|&hs"p:2/4"）引号被吞、临时节拍丢失
      {
        let guard = 0
        while (guard++ < 6) {
          if (content[j] === '[') {
            // 跳房子开始（adj26：修饰 = + 抬高 / 不封闭 / 引号注释）
            const mod = parseVoltaMods(j + 1)
            t.voltaStart = { open: true, slash: mod.slash, plus: mod.plus, minus: mod.minus, comment: mod.comment }
            t.raw = rawAt(i, mod.k)
            j = mod.k
          } else if (content[j] === ']') {
            // |] 跳房子结束；|]/ 开口结束（adj26）
            t.voltaEnd = true
            let k = j + 1
            if (content[k] === '/') {
              t.voltaEndSlash = true
              k++
            }
            t.raw = rawAt(i, k)
            j = k
          } else if (content[j] === '&') {
            // adj126：小节线修饰符（&fine 曲终 / &dc 从头反复 / &ds 大反复 / &ty 大跳跃 / &hs 花S）
            // adj206：同一小节线可叠加多个修饰符（如 |&ty&ds）——循环收集
            const marks: Extract<MusicToken, { kind: 'barline' }>['marks'] = []
            let k = j
            while (k < n && content[k] === '&') {
              let m = k + 1
              while (m < n && /[a-z]/i.test(content[m])) m++
              const code = content.slice(k + 1, m)
              if (code === 'fine' || code === 'dc' || code === 'ds' || code === 'ty' || code === 'hs') {
                marks.push(code as BarlineMark)
                k = m
              } else {
                break // 非小节线修饰符：停止收集（& 留给独立装饰处理）
              }
            }
            if (marks.length > 0) {
              t.marks = marks
              t.raw = rawAt(i, k)
              j = k
            } else {
              break // 非小节线修饰符：& 留给独立装饰处理
            }
          } else if (content[j] === '"') {
            // 小节线备注（引号，如 "p:2/4" 临时节拍 / 备注）——任意顺序下都能解析
            // adj627：备注里若写 `d:<调号>` / `d:`（临时转调 / 恢复原调），把它**拆出来**单独存，
            // 显示注释只留剥掉 `d:` 前缀后的剩余文本（否则谱面会同时显示指令与注释两截文字）
            const close = content.indexOf('"', j + 1)
            if (close === -1) {
              const rawNote = content.slice(j + 1)
              applyKeyChange(t, rawNote)
              errors.push(err('引号注释未闭合', { line: pos.line, col: pos.col + j }, 'error', HINT_QUOTE))
              j = n
            } else {
              const rawNote = content.slice(j + 1, close)
              applyKeyChange(t, rawNote)
              let k = close + 1
              // adj627b（用户要求）：**紧接转调注释引号后的 `+` / `-`** ⇒ 抬升 / 降低转调记号。
              // 位置与 adj392 的音符注释完全一致（`1"注"+` 的 `+` 也在闭合引号**之后**），
              // 每级 NOTE_COMMENT_RAISE px；写在引号里（`"d:D+"`）同样认，两处都写则叠加。
              // 只在**确实识别出转调**时吞掉这些符号，免得改变普通备注（`"p:2/4"+`）的既有行为。
              if (t.keyChange) {
                let plus = 0
                let minus = 0
                while (k < n && (content[k] === '+' || content[k] === '-')) {
                  if (content[k] === '+') plus++
                  else minus++
                  k++
                }
                if (plus > 0) t.keyChange.plus = (t.keyChange.plus ?? 0) + plus
                if (minus > 0) t.keyChange.minus = (t.keyChange.minus ?? 0) + minus
              }
              t.raw = rawAt(i, k)
              j = k
            }
          } else {
            break
          }
        }
        // 无任何附加（备注/跳房子/修饰符）：回退到空格前（空格留给下一个块，adj23）
        // adj627：`d:` 转调指令也算"有附加内容"——否则 `|"d:1=D"` 会被回退、指令丢失
        if (
          t.comment === undefined &&
          t.voltaStart === undefined &&
          t.voltaEnd === undefined &&
          t.marks === undefined &&
          t.keyChange === undefined
        ) {
          j = barEnd
        }
      }
      tokens.push(t)
      registerBlock(i, j)
      i = j
      continue
    }

    // 倚音（adj23）：音符后面的 [65] 前倚音 / [h65] 后倚音，是音符块的一部分；
    // 括号内音符可含高低音点 ' ,、变音 # $ =、减时线 /。
    // 与跳房子区分（adj23）：小节线后的 [ 是跳房子；音符后的 [ 是倚音
    if (c === '[') {
      const last = tokens[tokens.length - 1]
      if (last && last.kind === 'note') {
        let k = i + 1
        let after = false
        // adj86：[h 与 [H 等效（后倚音，大小写不敏感）
        if (content[k] !== undefined && content[k].toLowerCase() === 'h') {
          after = true
          k++
        }
        const notes: GracenoteNote[] = []
        let closed = false
        while (k < n) {
          const ch = content[k]
          if (ch === ']') {
            closed = true
            k++
            break
          }
          if (ch === ' ' || ch === '\t') {
            k++
            continue
          }
          if (ch >= '1' && ch <= '7') {
            const gn: GracenoteNote = {
              pitch: ch.charCodeAt(0) - 48 as 1 | 2 | 3 | 4 | 5 | 6 | 7,
              octaveShift: 0,
              accidental: null,
              diminishCount: 0,
            }
            k++
            while (k < n) {
              const sc = content[k]
              if (sc === "'") {
                gn.octaveShift++
                k++
              } else if (sc === ',') {
                gn.octaveShift--
                k++
              } else if (sc === '#') {
                gn.accidental = '#'
                k++
              } else if (sc === '$') {
                gn.accidental = '$'
                k++
              } else if (sc === '=') {
                gn.accidental = '='
                k++
              } else if (sc === '/') {
                gn.diminishCount++
                k++
              } else {
                break
              }
            }
            notes.push(gn)
          } else {
            errors.push(
              err('倚音内不支持的符号', { line: pos.line, col: pos.col + k }, 'warning', HINT_GRACE),
            )
            k++
          }
        }
        if (!closed) {
          errors.push(
            err('倚音括号 "]" 未闭合', { line: pos.line, col: pos.col + i }, 'warning', HINT_GRACE),
          )
        }
        last.gracenotes = { after, notes }
        last.raw += rawAt(i, k)
        lastBlockEnd = k // 音符块结束延展到倚音括号后
        // adj502：**括号之后**仍可继续写块内修饰（`3[2/]&sby`）——此前这里直接 `continue`，
        // 于是括号后的 `&sby` 被主循环当成独立 decoration，**不挂到音符的 `symbols` 上**
        // （演奏端按 `symbols` 判波音就会漏掉它）。这里只续接"依附音符"的 `&` 编码；
        // `&zkh/&ykh/&hx` 仍按既有规则独立化（break 留给主循环处理）。
        while (k < n && content[k] === '&') {
          let ek = k + 1
          while (ek < n && /[a-zA-Z]/.test(content[ek])) ek++
          if (content[ek] === '+') ek++
          if (ek <= k + 1) break
          const code = content.slice(k + 1, ek)
          if (code === 'zkh' || code === 'ykh' || code === 'hx') break
          last.symbols.push(code)
          last.raw += content.slice(k, ek)
          k = ek
          lastBlockEnd = k
        }
        i = k
        continue
      }
    }

    // 跳房子标记（独立出现，例如行首用 |/ 之后；或小节线引号备注后带空格；或 ] 后连续 [）
    if (c === '[') {
      const mod = parseVoltaMods(i + 1)
      const last = tokens[tokens.length - 1]
      if (last && last.kind === 'barline' && !last.voltaStart && !last.voltaEnd) {
        // 继承前一小节线（含番号备注），合并跳房子起点
        last.voltaStart = { open: true, slash: mod.slash, plus: mod.plus, minus: mod.minus, comment: mod.comment }
        last.raw += rawAt(i, mod.k)
        lastBlockEnd = mod.k // 小节线块结束延展
      } else if (last && last.kind === 'barline' && last.voltaEnd && !last.voltaStart) {
        // ] 后连续 [（如 |]["2"）：第二段起点与第一段结束**共用同一小节线**
        // （adj139：voltaEnd + voltaStart 共存于一根小节线，不另画竖线）
        last.voltaStart = { open: true, slash: mod.slash, plus: mod.plus, minus: mod.minus, comment: mod.comment }
        last.raw += rawAt(i, mod.k)
        lastBlockEnd = mod.k
      } else {
        if (!last || last.kind !== 'barline') {
          errors.push(
            err('跳房子 "[" 应写在小节线后（行首请用 |/ 或小节线，adj26）', {
              line: pos.line,
              col: pos.col + i,
            }, 'warning', HINT_VOLTA),
          )
        }
        // 其余（行首 [ 等无小节线可依）：纯跳房子起点（voltaOnly，不画小节线竖线）
        tokens.push({
          kind: 'barline',
          type: '|',
          voltaStart: { open: true, slash: mod.slash, plus: mod.plus, minus: mod.minus, comment: mod.comment },
          voltaOnly: true,
          pos: i,
          raw: rawAt(i, mod.k),
        })
        lastBlockEnd = mod.k
        lastBlockCounts = true
      }
      i = mod.k
      continue
    }
    if (c === ']') {
      // 跳房子结束；]/ 开口结束（adj26）
      let k = i + 1
      let slash = false
      if (content[k] === '/') {
        slash = true
        k++
      }
      tokens.push({
        kind: 'barline',
        type: '|',
        voltaEnd: true,
        voltaEndSlash: slash,
        pos: i,
        raw: rawAt(i, k),
      })
      registerBlock(i, k)
      i = k
      continue
    }

    // 音符 / 休止符 / 节奏音符
    if (c >= '1' && c <= '7') {
      const start = i
      const base: SuffixBase = {
        accidental: null,
        augmentCount: 0,
        diminishCount: 0,
        dots: 0,
        octaveShift: 0,
        symbols: [] as string[],
      }
      const end = collectSuffix(i + 1, base)
      const token: NoteToken_ = {
        kind: 'note',
        pitch: c.charCodeAt(0) - 48 as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        ...base,
        pos: i,
        raw: rawAt(start, end),
      }
      tokens.push(token)
      registerBlock(start, end)
      i = end
      continue
    }
    if (c === '0' || c === '8') {
      const start = i
      const base: SuffixBase = { accidental: null, augmentCount: 0, diminishCount: 0, dots: 0, octaveShift: 0, symbols: [] as string[] }
      const end = collectSuffix(i + 1, base)
      tokens.push({
        kind: 'rest',
        hidden: c === '8',
        augmentCount: base.augmentCount,
        diminishCount: base.diminishCount,
        dots: base.dots,
        symbols: base.symbols,
        // adj209：休止符注释（0"转调"）此前漏传——collectSuffix 已解析但未挂到 token
        comment: base.comment,
        // adj392：注释抬升/降低级数同样要挂到 token（否则解析了但渲染收不到）
        commentPlus: base.commentPlus,
        commentMinus: base.commentMinus,
        pos: i,
        raw: rawAt(start, end),
      })
      registerBlock(start, end)
      i = end
      continue
    }
    if (c === '9') {
      const start = i
      const base: SuffixBase = { accidental: null, augmentCount: 0, diminishCount: 0, dots: 0, octaveShift: 0, symbols: [] as string[] }
      const end = collectSuffix(i + 1, base)
      tokens.push({
        kind: 'rhythm',
        augmentCount: base.augmentCount,
        diminishCount: base.diminishCount,
        dots: base.dots,
        symbols: base.symbols,
        // adj209：节奏符注释（9"…"）同休止符，此前漏传
        comment: base.comment,
        // adj392：注释抬升/降低级数（同休止符）
        commentPlus: base.commentPlus,
        commentMinus: base.commentMinus,
        pos: i,
        raw: rawAt(start, end),
      })
      registerBlock(start, end)
      i = end
      continue
    }

    // 独立的增时线 "-"：原站自动格式化会把 "5-" 拆成 "5 -"，
    // 因此独立出现的 "-" 归入前面最近的音符/休止符/节奏符（adj37：
    // 可跳过连音线括号等中间符号，如 "1) -" 的 "-" 仍是对 1 的增时；不跨小节线）
    if (c === '-') {
      let found = false
      for (let k = tokens.length - 1; k >= 0; k--) {
        const last = tokens[k]
        if (last.kind === 'note' || last.kind === 'rest' || last.kind === 'rhythm') {
          last.augmentCount++
          last.raw += '-'
          // adj80：独立 "-" 后紧跟 "&编码"（如 "-&ykh"）应随音符收集，
          // 否则 "&ykh" 会落成独立 decoration（原 "6 - - -&ykh" 右括号丢失）
          // adj294：&zkh/&ykh 已是独立 bracket token——不随音符收集，留给主循环处理。
          // 仍归入增时线（augmentCount++ 已做），但 i 推进到 "&" 处，让主循环生成独立 bracket。
          if (content[i + 1] === '&') {
            let j = i + 2
            while (j < n && /[a-zA-Z0-9]/.test(content[j])) j++
            if (j > i + 2) {
              const bkCode = content.slice(i + 2, j)
              // adj375：&hx 同样独立化（"-&hx" → 增时线归音符 + 独立呼吸记号）
              if (bkCode === 'zkh' || bkCode === 'ykh' || bkCode === 'hx') {
                lastBlockEnd = i + 1
                found = true
                break // 留在 & 处，主循环处理 &ykh/&hx → 独立 bracket token
              }
              if (last.kind === 'note') last.symbols.push(bkCode)
              last.raw += content.slice(i + 1, j)
              i = j - 1 // 循环尾部 i++ 落到编码末
            }
          }
          lastBlockEnd = i + 1 // 音符块结束延展
          found = true
          break
        }
        if (last.kind === 'barline') break // 不跨小节线归入
      }
      if (found) {
        i++
        continue
      }
    }

    // 独立的附点 "."（adj396）：与独立增时线同理——原站自动格式化可能把 "3." 拆成 "3 ."，
    // 因此独立出现的 "." 归入前面最近的音符/休止符/节奏符（不跨小节线）。
    // 这样「附点后写后倚音」可与 "3 -[h5/]" 同样分开书写：`3 .[h5/]`（等价 `3.[h5/]`）。
    if (c === '.') {
      let foundDot = false
      for (let k = tokens.length - 1; k >= 0; k--) {
        const last = tokens[k]
        if (last.kind === 'note' || last.kind === 'rest' || last.kind === 'rhythm') {
          last.dots++
          last.raw += '.'
          lastBlockEnd = i + 1
          foundDot = true
          break
        }
        if (last.kind === 'barline') break // 不跨小节线归入
      }
      if (foundDot) {
        i++
        continue
      }
    }

    // 未知字符：保留原文作为装饰 token，并给出警告
    errors.push(err(`无法识别的符号 "${c}"`, { line: pos.line, col: pos.col + i }, 'warning', HINT_SYMBOL))
    tokens.push({ kind: 'decoration', code: c, pos: i, raw: c })
    i++
  }

  return { tokens, errors }
}

// 局部类型别名（避免在分支中手写冗长 Extract）
type NoteToken_ = Extract<MusicToken, { kind: 'note' }>

// ============================================================
// adj427：临时段（{bz … } / {dsb … }）辅助纯函数
// ============================================================

/** 临时段类型（adj629 加 `tp` 替谱——它只写在歌词行里，段头不带遍次号） */
export type SegmentKind = 'bz' | 'dsb' | 'tp'

/**
 * 判断 `content[at]` 处是否为临时段开头（`{bz` / `{dsb` / `{tp`），是则返回段类型。
 *
 * **必须做边界校验**：段头之后只能是空白或段结束 `}`——
 * 否则 `{bzzy 1 2}` 会被误当成 bz 段（`bzzy` 不是合法段头，应报"无法识别"）。
 */
export function matchSegmentHead(content: string, at: number): SegmentKind | null {
  if (content[at] !== '{') return null
  // dsb 放在 bz 之前无影响（互不为前缀），但顺序固定便于阅读
  for (const t of ['dsb', 'bz', 'tp'] as const) {
    if (!content.startsWith(t, at + 1)) continue
    const boundary = content[at + 1 + t.length]
    // 段头后必须是空白或直接结束 `}`（`{bz}` 空段）
    if (boundary === undefined || boundary === ' ' || boundary === '\t' || boundary === '}') return t
  }
  return null
}

/**
 * 从 `from` 起找段结束 `}` 的下标；找不到返回 -1。
 *
 * **跳过引号内内容**：`"…"` 注释里的 `}` 不算段结束
 * （如 `{bz 1"渐强}注" 2}` 的 `}` 在引号内）——与 tokenizer 其它部分对引号的处理保持一致。
 */
export function findSegmentEnd(content: string, from: number): number {
  let inQuote = false
  for (let k = from; k < content.length; k++) {
    const ch = content[k]
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (inQuote) continue
    if (ch === '}') return k
  }
  return -1
}

/**
 * 把段内 token 的 `pos` 整体右移 `offset`。
 *
 * 段内内容是**切片后递归 tokenize** 的，其 `pos` 是相对切片起点的偏移；
 * 而全行 token 的 `pos` 必须相对整行内容——不偏移会导致
 * ①错误列号偏小；②`cursorMap`（光标↔谱面联动）把光标映射到错误的位置。
 */
export function shiftTokenPos(tokens: MusicToken[], offset: number): MusicToken[] {
  return tokens.map((t) => {
    const shifted = { ...t, pos: t.pos + offset } as MusicToken
    // 段内不允许嵌套，理论上不会有 children；仍递归处理以防未来放开嵌套
    if (t.kind === 'segment' && t.children) {
      ;(shifted as Extract<MusicToken, { kind: 'segment' }>).children = shiftTokenPos(t.children, offset)
    }
    return shifted
  })
}
