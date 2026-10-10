/**
 * scripts/obsidianStub.ts — 冒烟用的 `obsidian` 最小替身（**仅供 `npm run smoke` 打包**）
 *
 * 为什么需要：`defs.ts` / `settings.ts` 等模块 `import { Setting } from 'obsidian'`，
 * 而冒烟在 Node 里跑、没有 Obsidian 运行时。esbuild 打包时用
 * `--alias:obsidian=./scripts/obsidianStub.ts` 把该依赖替换成本文件 ⇒ 冒烟可以**直接 import
 * 纯逻辑**（`DEFS` / `getDefault` / `changedDefs` / `isDefaultValue` …）逐项断言，
 * 而不必再靠"读源码文本"来核对（adj631 起）。
 *
 * 约定：这些模块只在**运行时**调用 Obsidian 的类/方法（构建控件、弹窗…），
 * **导入期不执行**；所以这里只要能满足 `import` 解析即可——真的调到（说明测试写错了）会直接抛错。
 */
export class Setting {
  constructor(..._args: unknown[]) {}
  setName() { return this }
  setDesc() { return this }
  setHeading() { return this }
  setClass() { return this }
  setTooltip() { return this }
  addText() { return this }
  addDropdown() { return this }
  addToggle() { return this }
  addButton() { return this }
}
export class Notice {
  constructor(..._args: unknown[]) {}
}
export class Modal {
  constructor(..._args: unknown[]) {}
}
export class PluginSettingTab {
  constructor(..._args: unknown[]) {}
}
export class Menu {}
export class Events {
  trigger(..._args: unknown[]): void {}
}
export class TFile {}
export class TFolder {}
export class Component {}
export class MarkdownRenderChild {}
export class TextFileView {}
export class FileSystemAdapter {}
export class Platform {
  static isDesktopApp = true
  static isMobileApp = false
}
/**
 * adj773（社区审核：音源下载由 `fetch` 改为 Obsidian 的 `requestUrl`）：
 * 冒烟里的 stub 也要有它 —— 转发到全局 `fetch`，这样既保留"测试可打桩 fetch"的能力，
 * 也让 `soundbank.ts` 的下载路径在套件里跑得通（否则 `requestUrl is not a function`）。
 */
export async function requestUrl(opts: { url: string; throw?: boolean }): Promise<{
  status: number
  arrayBuffer: ArrayBuffer
  text: string
}> {
  const res = await fetch(opts.url)
  const arrayBuffer = await res.arrayBuffer()
  return { status: res.status, arrayBuffer, text: new TextDecoder().decode(arrayBuffer) }
}
export function createFragment<T>(fn?: (frag: T) => void): T {
  const frag = {} as T
  void fn
  return frag
}

/**
 * adj724b（社区审核）：源码里改用 Obsidian 的 `createSpan()` / `createEl()`
 * 取代 `document.createElement`（规则 `obsidianmd/prefer-create-el`），
 * 冒烟运行在 Node 下没有 DOM，故这里给最小替身（只要求"能构造、能设样式"）。
 */
function stubEl(tag: string): HTMLElement {
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    style: {},
    setAttribute: () => undefined,
    setCssStyles: () => undefined,
    setCssProps: () => undefined,
    addClass: () => undefined,
  }
  return el as unknown as HTMLElement
}

export function createSpan(_o?: unknown): HTMLSpanElement {
  return stubEl('span') as unknown as HTMLSpanElement
}

export function createEl(tag: string, _o?: unknown): HTMLElement {
  return stubEl(tag)
}

export function createDiv(_o?: unknown): HTMLDivElement {
  return stubEl('div') as unknown as HTMLDivElement
}

export function sanitizeHTMLToDom(_html: string): DocumentFragment {
  return {} as DocumentFragment
}
