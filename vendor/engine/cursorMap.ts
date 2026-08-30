/**
 * engine/cursorMap.ts — 编辑器 ↔ 谱面位置双向映射（M3 核心）
 *
 * 契约：layout 为每个音符输出稳定 id（"page_voice_group_index"），
 * 并渲染为 SVG 的 data-notepos（音符）/ data-cipos（歌词）属性。
 * 本模块在编辑器端复现该编号规则，实现：
 *  - codePosToNoteId：编辑器光标位置 → 音符 id（仅 Q 行内联动）
 *  - noteIdToCodePos：音符 id → 编辑器字符位置（点击谱面跳转）
 */
import { tokenizeMusicLine } from './parser/tokenizer'
import type { ScoreLayout } from './types'

const Q_RE = /^Q(\d*)(?:"[^"]*")?\s*:(.*)$/
const ID_RE = /^(\d+)_(\d+)_(\d+)_(\d+)$/

export interface NoteIdParts {
  page: number
  voice: number
  group: number
  index: number
}

export function parseNoteId(id: string): NoteIdParts | null {
  const m = ID_RE.exec(id)
  if (!m) return null
  return { page: +m[1], voice: +m[2], group: +m[3], index: +m[4] }
}

const isNoteToken = (t: { kind: string }) =>
  t.kind === 'note' || t.kind === 'rest' || t.kind === 'rhythm'

/** 编辑器光标位置（0-based）→ notepos id；非 Q 行或超出范围返回 null
 *  @param indexToPage 布局时生成的「全局音符 index → 物理页 page」（自动分页一致）；缺省回退 [fenye] 计 */
export function codePosToNoteId(code: string, pos: number, indexToPage?: Map<number, number>): string | null {
  const lines = code.replace(/\r\n/g, '\n').split('\n')

  // 定位光标所在行
  let lineIdx = -1
  let lineStart = 0
  for (let i = 0; i < lines.length; i++) {
    if (pos <= lineStart + lines[i].length) {
      lineIdx = i
      break
    }
    lineStart += lines[i].length + 1
  }
  if (lineIdx === -1) return null

  let page = 0
  let group = -1
  let noteCounter = 0
  let target: string | null = null

  for (let i = 0; i <= lineIdx; i++) {
    const raw = lines[i]
    const leading = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed === '[fenye]') {
      page++
      continue
    }
    const m = Q_RE.exec(trimmed)
    if (!m) continue
    group++
    const content = m[2] ?? ''
    const { tokens } = tokenizeMusicLine(content, { line: i + 1, col: 0 })
    const noteTokens = tokens.filter(isNoteToken)

    if (i === lineIdx) {
      // 光标所在 Q 行：定位「光标处/光标前最近音符」（块级，adj230）
      // 原逻辑用 >= break → 光标落在音符块末尾空隙时取到右侧下一个音符
      // （「点第一个高亮第二个」的 ±1 错位）；改为取光标处或紧邻左侧的音符，
      // 点击块内任意位置（含块末空隙/行尾）都对应本块
      const col = pos - lineStart - leading // 相对 trimmed 行的列
      const headLen = trimmed.length - content.length
      let local = 0
      let last = 0
      for (const t of tokens) {
        if (t.pos + headLen > col) break
        if (isNoteToken(t)) {
          last = local
          local++
        }
      }
      if (noteTokens.length === 0) return null
      const idx = Math.min(last, noteTokens.length - 1)
      const voice = m[1] === '' ? 1 : Number(m[1])
      const gIdx = noteCounter + idx
      // adj291：page 用实际布局的物理页（自动分页也一致），与音符 id 的 page 对齐；无映射回退 [fenye] 计
      const pg = indexToPage?.get(gIdx) ?? page
      target = `${pg}_${voice}_${group}_${gIdx}`
      break
    }
    noteCounter += noteTokens.length
  }
  return target
}

/** notepos id → 编辑器字符位置；找不到返回 null */
export function noteIdToCodePos(code: string, id: string): number | null {
  const parts = parseNoteId(id)
  if (!parts) return null

  const lines = code.replace(/\r\n/g, '\n').split('\n')
  let page = 0
  let noteCounter = 0
  let lineStart = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const leading = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed === '[fenye]') {
      page++
      lineStart += raw.length + 1
      continue
    }
    const m = Q_RE.exec(trimmed)
    if (!m) {
      lineStart += raw.length + 1
      continue
    }
    const content = m[2] ?? ''
    const { tokens } = tokenizeMusicLine(content, { line: i + 1, col: 0 })
    const noteTokens = tokens.filter(isNoteToken)

    if (noteCounter <= parts.index && parts.index < noteCounter + noteTokens.length) {
      // 目标音符在本行
      const local = parts.index - noteCounter
      const t = noteTokens[local]
      const headLen = trimmed.length - content.length
      return lineStart + leading + headLen + t.pos
    }
    noteCounter += noteTokens.length
    lineStart += raw.length + 1
  }
  return null
}

/** 布局后的「全局音符 index → 物理页 page」映射（自动分页也一致）——供光标联动对齐音符 id 的 page */
export function buildIndexToPage(layout: ScoreLayout): Map<number, number> {
  const m = new Map<number, number>()
  for (const pg of layout.pages) for (const n of pg.notes) m.set(n.id.index, pg.index)
  return m
}
