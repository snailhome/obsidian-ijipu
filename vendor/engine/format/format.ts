/**
 * engine/format/format.ts — 自动格式化（.jps 排版）
 *
 * 规则实现自 JPS 脚本规范（`docs/JPS-SPEC.md`，独立推导、不依赖任何第三方实现）：
 *  - 仅格式化 Q 行（曲行）；其余行原样保留；
 *  - 引号内（歌词引用/注释）与跳房子 [] 内不做空格处理；
 *  - 数字前补空格（除非前一位已是 Q/C/空格/(/y）；
 *  - "(" 前补空格；"|" 前补空格；":" 在 "|" 前补空格；"{" "}" 前补空格；
 *  - adj293：描述头属性与内容之间保留且只保留一个空格（如 Y:  钢琴 / Y:钢琴 → Y: 钢琴）。
 */
export function formatJps(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  return lines.map(formatLine).join('\n') + '\n'
}

export function formatLine(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return raw
  // adj293：描述头属性与内容之间保留且只保留一个空格（Y:钢琴 / Y:  钢琴 → Y: 钢琴）
  const headerM = /^((?:V|B|Z|D|P|J|Y|S)\s*:)\s*(.*)$/.exec(trimmed)
  if (headerM) return `${headerM[1]} ${headerM[2]}`
  if (!/^Q(\d*(?:"[^"]*")?\s*:)/.test(trimmed)) return raw

  const out: string[] = []
  let inQuote = false
  let inVolta = false
  let lastNote = ''
  let last = ''

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
    // adj337：@...@ 乐器指定包裹段——整段原样保留（不补空格/不重排），确保 () 等特殊字符不被拆分
    if (note === '@') {
      const endAt = trimmed.indexOf('@', x + 1)
      if (endAt !== -1 && endAt > x + 1) {
        out.push(trimmed.slice(x, endAt + 1))
        lastNote = ''
        last = trimmed[endAt]
        x = endAt
        continue
      }
      out.push(note)
      continue
    }
    // 普通区空白压缩为单空格（adj23：块间恰好一个空格；引号/跳房子内原样）
    if (note === ' ') {
      if (out[out.length - 1] !== ' ') out.push(' ')
      continue
    }
    // 补空格：仅当输出尾部还没有空格时补一个（adj25：避免 | ( : 等补空格造成双空格）
    const ensureSpace = () => {
      if (out[out.length - 1] !== ' ') out.push(' ')
    }
    // adj165：数字前补空格——排除 Q/C 行头、空格、(、以及 (y 连音组（仅 upNote='y' 且其前为 '('）
    // 注：&sby/&cy 等修饰符也以 y 结尾，但修饰符后紧跟的音符必须分隔（1&sby2 → 1&sby 2）
    const isTupletY = upNote === 'y' && trimmed[x - 2] === '('
    const noSpaceBefore =
      upNote === 'Q' || upNote === 'C' || upNote === ' ' || upNote === '(' || isTupletY
    // adj295：独立括号 &zkh/&ykh 与前一元素分隔（@风琴&zkh → @风琴 &zkh）；其余 & 修饰符仍贴音符
    if (note === '&') {
      let kk = x + 1
      while (kk < trimmed.length && /[a-zA-Z]/.test(trimmed[kk])) kk++
      const code = trimmed.slice(x + 1, kk)
      if (code === 'zkh' || code === 'ykh') ensureSpace()
      out.push(note)
      continue
    }
    // adj294：增时线 "-" 依附前面的音符/修饰符（连接），不纳入"需补空格"——否则 1&hx-2 被隔成 1&hx - 2
    if ('0123456789'.includes(note) && !noSpaceBefore) {
      ensureSpace()
      out.push(note)
    } else if (note === '(' && upNote !== '(') {
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
    last = note
  }
  void last
  return out.join('')
}
