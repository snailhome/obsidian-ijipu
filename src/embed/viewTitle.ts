/**
 * embed/viewTitle.ts — 「承载某份 `.jps` 的视图」标题该显示什么 + 怎么让宿主**立刻**刷新页签头（adj931）
 *
 * ## 用户报的问题（2026-10-13，截图是同一时刻两个页签）
 *
 * 左 `半山听雨.jps` ✓（**正确基准**）、右「爱记谱」✗ —— 「新的页签」「当前页签」两档下，
 * 点文件列表里的 `.jps` 或点嵌入块的「编辑」开出来的视图，页签名一律显示「爱记谱」。
 * 用户口径：「凡承载某份 `.jps` 的视图，标题一律显示**该 `.jps` 的文件名（含扩展名）**，
 * 任何位置都不再出现「爱记谱」」＋「切换文件时必须刷新标题」。
 *
 * ## 真因（`obsidian.asar` 1.13.7 里逐行核对，不是猜的）
 *
 * · **左边为什么对**：那是宿主**按文件给的**标题 —— `.jps` 由 `registerExtensions()` 绑到一个
 *   **绑文件**的视图（本插件的 `IJipuFileView extends TextFileView`）。
 *   `WorkspaceLeaf.updateHeader()` 干的就是
 *   `this.tabHeaderInnerTitleEl.setText(this.getDisplayText())`（另加图标与悬浮提示），
 *   而 `TextFileView` 基类的 `getDisplayText()` 实现是
 *   `return this.file ? this.file.basename : …` ⇒ **标题天然跟着文件走**；
 *   更关键的是：`WorkspaceLeaf.setViewState()` **末尾那句 `this.updateHeader()`**
 *   ⇒ 每次绑定/切换文件，宿主都会自己刷一次标题。
 * · **右边为什么是「爱记谱」**：嵌入版是**应用级**视图（`VIEW_TYPE_IJIPU_APP`，不绑文件），
 *   标题完全靠自己返回。`getDisplayText()` 在**视图创建那一刻**就被宿主调用（那时还没打开文件）
 *   ⇒ 拿到写死的常量「爱记谱」；此后 `setActiveFileName()` 只改了一个私有字段，
 *   **没有任何东西通知宿主重画页签头** ⇒ 标题永远停在「爱记谱」（连"新的页签"这种**全新的**
 *   页签也一样：建视图 → 取标题 → 再 `openFile()` 设文件名，顺序天生是反的）。
 *
 * ## 所以这个模块就两件事
 *
 *  ① `jpsViewTitle()`：**一个纯函数**决定"承载 `.jps` 的视图显示什么"（**含扩展名**；只有确实
 *     没有文件时才退回应用名）。`.jps` 文件视图（`fileView.ts`）与嵌入版视图（`appView.ts`）
 *     **共用它** ⇒ 不会两处各写一遍、改一处漏一处。
 *  ② `refreshLeafHeader()`：按宿主**真实存在**的方式把新标题刷出去 —— 首选
 *     `WorkspaceLeaf.updateHeader()`（asar 里确认它同时刷新**页签头图标、标题文本、悬浮提示**，
 *     并对堆叠/侧栏再 `parent.updateCurrentTab()`）；拿不到这个内部方法时退回直接写页签头文本
 *     ＋ `aria-label`（= 宿主自己 `setTooltip` 用的那个属性）；都没有则返回 `'none'`
 *     （调用方只记录一句，不抛错、不影响功能）。
 */

/**
 * 应用自己的名字（**只在"这个视图没有承载任何 `.jps`"时**才用作标题）。
 *
 * 用户口径里的"任何位置都不再出现「爱记谱」"指的是**承载了某份 `.jps` 的视图**；
 * 点左侧 ribbon 图标打开、还没选谱时没有文件名可显示，那时显示应用名是唯一合理的选择。
 */
export const APP_DISPLAY_TEXT = '爱记谱'

/**
 * 承载某份 `.jps` 的视图该显示的标题。
 *
 * @param activeFileName 当前承载的文件名（**含扩展名**，例如 `半山听雨.jps`）；没承载就传 `null`
 * @param fallback 没有文件时的标题（默认应用名）
 */
export function jpsViewTitle(
  activeFileName: string | null | undefined,
  fallback: string = APP_DISPLAY_TEXT,
): string {
  const name = typeof activeFileName === 'string' ? activeFileName.trim() : ''
  return name === '' ? fallback : name
}

/**
 * 从**库内路径**取页签名：最后一段，**保留扩展名**。
 *
 * 为什么单独成函数：`openFile()` 收到的永远是 `TFile.path`（可能多层目录），
 * 而页签上要显示的是文件名 —— 这段切分是可断言的纯逻辑，不必靠读源码确认。
 */
export function jpsNameFromPath(path: string): string {
  const last = path.split('/').pop() ?? ''
  const name = last.trim()
  return name === '' ? path : name
}

/**
 * 只取"刷新页签头"用得到的那几样（宿主内部字段，故做**能力检测**而不是断言它们存在）。
 *
 * `WorkspaceLeaf` 上真实存在（1.13.7，asar 里核对过）：
 *  · `updateHeader()`            —— 宿主自己的刷新入口（图标 + 标题 + 悬浮提示 + 当前页签栏）
 *  · `tabHeaderInnerTitleEl`     —— 页签头上的标题元素（`.setText()`）
 *  · `tabHeaderEl`               —— 整个页签头（悬浮提示写在它的 `aria-label` 上）
 */
export interface LeafHeaderLike {
  updateHeader?: () => void
  tabHeaderInnerTitleEl?: { setText?: (text: string) => void } | null
  tabHeaderEl?: { setAttribute?: (name: string, value: string) => void } | null
}

/** 这次刷新走的是哪条路（`none` = 宿主没给任何可用入口，调用方据此记一句日志） */
export type HeaderRefresh = 'updateHeader' | 'tab-header' | 'none'

/**
 * 把 `title` 刷到宿主的页签头（含**悬浮提示**）上，返回实际走的那条路。
 *
 * ⚠ 为什么必须**主动**刷：宿主只在 `setViewState()` 结束、`setPinned()`、`setActiveLeaf()` 等
 * 时机调 `updateHeader()`；我们"换了一份谱"（`appView.openFile()`）走的是**桥**，
 * 不经过任何 `setViewState` ⇒ 宿主不会自己来问新标题。
 */
export function refreshLeafHeader(leaf: LeafHeaderLike | null | undefined, title: string): HeaderRefresh {
  if (!leaf) return 'none'
  if (typeof leaf.updateHeader === 'function') {
    leaf.updateHeader()
    return 'updateHeader'
  }
  const titleEl = leaf.tabHeaderInnerTitleEl
  if (titleEl && typeof titleEl.setText === 'function') {
    titleEl.setText(title)
    // 悬浮提示：宿主自己用 `setTooltip` ⇒ 落在 `tabHeaderEl` 的 `aria-label` 上
    leaf.tabHeaderEl?.setAttribute?.('aria-label', title)
    return 'tab-header'
  }
  return 'none'
}
