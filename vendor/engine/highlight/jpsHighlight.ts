/**
 * engine/highlight/jpsHighlight.ts — `.jps` 源码的**分词规则**（纯逻辑，零 DOM）
 *
 * 存在的理由（用户 2026-10 要求）：「给手机端的源码使用**应用里的源码高亮方案**，而不是 Markdown 的高亮」。
 * 应用的高亮器 `ijipu/src/editor/highlight.ts` 输出的是 HTML 字符串，而 Obsidian 的编辑器是
 * **CodeMirror 6**（只吃"按区间打标记"的 decoration）⇒ 两端没法共用同一份 HTML 渲染。
 * 但**规则**是可以共用的 —— 于是把"哪个字符属于哪一类"抽到这里（纯函数），
 * 应用继续用它渲染 HTML，插件用它生成 CM6 decoration ⇒ **着色口径只有一处定义**，
 * 不会出现"应用一种颜色、插件另一种颜色"的漂移。
 *
 * 规则**逐字**照搬应用 `highlight.ts`（`highlightMusicContent` / `highlightLyricContent` /
 * `highlightCode` 的行级判定），只是把 `<span>` 换成了 `{cls, text}`：
 *  - 行头命令（Q/C/B/Z/D/P/J/V/Y/S + 声部编号）→ `line-header`；
 *  - 音符数字 / 增时线 `-` → `note`；小节线 `|`、`:``[` `]`、连音括号 `(`…`)`、`{` `}` → `barline`；
 *  - 歌词（含 `"…"` 引号内）→ `lyric`；注释行 `#…` → `comment`；`[fenye]` → `pagebreak`；
 *  - `&` 装饰编码、`<` `>` `!` → `decoration`；其余 → `plain`。
 *  - adj629h：歌词行里的 `{tp … }` 替谱段**段内按曲部规则着色**，段头 `{tp` 与 `}` 用行头色。
 */
import { matchSegmentHead, findSegmentEnd } from '../parser/tokenizer'

/** 与 parser 的 `HEADER_KEYS` 一致（V/B/Z/D/P/J/Y/S + Q/C） */
const HEADER_KEYS = 'QCBZDPJVYS'

/** 行头命令匹配（`^[A-Z][0-9]*("…")?\s*:`）——应用 `highlightCode` 用的同一套 */
const HEADER_RE = /^([A-Z])(\d*)(?:"[^"]*")?\s*:/

/** 分词类别（渲染方各自映射到自己的样式：应用是 `hl-*` 类，插件是 CM6 decoration） */
export type JpsTokenClass =
  | 'line-header'
  | 'note'
  | 'barline'
  | 'lyric'
  | 'comment'
  | 'pagebreak'
  | 'decoration'
  | 'plain'

export type JpsToken = { cls: JpsTokenClass; text: string }

/** 行头命令（已 trim 的行）：命中返回行头文本长度与命令字母，否则 null */
export function jpsHeaderOf(trimmed: string): { key: string; headLen: number } | null {
  const m = HEADER_RE.exec(trimmed)
  if (!m || !HEADER_KEYS.includes(m[1])) return null
  return { key: m[1], headLen: m[0].length }
}

/** 把字符按类别合并成 token（相邻同类合并 —— 与应用"同色连续段合成一个 span"等价） */
function collect(pairs: { cls: JpsTokenClass; text: string }[]): JpsToken[] {
  const out: JpsToken[] = []
  for (const p of pairs) {
    if (p.text === '') continue
    const last = out[out.length - 1]
    if (last && last.cls === p.cls) last.text += p.text
    else out.push({ cls: p.cls, text: p.text })
  }
  return out
}

/**
 * 曲行内容（`Q:` 之后的文本）的分词。
 * 规则与应用的 `highlightMusicContent` 一一对应（含 adj395 的 `(` + 抬降/`y` 前缀、adj460 的 `@…@` 段等）。
 */
