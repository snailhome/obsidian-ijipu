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
import {
  groupBlocksByLine,
  highlightLineModel,
  jpsBlockMarks,
  parseJps,
  type JpsBlockMark,
} from '@ijipu/engine'
import { jpsBlockRanges, type JpsBlockRange } from './jpsBlocks'

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

/**
 * adj774（用户要求）：「**jps 代码块**应同时应用自动格式化、脚本颜色高亮和错误提示功能，
 * 与手机版 jps 文件的源码编辑模式一致」。
 *
 * 于是本编辑器要标注的范围分两种：
 *  · **整篇**（借宿主打开的 `.jps` 页签）：文档每一行都是 jps 源码，行号 1:1；
 *  · **围栏块**（markdown 笔记里的 ` ```jps `）：只标注围栏内的行，且**行号要偏移**
 *    （块的正文从文档第 `bodyStart` 行开始，而引擎解析正文时是从第 1 行数起）。
 * 两种情形共用同一份引擎模型（`tokenizeJpsLine` / `jpsBlockMarks` / `highlightLineModel`）。
 */
/**
 * adj774b：围栏扫描的**按内容缓存**。
 *
 * 需要它的原因（本轮自查发现的性能缺口）：`Decoration` 每次重建（敲键、滚动、选区变化）
 * 都要先回答"哪些行在 ```jps 块里"，而 `view.state.doc.toString()` + 扫描是 **O(文档)**；
 * 长笔记里"每次滚动都全篇转字符串 + 扫描"是纯浪费 —— 文档没变就该复用上一次的结果。
 * 口径与 `problemCache` 一致：**按文档内容**判失效（内容相同即命中，内容一变立刻重算）。
 */
const blockCache = new WeakMap<EditorView, { doc: string; blocks: JpsBlockRange[] }>()

function blocksOf(view: EditorView, doc: string): JpsBlockRange[] {
  const hit = blockCache.get(view)
  if (hit && hit.doc === doc) return hit.blocks
  const blocks = jpsBlockRanges(doc)
  blockCache.set(view, { doc, blocks })
  return blocks
}

type JpsScope =
  | { whole: true; blocks: [] }
  | { whole: false; blocks: JpsBlockRange[] }

function scopeOf(view: EditorView, doc?: string): JpsScope | null {
  if (isOurJpsLeaf(view)) return { whole: true, blocks: [] }
  // 不是我们的 .jps 页签 ⇒ 看这篇文档里有没有 ```jps 围栏（没有就完全不管，绝不碰 markdown）
  const text = doc ?? view.state.doc.toString()
  const blocks = blocksOf(view, text)
  if (blocks.length === 0) return null
  return { whole: false, blocks }
}

