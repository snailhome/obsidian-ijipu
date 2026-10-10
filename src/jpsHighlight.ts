/**
 * jpsHighlight.ts — 在 Obsidian 编辑器里给 `.jps` 源码上**应用那套高亮**
 *
 * 用户要求（原话）：「如果可以，给手机端的源码使用**应用里的源码高亮方案**，而不是 Markdown 的高亮方案」。
 *
 * 为什么能做到"同一套方案"：着色**规则**已经抽到引擎（`@ijipu/engine` 的
 * `tokenizeJpsLine`，应用编辑器渲染 HTML、这里渲染 CM6 decoration，口径只有一份）；
 * 颜色也用应用的色值（`src/styles/theme.css` 的 `--jp-hl-*`，深/浅两套，见 `styles.css`）。
 *
 * 生效范围：**只对"借宿主编辑器打开的 `.jps` 页签"**（页签上有 `ijipu-plain-source` 标记，
 * 由 `fileView.openInObsidianEditor` 打上）⇒ 绝不改动画记里 markdown 的高亮。
 *
 * 实现要点：
 *  · `ViewPlugin` + `Decoration.mark`，只为**可视区域**建 decoration（长文件不吃性能）；
 *  · `RangeSetBuilder` 要求按位置递增 —— 逐行遍历天然有序；
 *  · 行文（`line.text`）与 token 文本长度严格一致（`tokenizeJpsLine` 覆盖整行，含前导空白）
 *    ⇒ 偏移量即"行首偏移 + token 起点"，不会错位。
 */
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import { parseJps, tokenizeJpsLine } from '@ijipu/engine'

/** 类别 → CSS 类（颜色在 `styles.css`，深/浅主题各一套，取自应用 `--jp-hl-*`） */
const CLASS_OF: Record<string, string> = {
  'line-header': 'ijipu-jps-line-header',
  note: 'ijipu-jps-note',
  barline: 'ijipu-jps-barline',
  lyric: 'ijipu-jps-lyric',
  comment: 'ijipu-jps-comment',
  pagebreak: 'ijipu-jps-pagebreak',
  decoration: 'ijipu-jps-decoration',
}

const MARKS: Record<string, Decoration> = {}
for (const [cls, name] of Object.entries(CLASS_OF)) MARKS[cls] = Decoration.mark({ class: name })

/** 本编辑器是不是"我们借宿主打开的 .jps 页签" */
function isOurJpsLeaf(view: EditorView): boolean {
  return view.dom.closest('.workspace-leaf.ijipu-plain-source') !== null
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  if (!isOurJpsLeaf(view)) return builder.finish()
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      // adj754：**行级**错误/告警底色（与应用编辑器同一套观感：红底 / 橙底）
      const problem = problemsOf(view).get(line.number)
      if (problem === 'error') builder.add(line.from, line.from, LINE_ERROR)
      else if (problem === 'warning') builder.add(line.from, line.from, LINE_WARN)
      let at = line.from
      for (const token of tokenizeJpsLine(line.text)) {
        const mark = MARKS[token.cls]
        if (mark) builder.add(at, at + token.text.length, mark)
        at += token.text.length
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * adj754（用户问：「如果源码有 jps 语法错误，源码是否有错误显示机制？」）：
 * **现在有了** —— 解析引擎本来就产出带 `line`/`col`/`message`/`hint` 的问题列表
 * （`parseJps(...).errors`，应用编辑器据此画红底/橙底与"正确写法"提示），
 * 这里把它接到宿主编器的 `.jps` 源码上：
 *  · 行级：错误整行淡红底、告警淡橙底（CSS `.ijipu-jps-error-line` / `.ijipu-jps-warn-line`）；
 *  · 悬停：显示 `message` + `hint`（"正确写法"），与应用的错误提示同一份文案。
 *
 * 解析整篇文档，故**防抖 250ms**（打字时不必每键都解析；行号表按内容缓存）。
 */
type ProblemLevel = 'error' | 'warning'
const LINE_ERROR = Decoration.line({ class: 'ijipu-jps-error-line' })
const LINE_WARN = Decoration.line({ class: 'ijipu-jps-warn-line' })

const problemCache = new WeakMap<EditorView, { doc: string; map: Map<number, ProblemLevel>; hint: Map<number, string> }>()

function problemsOf(view: EditorView): Map<number, ProblemLevel> {
  const doc = view.state.doc.toString()
  const hit = problemCache.get(view)
  if (hit && hit.doc === doc) return hit.map
  const map = new Map<number, ProblemLevel>()
  const hint = new Map<number, string>()
  if (isOurJpsLeaf(view)) {
    try {
      for (const e of parseJps(doc).errors ?? []) {
        const level: ProblemLevel = e.severity === 'warning' ? 'warning' : 'error'
        // 同一行既有错误又有告警时，**错误优先**（与应用一致）
        if (level === 'error' || !map.has(e.line)) map.set(e.line, level)
        const text = e.hint ? `${e.message}\n正确写法：${e.hint}` : e.message
        const prev = hint.get(e.line)
        hint.set(e.line, prev ? `${prev}\n${text}` : text)
      }
    } catch {
      /* 解析器抛错时不做错误标注（不能因为标注把编辑器弄坏） */
    }
  }
  problemCache.set(view, { doc, map, hint })
  return map
}

function hintOf(view: EditorView, line: number): string | undefined {
  problemsOf(view)
  return problemCache.get(view)?.hint.get(line)
}

/** 悬停某行 → 显示该行的问题（message + 正确写法） */
const problemTooltip = hoverTooltip((view, pos) => {
  if (!isOurJpsLeaf(view)) return null
  const line = view.state.doc.lineAt(pos)
  const text = hintOf(view, line.number)
  if (!text) return null
  return {
    pos: line.from,
    create: () => {
      const dom = createDiv({ cls: 'ijipu-jps-problem-tip' })
      for (const [i, part] of text.split('\n').entries()) {
        dom.createDiv({ cls: i === 0 ? 'ijipu-jps-problem-msg' : 'ijipu-jps-problem-hint', text: part })
      }
      return { dom }
    },
  }
})

export const jpsHighlightExtension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      private timer = 0
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }
      update(update: ViewUpdate): void {
        // 文档变化 / 可视区滚动都要重算；页签标记变化（切进切出）由 docChanged 或后续 update 覆盖
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view)
        }
        // adj754：文档变了 ⇒ 250ms 后再解析一次（错误行底色 / 悬停提示）
        if (update.docChanged) {
          if (this.timer !== 0) window.clearTimeout(this.timer)
          this.timer = window.setTimeout(() => {
            this.timer = 0
            this.decorations = buildDecorations(update.view)
          }, 250)
        }
      }
      destroy(): void {
        if (this.timer !== 0) window.clearTimeout(this.timer)
      }
    },
    { decorations: (v) => v.decorations },
  ),
  problemTooltip,
]
