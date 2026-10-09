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
  /** 开完之后是否要关掉"来源页签"（Obsidian 为 `.jps` 创建的那个中间页签） */
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
