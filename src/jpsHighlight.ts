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
import {
  Decoration,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import { jpsBlockMarks, parseJps, tokenizeJpsLine, type JpsBlockMark } from '@ijipu/engine'

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
  if (!isOurJpsLeaf(view)) return Decoration.none
  const problems = problemsOf(view)
  /**
   * ⚠ 这里**不能**用 `RangeSetBuilder`：错误块外框会与音符着色**重叠**（外框圈住若干 token），
   * 而构建器要求"有序且不重叠"。`Decoration.set(ranges, true)` 支持重叠并按位置排序，
   * 是 CM6 里"语法着色 + 搜索/诊断标注共存"的标准做法。
   */
  const ranges: { from: number; to: number; value: Decoration }[] = []
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      // adj754：**行级**错误/告警底色（与应用编辑器同一套观感：红底 / 橙底）
      const level = problems.byLine.get(line.number)
      if (level === 'error') ranges.push({ from: line.from, to: line.from, value: LINE_ERROR })
      else if (level === 'warning') ranges.push({ from: line.from, to: line.from, value: LINE_WARN })
      /**
       * adj757（用户要求：「错误信息显示提示等共性的功能都可以独立到引擎层面」，且"应用端也应同样处理"）：
       * **块级**外框区间由引擎给出（`jpsBlockMarks`）—— 与应用编辑器共用同一份"col → 音符块"换算，
       * 不再在插件里重复实现（此前那段本地 `blockSpanAt` 已删）。
       */
      for (const mark of problems.blockMarks) {
        if (mark.line !== line.number) continue
        ranges.push({
          from: line.from + mark.from,
          to: line.from + mark.to,
          value: mark.severity === 'error' ? BLOCK_ERROR : BLOCK_WARN,
        })
      }
      let at = line.from
      for (const token of tokenizeJpsLine(line.text)) {
        const mark = MARKS[token.cls]
        if (mark) ranges.push({ from: at, to: at + token.text.length, value: mark })
        at += token.text.length
      }
      pos = line.to + 1
    }
  }
  return Decoration.set(ranges, true)
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
/** adj756：**块级**外框（红/橙单线）—— 与应用 `hl-err-block` / `hl-warn-block` 同观感 */
const BLOCK_ERROR = Decoration.mark({ class: 'ijipu-jps-err-block' })
const BLOCK_WARN = Decoration.mark({ class: 'ijipu-jps-warn-block' })

/** 解析结果缓存：行级级别 + 逐行的"块级"错误列（`col` 与引擎同口径） */
type Problems = {
  doc: string
  byLine: Map<number, ProblemLevel>
  blockMarks: JpsBlockMark[]
  hint: Map<number, string>
}

const problemCache = new WeakMap<EditorView, Problems>()

function problemsOf(view: EditorView): Problems {
  const doc = view.state.doc.toString()
  const hit = problemCache.get(view)
  if (hit && hit.doc === doc) return hit
  const byLine = new Map<number, ProblemLevel>()
  const hint = new Map<number, string>()
  if (isOurJpsLeaf(view)) {
    try {
      for (const e of parseJps(doc).errors ?? []) {
        const level: ProblemLevel = e.severity === 'warning' ? 'warning' : 'error'
        // 同一行既有错误又有告警时，**错误优先**（与应用一致）
        if (level === 'error' || !byLine.has(e.line)) byLine.set(e.line, level)
        const text = e.hint ? `${e.message}\n正确写法：${e.hint}` : e.message
        const prev = hint.get(e.line)
        hint.set(e.line, prev ? `${prev}\n${text}` : text)
      }
    } catch {
      /* 解析器抛错时不做错误标注（不能因为标注把编辑器弄坏） */
    }
  }
  const out: Problems = { doc, byLine, blockMarks: jpsBlockMarks(doc, parseJps(doc).errors ?? []), hint }
  problemCache.set(view, out)
  return out
}

function hintOf(view: EditorView, line: number): string | undefined {
  return problemsOf(view).hint.get(line)
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