function buildDecorations(view: EditorView): DecorationSet {
  const scope = scopeOf(view)
  /**
   * adj774c（本轮自查发现的真 bug）：「token 颜色」的 CSS 原来**只**写在
   * `.workspace-leaf.ijipu-plain-source`（借宿主打开的 `.jps` 页签）之下 ⇒ **markdown 笔记里的
   * ```jps 代码块拿不到那些颜色**（页签上没有这个类），于是"代码块有 decoration 却没上色"。
   *
   * 修法：在**编辑器根节点**上打一个容器类，CSS 里让两套作用域并列生效（见 `styles.css`）。
   * 放在这里是因为本方法每次重建都会跑，能覆盖"文档里新增/删除 jps 块"的情形。
   */
  view.dom.classList.toggle('ijipu-has-jps-block', scope !== null && !scope.whole)
  if (!scope) return Decoration.none
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
      /**
       * adj774：先判"这一行要不要标注"——
       *  · 整篇（`.jps` 页签）⇒ 每一行都算；
       *  · markdown 笔记里的 ```jps 块 ⇒ **只有正文行**算（围栏行是 markdown 语法，交给宿主自己着色）。
       * 行号一律用**文档行号**（用户看到的"第 N 行"就是它），错误表也按文档行号建。
       */
      const inScope = scope.whole || scope.blocks.some((b) => line.number >= b.bodyStart && line.number <= b.bodyEnd)
      if (inScope) {
        /**
         * adj762（清单 B4）：token / 该行错误块 / 行级级别**一次由引擎模型给齐**
         * （`highlightLineModel`）—— 本文件只做"模型 → CM6 decoration"的映射，
         * 不再自己查块、自己判级别。与应用编辑器消费的是同一个模型。
         */
        const model = highlightLineModel(line.text, line.number, problems.byLine.get(line.number) ?? [])
        if (model.level === 'error') ranges.push({ from: line.from, to: line.from, value: LINE_ERROR })
        else if (model.level === 'warning') ranges.push({ from: line.from, to: line.from, value: LINE_WARN })
        for (const b of model.blocks) {
          ranges.push({
            from: line.from + b.from,
            to: line.from + b.to,
            value: b.severity === 'error' ? BLOCK_ERROR : BLOCK_WARN,
          })
        }
        let at = line.from
        for (const token of model.tokens) {
          const mark = MARKS[token.cls]
          if (mark) ranges.push({ from: at, to: at + token.text.length, value: mark })
          at += token.text.length
        }
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
const LINE_ERROR = Decoration.line({ class: 'ijipu-jps-error-line' })
const LINE_WARN = Decoration.line({ class: 'ijipu-jps-warn-line' })
/** adj756：**块级**外框（红/橙单线）—— 与应用 `hl-err-block` / `hl-warn-block` 同观感 */
const BLOCK_ERROR = Decoration.mark({ class: 'ijipu-jps-err-block' })
const BLOCK_WARN = Decoration.mark({ class: 'ijipu-jps-warn-block' })

/** 解析结果缓存：按行分组的错误块 + 悬停文案（块/级别的判定都在引擎模型里） */
type Problems = {
  doc: string
  /** 行号 → 该行的错误/告警块（引擎 `jpsBlockMarks` 分组而来） */
  byLine: Map<number, JpsBlockMark[]>
  hint: Map<number, string>
}

const problemCache = new WeakMap<EditorView, Problems>()

function problemsOf(view: EditorView): Problems {
  const doc = view.state.doc.toString()
  const hit = problemCache.get(view)
  if (hit && hit.doc === doc) return hit
  const hint = new Map<number, string>()
  let byLine = new Map<number, JpsBlockMark[]>()
  /** 把一条引擎问题（行号已换算成**文档行号**）并进提示表 */
  const addHint = (line: number, message: string, h?: string): void => {
    const text = h ? `${message}\n正确写法：${h}` : message
    const prev = hint.get(line)
    hint.set(line, prev ? `${prev}\n${text}` : text)
  }
  const scope = scopeOf(view, doc)
  if (scope) {
    try {
      if (scope.whole) {
        const errors = parseJps(doc).errors ?? []
        byLine = groupBlocksByLine(jpsBlockMarks(doc, errors))
        for (const e of errors) addHint(e.line, e.message, e.hint)
      } else {
        /**
         * adj774：**只解析每个 ```jps 块的正文**（不含围栏行），再把行号偏移回文档行号。
         * 这样笔记里其它 markdown 文本永远不会被当成 jps 源码解析 —— 既不会误报错误，
         * 也不会因为解析整篇笔记而在长文档上变慢。
         */
        for (const b of scope.blocks) {
          if (b.body.trim() === '') continue
          const errors = parseJps(b.body).errors ?? []
          const off = b.bodyStart - 1
          for (const m of jpsBlockMarks(b.body, errors)) {
            const line = m.line + off
            const list = byLine.get(line) ?? []
            list.push({ ...m, line })
            byLine.set(line, list)
          }
          for (const e of errors) addHint(e.line + off, e.message, e.hint)
        }
      }
    } catch {
      /* 解析器抛错时不做错误标注（不能因为标注把编辑器弄坏） */
    }
  }
  const out: Problems = { doc, byLine, hint }
  problemCache.set(view, out)
  return out
}

function hintOf(view: EditorView, line: number): string | undefined {
  return problemsOf(view).hint.get(line)
}

/** 悬停某行 → 显示该行的问题（message + 正确写法）。`.jps` 页签与 ```jps 代码块都适用（adj774） */
const problemTooltip = hoverTooltip((view, pos) => {
  if (scopeOf(view) === null) return null
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
