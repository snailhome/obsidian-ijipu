/**
 * embed/openPlan.ts — 「打开 .jps 的方式」→ **开在哪里**的纯逻辑（adj724b）
 *
 * ## 为什么抽成纯函数
 *
 * 这段规则是用户可见行为（右侧栏 / 新的页签 / 当前页签 / 默认应用），却一度写在
 * `main.ts` 的方法体里靠 if/else 判断——后果是：
 *  ① 没法直接断言（只能用**字符串匹配源码**，脆到每轮改实现就断，且注释里写同样的字都会误判）；
 *  ② 用户实测「当前页签没生效」时，问题正出在这段决策里，而我们没有任何能跑它的断言。
 *
 * 抽出来之后：`openEmbedLeaf()` 只负责执行计划，`scripts/smoke-frontmatter.mts` 可以
 * **直接 import 这个函数**并断言四种方式 × (有/无来源页签) 的全部组合。
 */

/** 打开方式（与 `src/types.ts` 的 `EmbedOpenMode` 同源，这里重述以便本模块零依赖） */
export type EmbedOpenModeLike = 'right' | 'tab' | 'current' | 'defaultApp'

/**
 * 要执行的操作（== 开在哪里）。
 *
 * ⚠ 命名刻意用**动作**而不是"位置名词"：`'replace-source'`（就地替换来源页签）与
 * `'new-tab'`（新开一个）是**两个不同的动作**，调用方无法"看到位置却做错动作"——
 * 这正是用户实测「设为当前页签却仍开在新页签」那类 bug 的防线。
 */
export type EmbedTargetKind = 'right-sidebar' | 'new-tab' | 'replace-source'

export interface EmbedPlan {
  /** 要执行的动作 */
  kind: EmbedTargetKind
  /**
   * 开完之后要不要**收尾"来源页签"**（Obsidian 为 `.jps` 创建的那个）。
   *
   * ⚠ adj926：**取值口径没变**（右栏/新页签=true、当前页签=false），但**执行方式变了** ——
   * 从前是 `detach()`（关掉），现在是 `planSourceLeafDisposal()`（**还回去**：
   * 有上一份视图就 `back()`，没有才 detach）。因为那个 leaf **就是用户自己那个页签**，
   * 关掉它就是"用户的笔记没了 / 页签数变了"（用户实测报的就是这个）。
   */
  detachSource: boolean
}

/**
 * 计算"该执行哪个动作"。
 *
 * @param mode 设置里的打开方式
 * @param hasSourceLeaf 是否由 `.jps` 文件视图路由而来（即"有一个用户点开的页签"）
 */
export function planEmbedTarget(mode: EmbedOpenModeLike, hasSourceLeaf: boolean): EmbedPlan {
  if (hasSourceLeaf) {
    /**
     * 由 `.jps` 文件视图路由而来 ⇒ **那个页签就是用户点开的那个**（语义确定，不需要猜）。
     *  · `current` ⇒ **就地替换它**（不关：它变成 iJipu 本身）；
     *  · 其余      ⇒ 另开，并把那个中间页签**关掉**（否则用户会多一个无用页签）。
     */
    if (mode === 'current') return { kind: 'replace-source', detachSource: false }
    if (mode === 'right') return { kind: 'right-sidebar', detachSource: true }
    return { kind: 'new-tab', detachSource: true }
  }
  /**
   * 没有来源页签（例如点左侧栏图标打开应用）：
   *  · `current` ⇒ 用主编辑区**最近使用的**页签（由调用方用 `getMostRecentLeaf(rootSplit)` 取）；
   *  · `right`   ⇒ 右侧边栏；建不出来时调用方可回退到新页签；
   *  · `tab`     ⇒ 主编辑区新页签。
   */
  if (mode === 'current') return { kind: 'replace-source', detachSource: false }
  if (mode === 'right') return { kind: 'right-sidebar', detachSource: false }
  return { kind: 'new-tab', detachSource: false }
}

/**
 * adj727（用户要求）：**点「编辑」会不会离开 Obsidian**（即"打开 .jps 的方式" = 默认应用）。
 *
 * ## 为什么要单独成函数：它决定嵌入区工具栏右端那枚链接要不要留
 *
 * 嵌入区（`![[x.jps]]`）工具栏右端原本有一枚「打开谱面文件」链接 —— 它是**站内**打开
 * `.jps` 视图的唯一入口。而「编辑」按钮去的是设置里指定的位置：
 *  · 右栏 / 新页签 / 当前页签 ⇒ 仍在 Obsidian 内 ⇒ 链接是**重复入口**（用户要求收掉）；
 *  · **默认应用** ⇒ 文件交给系统里的 iJipu 桌面版、**离开 Obsidian** ⇒ 站内入口仍需保留。
 *
 * 与 `planEmbedTarget` 同一口径：抽成纯函数，冒烟里直接断言四种方式；
 * `main.ts` 的 `openIjipuFile` 与 `embed.ts` 给工具栏的标志**共用这一个判据**，
 * 避免"两处各写一遍 `mode === 'defaultApp'`，改一处漏一处"。
 */
