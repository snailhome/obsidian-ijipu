/**
 * engine/settings/layers.ts — **设置分层的判定规则**（纯逻辑，零 DOM）
 *
 * 用户 2026-10 要求（清单 B8）：「……等共性的功能都可以独立到引擎层面」，且「应用端也应同样处理」。
 *
 * 现状（先厘清，避免重复劳动）：
 *  · **分层优先**本身**早就在引擎里**了 —— 应用/插件都用 `mergeJpsConfig(source, hostDefaults)`
 *    （语义 = `默认 < 宿主默认 < 源内`，即 L0 < L1 < L2），应用侧"是否偏离默认"用 `nonDefaultConfigKeys`；
 *  · 剩下各写一份的是**判定规则**：iJipu 应用直接调引擎，Obsidian 插件则在 `defs.ts` 里
 *    自己实现了 `sameConfigValue` / `isDefaultValue` / `changedDefs` ⇒ 规则一旦分叉，
 *    会出现"应用认为该项是默认、插件认为不是"，从而**多写一条 `# jps-config`**。
 *
 * 于是把**规则**收进引擎（字段清单/控件标签仍属宿主界面层，留在各自仓库 —— 符合"数值口径同源、
 * 界面各自表达"的项目约定）：
 *  · `configValuesEqual`：值等价（对象按结构比较）；
 *  · `isDefaultConfigValue`：是否等于默认 —— 含**可选字段**约定：
 *    默认"未设置"（`undefined`）时，`undefined` 与 `false` 都算默认（E-2026-294 口径）；
 *  · `changedConfigKeys`：两份配置之间**哪些键变了**（`writeJpsConfig` 差量写出的同一判据）。
 */
/** 值等价（对象按结构比较；`null`/`undefined` 只在两边同类时相等） */
export function configValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/**
 * 值是否等于默认。
 * @param defaultValue 该项的引擎默认（`undefined` = 可选字段"未设置"）
 */
export function isDefaultConfigValue(defaultValue: unknown, value: unknown): boolean {
  // 可选字段：默认"未设置"⇒ `undefined` / `false` 都算默认（与 E-2026-294 同口径）
  if (defaultValue === undefined) return value === undefined || value === false
  if (value === undefined) return false
  return configValuesEqual(defaultValue, value)
}

/**
 * 两份（可部分）配置之间**哪些键变了**。
 *
 * @param keys 参与比较的键（缺省 = `before` ∪ `after` 的全部自有键）
 */
export function changedConfigKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys?: readonly string[],
): string[] {
  const all = keys ?? Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
  return all.filter((k) => !configValuesEqual(after[k], before[k]))
}
