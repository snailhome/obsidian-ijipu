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
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { tokenizeJpsLine } from '@ijipu/engine'

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

export const jpsHighlightExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      // 文档变化 / 可视区滚动都要重算；页签标记变化（切进切出）由 docChanged 或后续 update 覆盖
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)