export function embedEditLeavesObsidian(mode: EmbedOpenModeLike): boolean {
  return mode === 'defaultApp'
}

/**
 * adj923（用户要求 ①）：**「右侧栏」档只用一个嵌入版实例 —— 已经在右栏的那个要复用，绝不新建第二个**。
 *
 * ## 真因（在 `obsidian.asar` 里逐行核对过，不是猜的）
 *
 * 原写法是 `target = workspace.getRightLeaf(false) ?? workspace.getLeaf('tab')`。
 * `getRightLeaf(split)` 的实现是 `getSideLeaf(this.rightSplit, split)`，而 `getSideLeaf` 干的是：
 *   · `split` 为真 ⇒ 先 `insertChild` 一个 `WorkspaceTabs`、再往里 `insertChild` 一个新 leaf；
 *   · `split` 为假 ⇒ 取 `rightSplit.children[0]`，**照样 `insertChild(-1, new WorkspaceLeaf(…))`**。
 * ⇒ **它每次调用都新建一个 leaf**，从不返回"已经在右栏的那个"。
 * 用户看到的正是这个：右栏已经有一个嵌入版实例，再点「编辑」⇒ 右栏又多一个页签
 * （用户原话：「点编辑还是在右侧栏新的页签上打开，而不是使用同一个页签」）。
 *
 * Obsidian 自己处理同类需求用的是 `ensureSideLeaf(type, side, …)`，它第一步就是
 * `c = this.getLeavesOfType(type); u = c.length === 0 ? getRightLeaf(o) : c[0]` ——
 * **先找已存在的同类型 leaf，找不到才建**。这里照同一口径做，并补上"必须在右栏"这一条：
 * `ensureSideLeaf` 只看类型、不看在哪一侧，而我们要的是"揭开右栏那个"，不能把主编辑区的实例当右栏用。
 *
 * ## 判据
 *  · 命中 ⇒ 返回**它**、`reused = true`、**一次都不调 `create()`**；
 *  · 没命中 ⇒ 调 `create()` 建一个、`reused = false`。
 *
 * `leaf.getRoot()` 对侧栏 leaf 返回的是**侧栏那个 split**（不是最外层 root）——
 * `obsidian.asar` 里 Obsidian 自己就这么用（`getSideTooltipPlacement(){ var e = this.leaf.getRoot();
 * return e.side ? … }`）⇒ `leaf.getRoot() === workspace.rightSplit` 就是"这个 leaf 在右侧栏里"的正判。
 * （抽成纯函数是为了能在冒烟里用**假 workspace 真跑一遍**：量"到底新建了几个 leaf、复用了没有"。）
 */
export interface RightSidebarPick<L> {
  leaf: L | null
  /** 是否**复用**了已存在的实例（`false` = 这一次新建了一个） */
  reused: boolean
}

export function pickRightSidebarLeaf<L extends { getRoot(): unknown }>(
  existing: readonly L[],
  rightSplit: unknown,
  create: () => L | null,
): RightSidebarPick<L> {
  const found = existing.find((leaf) => leaf.getRoot() === rightSplit)
  if (found) return { leaf: found, reused: true }
  return { leaf: create(), reused: false }
}

/**
 * adj923（用户要求 ②）：**桌面端点文件管理器里的 `.jps` ⇒ 直接按「打开方式」进嵌入版**
 * （不再先落到插件自己的轻量预览）。
 *
 * ## 为什么这段也要是纯函数
 *
 * 它是"点一下文件，看到什么"的**唯一分派点**（`fileView.ts` 的 `render()`），而这里有三个
 * **必须原样保住**的反向条件（用户明确交代"手机端完全不变""预览要留作兜底"）：
 *  ① 笔记里的 `![[xx.jps]]` 内嵌 ⇒ 仍是轻量预览（笔记里塞一个完整编辑器既难看也没必要）；
 *  ② 「使用嵌入版 iJipu（完整应用）」关着 ⇒ 轻量预览（否则用户会得到一个写着"未启用"的死页签）；
 *  ③ **手机端 ⇒ 轻量预览**（嵌入版依赖本地 HTTP 服务，只在桌面端注册）；
 * 剩下的桌面端才按设置里的「打开方式」分派。
 *
 * 返回值是**动作**而不是"位置"（与 `EmbedTargetKind` 同一姿势）：
 *  · `'embed'`           ⇒ 本页签让位给嵌入版（画一句占位，随后按打开方式路由过去）；
 *  · `'preview+external'`⇒ **默认应用**：本页签留着画轻量预览，同时把文件交给系统默认程序
 *                          （系统程序不算"另一个嵌入版实例"，预览留着对用户有用）；
 *  · `'preview'`         ⇒ 就画轻量预览（上面 ①②③ 三种情形）。
 *
 * ⚠ adj773 的旧口径（"PC 与手机端一律先给预览"）**已被用户 2026-10-13 的②推翻**：
 * 桌面端不再先预览；手机端与 `![[xx.jps]]` 内嵌**一行没动**。
 */
