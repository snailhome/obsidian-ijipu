/**
 * electron.d.ts — 给"动态导入 electron"一个最小类型（adj772）
 *
 * 背景（Obsidian 社区审核）：以 CommonJS 方式导入 electron 会被判违规，
 * 要求改成**动态 `import()`**（且只在 `Platform.isDesktopApp` 分支里执行）。
 * 但 `electron` 由 Obsidian 桌面版在运行时提供（esbuild 里标 `external`），本仓库并没有它的类型包
 * ⇒ 动态导入会 `TS2307: Cannot find module 'electron'`。
 *
 * 这里只声明**用到的那两个方法**：不用装 `electron` 依赖，也不影响运行期（纯类型，编译后擦除）。
 */
declare module 'electron' {
  export const shell: {
    /** 用系统浏览器打开外链 */
    openExternal(url: string): Promise<void>
    /** 用系统默认应用打开文件（成功返回空串，失败返回错误描述） */
    openPath(path: string): Promise<string>
  }
}
