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
import { matchSegmentHead, findSegmentEnd, matchInterludeHead } from '../parser/tokenizer'

export function formatJps(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  /**
   * adj747（**幂等修复**）：源若已以换行结尾，`split('\n')` 会在末尾多出一个空串 ⇒
   * 旧实现 `join('\n') + '\n'` 会把它保留下来**再补一个换行** ⇒ 每格式化一次文件就多一行空行
   * （`formatJps(formatJps(x)) !== formatJps(x)`）。
   *
   * 这正是"按应用规范格式化"要守住的性质：**规范格式必须是格式化器的不动点** ——
   * 插件里那三个入口（文件视图按钮 / 命令 / 代码块工具条）都靠"改没改"来决定要不要写盘，
   * 不幂等会让"格式化"这个动作变成"每次都改文件"。
   * 顺带把末尾空行统一成**恰好一个换行**（空源返回空串，不制造只有一个换行的文件）。
   */
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return ''
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
 * 渐强/渐弱与连音线收尾的**规范位置**（用户 2026-11-26 口径）。
 *
 * 1. `<`/`>` 的起点是“紧邻其前的有声元素”。若它被写在增时线/附点之后
 *    （`6---<`），解析器仍把起点算回音符 6，但随后 `!` 会紧跟在 `<` 后，
 *    `endOn` 被误判成 `note` ⇒ 起止落在同一音符、时值为零、出告警。
 *    因此把起点记号移到该音符的增时线/附点**之前**：`6---<` → `6<---`。
 * 2. 抬升量 `+` 是渐强/渐弱记号自身的一部分，**必须跟着记号一起搬**
 *    （`6--- <+++` → `6<+++ ---`），只搬 `<` 会把 `+` 留在原处、语义就变了。
 *    记号后紧接 `-`（增时线）时补一个空格，与主循环“变号断行”一致。
 * 3. `!` 的终点由**紧邻其前的非空字符**决定：写在 `-`/`.` 后是增时线/附点右缘。
 *    所以 `!` 必须紧贴前一个元素，`6<+++ --- !` → `6<+++ ---!`；**绝不能**把它挪到 `<` 后。
 * 4. 连音线收尾时，末音的增时线/附点属于该音“之后”的时值；规范写法把它们放在
 *    `)` **外面**（`7-- )` → `7) --`），与预览/演奏口径一致。
 *
 * 只处理引号外、`@乐器@` 外的正文；歌词/注释里的同样字符保持原样。
 */
export function normalizeHairpinsAndSlurEnds(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; ) {
    const c = text[i]
    // 引号/乐器名整段原样（内部可能含 < > ! ) 等字符）
    if (c === '"' || c === '@') {
      const close = text.indexOf(c, i + 1)
      if (close >= 0) {
        out += text.slice(i, close + 1)
        i = close + 1
        continue
      }
      out += text.slice(i)
      break
    }
    if (c === '!' || c === '<' || c === '>' || c === ')') {
      /**
       * 记号紧贴前一个元素：先吃掉源码里多余的空格。
       * 只在前一个非空字符确实像“音符块尾部”时才吃——否则 `Q: <++---`
       * 会把行头后的空格也吞掉（变成 `Q:<++ ---`），行头就坏了。
       */
      const trimmed = out.replace(/[ \t]+$/, '')
      if (/[\d\-.)\]'#,$=]$/.test(trimmed)) out = trimmed
      if (c === '!') {
        out += c
        i++
        continue
      }
      /**
       * 修正（用户 2026-11-26 指正，见 docs/ERRORS-LOG.md E-2026-615）：`<+++`/`>++` 里的 `+`
       * 是这个记号本身的抬升量，必须**跟着记号一起搬**；只搬 `<` 会把 `+` 留在原地，
       * 变成 “6<---+++”（语义已变：`+` 成了游离记号）。这里先把紧跟记号的 `+` 串整段吃掉。
       */
      let plus = ''
      if (c === '<' || c === '>') {
        let j = i + 1
        while (j < text.length && text[j] === '+') j++
        plus = text.slice(i + 1, j)
        i = j
      } else {
        i++
      }
      /**
       * 紧邻前面的“末时值元素”是增时线/附点时才需要挪：
       * `6---<` → `6<---`；`)` 则相反，把增时线/附点移到右括号外。
       * 正则避开小节线/括号/其它记号，防止把连音线前缀 `(-` 误当音符增时线。
       * `7[6/]---` 这种带倚音方括号的音符块，整个 `7[6/]` 都算 m[1]，记号落在 `]` 之后，
       * 不会插进方括号里面。
       */
      const m = /([0-9][^\s|()<>!+-]*?)([-.]+)$/.exec(out)
      if (!m) {
        out += c + plus
      } else if (c === ')') {
        // 连音线收尾：增时线/附点属于该音“之后”的时值，移到 `)` 外面；
        // 与音符块/小节线一样按“独立块”用空格隔开（`7-- )` → `7) --`）。
        out = out.slice(0, m.index) + m[1] + ')' + ' ' + m[2]
      } else {
        // 渐强/渐弱起点：记号（连同 `+` 抬升量）紧跟起音元素，增时线/附点留在记号后面。
        // `+` 后面紧接 `-` 时补一个空格，与主循环“变号断行”的写法一致（`6<+++ ---`）。
        const gap = plus !== '' && m[2][0] === '-' ? ' ' : ''
        out = out.slice(0, m.index) + m[1] + c + plus + gap + m[2]
      }
      continue
    }
    out += c
    i++
  }
  return out
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
    } else if (note === '{' && matchInterludeHead(trimmed, x)) {
      /**
       * adj1118：**间奏标记 `{jz N}` 整段原样保留**（`{jz 16}` 里的 `16` 不是两个音符）。
       *
       * 这是本功能最容易踩的坑：通用规则"数字前补空格"会把 `{jz 16}` 拆成 `{jz 1 6 }`，
       * 而 `autoFormat` 默认开着 ⇒ 用户打完就被改坏。这里把整段当一个块（与 `@乐器@` 同理），
       * 并把内部空格归一成 `{jz 16}`（规范化后仍是它自己 ⇒ 幂等成立）。
       */
      const jz = matchInterludeHead(trimmed, x)
      if (jz) {
        ensureSpace()
        out.push(`{jz ${jz.beats}}`)
        x = jz.end - 1
        lastNote = ''
        continue
      }
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
  return normalizeHairpinsAndSlurEnds(out.join(''))
}