export type JpsInitialView = 'preview' | 'embed' | 'preview+external'

export interface JpsInitialViewInput {
  /** 设置里的打开方式 */
  mode: EmbedOpenModeLike
  /** 是不是桌面端（`Platform.isDesktopApp`） */
  isDesktop: boolean
  /** 本次渲染是不是 `![[xx.jps]]` 的内嵌形态 */
  embedded: boolean
  /** 设置里「使用嵌入版 iJipu（完整应用）」开着吗 */
  embedEnabled: boolean
}

export function planJpsInitialView(o: JpsInitialViewInput): JpsInitialView {
  if (o.embedded) return 'preview'
  if (!o.embedEnabled) return 'preview'
  if (!o.isDesktop) return 'preview'
  if (o.mode === 'defaultApp') return 'preview+external'
  return 'embed'
}

/**
 * adj926（用户要求 ①③）：**那个"中间页签"该怎么收尾**。
 *
 * ## 真因（在 `obsidian.asar` 1.13.7 里逐行核对过，不是猜的）
 *
 * 用户实测「打开方式 = 右侧栏 / 默认应用时，当前打开状态被改了」「= 新的页签时，
 * 还是在**当前页签**里打开」。三条其实是**同一个**原因：
 *
 *  ① 点文件管理器里的 `.jps` ⇒ 宿主的 `FileExplorerView.onSelfClick()`：
 *     `t.getLeaf(Keymap.isModEvent(e)).openFile(this.file)`；普通左键时 `isModEvent` 为假 ⇒
 *     `getLeaf(false)` ⇒ `getUnpinnedLeaf()` ⇒ **"活动 leaf 只要 canNavigate 就返回它"**
 *     ⇒ 那句 `openFile` 是**就地换掉用户当前页签的视图**（把原来那份笔记推进该 leaf 的历史）。
 *     ⚠ 所以"中间页签"**不是**多出来的一个叶子，**它就是用户自己那个页签**。
 *  ② 于是旧写法 `sourceLeaf.detach()` = **把用户的页签关掉**（笔记消失；该组若空了，
 *     宿主还会补一个空页签 ⇒ 用户看到"多出一个新页签"）。
 *  ③ 「新的页签」档：`getLeaf('tab')` ⇒ `createLeafInTabGroup()` 把新 leaf 插在
 *     **当前页签紧后面**，再把当前页签 detach ⇒ 页签栏**数量与位置都没变**，
 *     只是标题从笔记换成了嵌入版 ⇒ 用户眼里就是"还是在当前页签里打开"。
 *     （⇒ 上游"多半是取 leaf 用错了"的判断**被推翻**：`getLeaf('tab')` 确实新建了叶子。）
 *
 * ## 修法：**不关，还回去**
 *
 * 让那个 leaf **回到它上一步的视图** —— 用的就是 Obsidian 自己页签栏上「← 后退」那一套
 * （`WorkspaceLeaf.history`：`back()` / `backHistory`；`getViewState()` 里**不含 `active`**，
 * 所以 `back()` 只换视图、**不会**抢走活动页签 —— 这一点也已在 asar 里核对）。
 *
 * 本函数只决定"怎么收尾"：`back`（有可还原的上一份视图）还是 `detach`（没有 ⇒ 原来就是空页签，
 * 关掉它宿主会补回一个空页签，状态同样是"没变"）。
 *
 * ## 为什么要跳过自己的 `.jps` 历史项
 *
 * 历史栈里可能压着**本插件自己的 `.jps` 视图**（例如上次嵌入版起不来、页签留在预览上，
 * 用户又点了另一份谱）。若把它还原出来，那个视图会**再路由一次**，把用户刚点的谱覆盖掉 ⇒
 * 所以把栈尾属于本插件视图的历史项**丢掉**（`dropCount`），只还原到真正的"上一份视图"。
 */
export interface SourceLeafDisposal {
  /** `back` = 让这个页签回到上一份视图（**不关掉它**）；`detach` = 关掉它（没有可还原的上一份视图） */
  action: 'back' | 'detach'
  /** 收尾前要从 `backHistory` 栈尾丢掉的条目数（都是插件自己的 `.jps` 视图） */
  dropCount: number
}

/**
 * @param historyTypes 该 leaf 的历史栈（栈尾 = 最近一步），元素是各步的视图类型
 * @param ownViewType 本插件的 `.jps` 视图类型（`VIEW_TYPE_IJIPU`）
 */
export function planSourceLeafDisposal(
  historyTypes: readonly (string | undefined)[],
  ownViewType: string,
): SourceLeafDisposal {
  let usable = historyTypes.length
  while (usable > 0 && historyTypes[usable - 1] === ownViewType) usable -= 1
  const dropCount = historyTypes.length - usable
  return usable > 0 ? { action: 'back', dropCount } : { action: 'detach', dropCount }
}
