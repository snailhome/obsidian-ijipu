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
export class Component {}
export class MarkdownRenderChild {}
export class TextFileView {}
export class FileSystemAdapter {}
export class Platform {
  static isDesktopApp = true
  static isMobileApp = false
}
export function createFragment<T>(fn?: (frag: T) => void): T {
  const frag = {} as T
  void fn
  return frag
}
