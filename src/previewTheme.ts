/**
 * previewTheme.ts — **插件预览**（`.jps` 文件 / ` ```jps ` 代码块）的主题解析（adj1009）
 *
 * 用户要求：「插件的 `.jps` 文件 / 代码块预览是否可以设置为随嵌入版 iJipu 的
 * **自动 / 浅色 / 深色**设置，显示主题/背景色，**仅预览跟随，不改变导出的设置**」。
 *
 * ## 主题来源
 * 嵌入版的 `localStorage` 被桥接进插件的 `embedKv`（`src/store/embedStorage.ts`），
 * 所以 `ijipu.themeMode`（`auto` / `light` / `dark`）在插件里**同步可读**，不必跨 iframe。
 *
 * ## `auto` 的语义（与嵌入版一致）
 * 应用里 `effectiveMode = themeMode === 'auto' ? systemLight : themeMode`；
 * 而 `systemLight` 又分两种：
 *  · 插件设置「跟随 Obsidian 主题」开着（默认）⇒ 宿主把 Obsidian 的深浅当系统深浅喂给应用；
 *  · 关掉 ⇒ 应用按浏览器/系统的 `prefers-color-scheme`。
 * 本函数把这两种情况显式化，避免预览与嵌入版"各算一套"。
 *
 * ⚠ 本模块**只决定预览用哪个类**（`light` / `dark` / `null` = 不跟随）；
 * 真正的显示由 `styles.css` 的 `.ijipu-preview-theme-*` 规则负责。
 * 导出/复制走引擎产物，不读这里的任何值（预览 CSS 不会进入 SVG/PNG）。
 */

/** 预览主题：`light` / `dark`；`null` = 不跟随（保持插件原来的白纸预览） */
export type PreviewTheme = 'light' | 'dark' | null

export interface PreviewThemeInput {
  /** 嵌入版存的主题模式（`ijipu.themeMode`；缺失/非法 ⇒ 按 `auto`） */
  kvMode: string | undefined
  /** 插件设置「预览跟随嵌入版主题」是否开启 */
  enabled: boolean
  /** 插件设置「跟随 Obsidian 主题」是否开启（决定 `auto` 用宿主还是系统深浅） */
  followObsidian: boolean
  /** Obsidian 当前是否深色（`document.body.classList.contains('theme-dark')`） */
  obsidianDark: boolean
  /** 浏览器/系统当前是否深色（`prefers-color-scheme`） */
  systemDark: boolean
}

/**
 * 解析预览应当使用的主题。
 *
 * 优先级：
 *  · 设置关掉 ⇒ `null`（保持原样，绝不影响已有观感）；
 *  · 嵌入版明确 `light` / `dark` ⇒ 用它；
 *  · `auto`（含缺失/非法）⇒ `followObsidian ? Obsidian 深浅 : 系统深浅`。
 */
export function resolvePreviewTheme(input: PreviewThemeInput): PreviewTheme {
  if (!input.enabled) return null
  const mode = input.kvMode === 'light' || input.kvMode === 'dark' ? input.kvMode : 'auto'
  if (mode !== 'auto') return mode
  return (input.followObsidian ? input.obsidianDark : input.systemDark) ? 'dark' : 'light'
}