export function tokenizeJpsMusic(content: string): JpsToken[] {
  const parts: { cls: JpsTokenClass; text: string }[] = []
  let i = 0
  let inQuote = false
  while (i < content.length) {
    const c = content[i]
    if (c === '"') {
      inQuote = !inQuote
      parts.push({ cls: 'lyric', text: c })
      i++
      continue
    }
    if (inQuote) {
      parts.push({ cls: 'lyric', text: c })
      i++
      continue
    }
    // adj337：`@…@` 乐器指定包裹段整段按普通文本（应用原本也走 `push(null, …)` ⇒ plain）
    if (c === '@') {
      const endAt = content.indexOf('@', i + 1)
      if (endAt > i + 1) {
        parts.push({ cls: 'plain', text: content.slice(i, endAt + 1) })
        i = endAt + 1
        continue
      }
      parts.push({ cls: 'plain', text: c })
      i++
      continue
    }
    if ('0123456789'.includes(c) || c === '-') {
      parts.push({ cls: 'note', text: c })
    } else if (c === '|' || c === ':' || c === '[' || c === ']') {
      parts.push({ cls: 'barline', text: c })
    } else if (c === '&') {
      // 装饰编码：`&` 后连续字母数字
      let j = i + 1
      while (j < content.length && /[a-zA-Z0-9]/.test(content[j])) j++
      parts.push({ cls: 'decoration', text: content.slice(i, j) })
      i = j
      continue
    } else if (c === '<' || c === '>' || c === '!') {
      parts.push({ cls: 'decoration', text: c })
    } else if (c === '(') {
      // adj395：`(` 连同其后的 `+`/`-`/`y` 前缀一起（否则 `(y` 的 y 落成普通色）
      let j = i + 1
      while (j < content.length && (content[j] === '+' || content[j] === '-' || content[j] === 'y' || content[j] === 'Y')) j++
      parts.push({ cls: 'barline', text: content.slice(i, j) })
      i = j
      continue
    } else if (c === ')' || c === '{' || c === '}') {
      parts.push({ cls: 'barline', text: c })
    } else {
      parts.push({ cls: 'plain', text: c })
    }
    i++
  }
  return collect(parts)
}

/**
 * 歌词行内容（`C:` 之后的文本）的分词：歌词文字为 `lyric`，
 * 其中的 `{tp … }` 替谱段**段内**按曲部规则着色（adj629h），段头与 `}` 用 `line-header`。
 */
export function tokenizeJpsLyric(content: string): JpsToken[] {
  const parts: { cls: JpsTokenClass; text: string }[] = []
  let i = 0
  while (i < content.length) {
    const at = content.indexOf('{', i)
    if (at < 0 || matchSegmentHead(content, at) !== 'tp') break
    let k = at + 3
    while (k < content.length && (content[k] === ' ' || content[k] === '\t')) k++
    const end = findSegmentEnd(content, k)
    if (end < 0) break
    parts.push({ cls: 'lyric', text: content.slice(i, at) })
    parts.push({ cls: 'line-header', text: content.slice(at, k) }) // `{tp` + 其后的空白
    for (const t of tokenizeJpsMusic(content.slice(k, end))) parts.push(t) // 段内 = 曲部着色
    parts.push({ cls: 'line-header', text: content.slice(end, end + 1) }) // `}`
    i = end + 1
  }
  parts.push({ cls: 'lyric', text: content.slice(i) })
  return collect(parts)
}

/**
 * **整行**分词（插件用）：覆盖该行**全部**字符（含前导空白）——
 * CodeMirror 的 decoration 需要精确区间，不能像应用那样"只画 trim 后的部分"。
 */
export function tokenizeJpsLine(raw: string): JpsToken[] {
  const trimmed = raw.trim()
  if (trimmed === '') return raw === '' ? [] : [{ cls: 'plain', text: raw }]
  if (trimmed.startsWith('#')) return [{ cls: 'comment', text: raw }]
  if (trimmed === '[fenye]') return [{ cls: 'pagebreak', text: raw }]

  const head = jpsHeaderOf(trimmed)
  if (!head) return [{ cls: 'plain', text: raw }]

  const lead = raw.length - trimmed.length
  const headText = trimmed.slice(0, head.headLen)
  const rest = trimmed.slice(head.headLen)
  const out: { cls: JpsTokenClass; text: string }[] = []
  if (lead > 0) out.push({ cls: 'plain', text: raw.slice(0, lead) })
  out.push({ cls: 'line-header', text: headText })
  if (head.key === 'Q') for (const t of tokenizeJpsMusic(rest)) out.push(t)
  else if (head.key === 'C') for (const t of tokenizeJpsLyric(rest)) out.push(t)
  else out.push({ cls: 'plain', text: rest })
  return collect(out)
}
