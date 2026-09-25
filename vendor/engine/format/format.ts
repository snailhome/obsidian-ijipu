/**
 * engine/format/format.ts — 自动格式化（.jps 排版）
 *
 * 规则实现自 JPS 脚本规范（`docs/JPS-SPEC.md`，独立推导、不依赖任何第三方实现）：
 *  - 格式化 Q 行（曲行）；其余行原样保留——**例外**：歌词行（`C…:`）里的 `{tp … }` 替谱段
 *    也是曲部内容，按同样规则格式化（adj629h）；
 *  - 引号内（歌词引用/注释）与跳房子 [] 内不做空格处理；
 *  - 数字前补空格（除非前一位已是 Q/C/空格/(/y）；
 *  - "(" 前补空格；"|" 前补空格；":" 在 "|" 前补空格；"{" "}" 前补空格；
 *  - adj293：描述头属性与内容之间保留且只保留一个空格（如 Y:  钢琴 / Y:钢琴 → Y: 钢琴）。
 */
import { matchSegmentHead, findSegmentEnd } from '../parser/tokenizer'

export function formatJps(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  return lines.map(formatLine).join('\n') + '\n'
}

export function formatLine(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return raw
  // adj293：描述头属性与内容之间保留且只保留一个空格
  const headerM = /^((?:V|B|Z|D|P|J|Y|S)\s*:)\s*(.*)$/.exec(trimmed)
  if (headerM) return `${headerM[1]} ${headerM[2]}`
  /**
   * adj629h：**歌词行里的 `{tp … }` 替谱段也要按曲行规则格式化**（用户问）——
   * 歌词文字保持原样，只把段内那段"曲部内容"过一遍曲行规则（音符/小节线/连音线的空格）。
   */
  const cM = /^(C\d*\s*:)\s*(.*)$/.exec(trimmed)
  if (cM) return `${cM[1]} ${formatLyricBody(cM[2]).trim()}`.trimEnd()
  if (!/^Q(\d*(?:"[^"]*")?\s*:)/.test(trimmed)) return raw
  return formatMusicBody(trimmed)
}

/** adj629h：歌词行内容——歌词原样，`{tp … }` 段内按曲行规则格式化 */
function formatLyricBody(body: string): string {
  const out: string[] = []
  let i = 0
  while (i < body.length) {
    const at = body.indexOf('{', i)
    if (at < 0 || matchSegmentHead(body, at) !== 'tp') break
    let k = at + 3
    while (k < body.length && (body[k] === ' ' || body[k] === '\t')) k++
    const end = findSegmentEnd(body, k)
    if (end < 0) break
    const pre = body.slice(i, at)
    out.push(pre === '' ? '' : `${pre.replace(/[ \t]+$/, '')} `)
    out.push(`{tp ${formatMusicBody(body.slice(k, end)).trim()}}`)
    i = end + 1
    // 段后统一补一个空格（原文多个空格收敛成一个），行尾则由最后 trim 掉
    const lead = /^[ \t]*/.exec(body.slice(i))?.[0] ?? ''
    i += lead.length
    if (i < body.length) out.push(' ')
  }
  out.push(body.slice(i))
  return out.join('')
}

/**
 * adj629h：曲行内容的格式化（原 `formatLine` 的主循环，抽出来供歌词行里的替谱段复用）。
 * 规则见文件头；`Q:` 以外的行头**已去掉**，这里收到的就是纯曲部内容。
 */
export function formatMusicBody(trimmed: string): string {
  const out: string[] = []
  let inQuote = false
  let inVolta = false
  // adj460：连音线 "(" 后的 +/- 抬降量计数区间——与后续 augment 拆开（拆了语义就变了）
  let inSlurPrefix = false
  let lastNote = ''

  for (let x = 0; x < trimmed.length; x++) {
    const note = trimmed[x]
    const upNote = trimmed[x - 1]
    const nextNote = trimmed[x + 1]

    if (note === '"') {
      inQuote = !inQuote
      out.push(note)
      continue
    }
    if (inQuote) {
      out.push(note)
      continue
    }
    if (lastNote.indexOf('|') === -1) {
      if (note === '[') {
        inVolta = true
      } else if (note === ']') {
        inVolta = false
      }
      if (inVolta) {
        out.push(note)
        continue
      }
    }
    // adj337：@...@ 乐器指定包裹段——整段原样保留
    if (note === '@') {
      const endAt = trimmed.indexOf('@', x + 1)
      if (endAt !== -1 && endAt > x + 1) {
        out.push(trimmed.slice(x, endAt + 1))
        lastNote = ''
        x = endAt
        continue
      }
      out.push(note)
      continue
    }
    // 普通区空白压缩为单空格
    if (note === ' ') {
      if (out[out.length - 1] !== ' ') out.push(' ')
      continue
    }

    // adj460：连音线 "("——进入抬降量计数区间（直到第一个非 +/-/y 字符退出）
    if (note === '(') {
      if (upNote !== '(' && out[out.length - 1] !== ' ') out.push(' ') // 等价原 ensureSpace：与前一元素间补一个空格（已有则不补）
      inSlurPrefix = true
      out.push('(')
      continue
    }
    // adj460：在抬降量计数区间内——+/- 与 y 原样吞下（不补空、不拆号；都属于同一连音线）。
    // 不 break 也不补空：原 tokenizer 的 slur 前缀循环对 +/-/y 也不跳空格，我们照办以保持语义一致。
    if (inSlurPrefix && (note === '+' || note === '-' || note === 'y' || note === 'Y')) {
      out.push(note)
      continue
    }
    // 离开抬降量计数：第一个非 +/-/y 字符（音符、空格、小节线、) 等）按正常流程处理；
    // 落到下方 else 被原样推入。注意我们没有 reset 上一个符号（无 lastSign 变量），因为下游分支
    // 只看 `out[out.length-1]` 而不是记号——而 `+`/`-` 变号拆开的判断正是用 prevOut。
    if (inSlurPrefix) {
      inSlurPrefix = false
      // fall through 到下方的 if-else
    }

    // adj460：自由 +/-（augment 与元素间 +/-）——变号时断开为 "++++ ---"，
    // 让 + 归前元素的抬升、- 归后元素；同号续行不拆。
    // 判定仅看 prevOut：紧跟前一个 +/- 且符号相反 → 插一个空格。
    //   · `5"注释"++++---` → remark 的 +/- 全部消耗后到 `---` 时 prevOut=`+`、当前 `-`、相反 → 插空
    //   · `5++++---`      → 5 后 + 起步（prevOut=`5`、非 +/-）不插空；+++ 同号续；- 与 + 相反插空
    //   · `(+---`         → 上一分支（inSlurPrefix）原样吞，不插空——slur 抬降量是一个语义单元
    //   · `<++---`        → `<` 后 + 起步不插空；++ 续；- 变号插空
    //   · `]++++---`      → `]` 后 + 起步（prevOut=`]`，非 +/-）不插空；但 `]++` 是跳房子抬升量，不该拆——
    //     实际上 prevOut=`]`，不是 `+`/`-`，不触发本分支（条件要求 prevOut 是 `+`/`-`），所以不拆。
    //     真正"会拆"的危险点：紧接 `]` 的 +/- 是跳房子修饰，下一字符若是不同号就拆——但跳房子
    //     实际只有 +（不与 - 混用，adj394），所以现实里不会触发。保险起见用 `prevOut` 而不是看 lastSign。
    if (note === '+' || note === '-') {
      const prevOut = out[out.length - 1] ?? ''
      if ((prevOut === '+' && note === '-') || (prevOut === '-' && note === '+')) {
        if (out[out.length - 1] !== ' ') out.push(' ')
      }
      out.push(note)
      continue
    }

    // 补空格
    const ensureSpace = () => {
      if (out[out.length - 1] !== ' ') out.push(' ')
    }
    // adj165：数字前补空格——排除 Q/C 行头、空格、(、以及 (y 连音组
    // 注：&sby/&cy 等修饰符也以 y 结尾，但修饰符后紧跟的音符必须分隔（1&sby2 → 1&sby 2）
    const isTupletY = upNote === 'y' && trimmed[x - 2] === '('
    const noSpaceBefore =
      upNote === 'Q' || upNote === 'C' || upNote === ' ' || upNote === '(' || isTupletY
    // adj295：独立括号 &zkh/&ykh 与前一元素分隔（@风琴&zkh → @风琴 &zkh）；其余 & 修饰符仍贴音符
    // adj375：&hx（呼吸记号）同为独立标记——同样两侧分隔（6&hx 5 → 6 &hx 5；&hx6 5 → &hx 6 5）
    if (note === '&') {
      let kk = x + 1
      while (kk < trimmed.length && /[a-zA-Z]/.test(trimmed[kk])) kk++
      const code = trimmed.slice(x + 1, kk)
      if (code === 'zkh' || code === 'ykh' || code === 'hx') ensureSpace()
      out.push(note)
      continue
    }
    // adj294：增时线 "-" 依附前面的音符/修饰符（连接），不纳入"需补空格"——否则 1&hx-2 被隔成 1&hx - 2
    if ('0123456789'.includes(note) && !noSpaceBefore) {
      ensureSpace()
      out.push(note)
    } else if (note === '|' && upNote !== '|' && upNote !== ':') {
      ensureSpace()
      out.push(note)
    } else if (note === ':' && nextNote === '|') {
      ensureSpace()
      out.push(note)
    } else if (note === '{' || note === '}') {
      ensureSpace()
      out.push(note)
    } else {
      out.push(note)
    }
    if ('0123456789-|'.includes(note)) lastNote = note
  }
  return out.join('')
}
