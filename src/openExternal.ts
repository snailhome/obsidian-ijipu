/**
 * openExternal.ts — 「应用打开」：用**系统默认应用**打开当前 `.jps`（用户要求）
 *
 * ## 场景
 * 插件在桌面端看谱（`.jps` 文件视图）或看嵌入的 `![[x.jps]]` 时，想**一键切到关联的桌面应用**
 * （iJipu 桌面版）去编辑——此前只能自己到资源管理器里找那个文件。
 *
 * ## 实现
 * **不自己碰 electron**：桌面端把文件交给**宿主自己的** `App.openWithDefaultApp(库内路径)`
 * —— 这正是 Obsidian 文件菜单里「Open in default app」那一条（见 `openWithDefaultApp()` 的说明与证据）。
 * 早年这里写的是 `electron.shell.openPath(绝对路径)`；adj772 又改成函数内 `await import('electron')`，
 * 那个形态在渲染进程里**必然失败**（`adj778` 同款坑）⇒ adj926 起彻底改走宿主 API。
 *
 * ## 三条约束（都踩过或想得到）
 *  ① **仅桌面端**：手机端既没有 electron、也没有"默认应用"这回事 ⇒ 界面上按钮不渲染
 *     （`canOpenWithDefaultApp`），这里再挡一道，避免别处误用；
 *  ② **路径口径与宿主一致**：宿主 API 收的是**库内相对路径**（`TFile.path`）；
 *     只有走兜底那条（`window.open(getFilePath(...), '_external')`）时的 `getFilePath()` 才产出绝对
 *     `file://` 路径 —— 早年"必须是绝对路径"的说法只对 electron 那条路成立（adj926 已核对）；
 *  ③ **失败必须说出来**：这是最容易变成"点了没反应"的场景（应用侧 E-2026-405 同类），
 *     所以任何异常都要弹 `Notice`（带**原文**）；返回值 `true/false` 让调用方知道"到底交出去没有"。
 *
 * ⚠️ 打开的是**磁盘上的内容**：调用方应在打开前把未落盘的编辑刷下去（见 `ScorePaneHost.beforeOpenExternal`），
 *    否则用户在外部应用里看到的是旧版本。
 */
import { FileSystemAdapter, Notice, Platform, type App } from 'obsidian'

/**
 * adj652（用户要求："链接文本自动转换为链接，点击即可打开链接"）：
 * **用系统浏览器打开外部链接**（谱面文本里的 URL，如 `S:` 谱尾说明里的官网）。
 *
 * 实现：桌面端取 `electron.shell.openExternal(url)`（**按需**从 `./electronShell` 取，
 * 见该文件头：静态 import 必须放进独立模块，否则手机端一加载就崩），
 * 结果就是"在系统默认浏览器里打开"（而不是在 Obsidian 自己的窗口里跳走）。
 * 手机端没有 electron，退回 `window.open`（移动端 Obsidian 由宿主接管外部链接）。
 *
 * 为什么预览层要**先 `preventDefault` 再调这里**：SVG 里的 `<a target="_blank">`
 * 在 Electron 里的行为取决于宿主对 `setWindowOpenHandler` 的配置，不能指望；
 * 自己接管才稳定（同类决策见应用侧 `src/preview/openUrl.ts`）。
 */
export async function openUrlExternally(url: string): Promise<void> {
  const target = url.trim()
  if (!target) return
  if (Platform.isDesktopApp) {
    try {
      /**
       * adj772（Obsidian 社区审核：CommonJS 式导入被禁）：
       * 不在本文件里 `require('electron')`（那样手机端一加载就崩），改为**按需取**。
       *
       * ⚠ **adj926（用户实测「默认应用提示错误、打不开」）修正了这里的"按需"做法**：
       * adj772 当时写的是 `await import('electron')` —— 那是**原生动态 import**，
       * esbuild 不会把 external 的动态 import 转成 `require()`，渲染进程里会被当成
       * 浏览器式模块请求去 fetch ⇒ **必然失败**（与 `adj778` 的 `node:http` 是同一个坑，
       * 产物 `main.js` 里此前确实残留着 `import("electron")`）。
       * 现在改为动态 import **本仓库内部的** `./electronShell`（静态 import electron 在那边）：
       * 内部模块会被打包成惰性初始化函数 ⇒ 编译出的是 `require("electron")`，
       * 且**只在真正调用时**才执行（手机端永不执行）。详见 `src/electronShell.ts`。
       */
      const { shell } = await import('./electronShell')
      await shell.openExternal(target)
      return
    } catch (e) {
      new Notice(`打开链接失败：${e instanceof Error ? e.message : String(e)}`)
      return
    }
  }
  window.open(target, '_blank', 'noopener,noreferrer')
}

/**
 * 当前环境是否支持"用默认应用打开"。
 * 界面据此决定**要不要显示按钮**（用户要求：手机端不出现；代码块没有文件也不出现）。
 */
export function canOpenWithDefaultApp(app: App): boolean {
  if (!Platform.isDesktopApp) return false
  return app.vault.adapter instanceof FileSystemAdapter
}

/**
 * 用系统默认应用打开库内文件。
 *
 * @param filePath 库内相对路径（即 `TFile.path`，如 `曲谱集/小星星.jps`）
 * @returns 是否**已经交给系统**（`false` = 失败/不可用；调用方据此决定要不要保留站内预览）
 */
export async function openWithDefaultApp(app: App, filePath: string): Promise<boolean> {
  if (!Platform.isDesktopApp) {
    new Notice('「应用打开」只在桌面端可用')
    return false
  }
  /**
   * ---------------------------------------------------------------------------
   * adj926（用户实测：「打开方式 = 默认应用，提示错误，无法使用默认的外部应用打开」）
   *
   * 真因**不是**路径（`file.path` 早就换成了绝对路径），而是 adj772 起那句
   * `await import('electron')`：**原生动态 import 在渲染进程里必然失败**（见文件头与
   * `src/electronShell.ts`；这正是 `adj778` 对 `node:http` 记下的同一个坑）。
   * 而 `canOpenWithDefaultApp()` 只查了"桌面端 + 本地库" ⇒ 一路放行到这里才炸，
   * 用户看到的就只有一句 `用默认应用打开失败：…`。
   *
   * 修法：**优先用宿主自己的 API**，不再自己碰 electron。
   *
   * ① `App.openWithDefaultApp(path)` —— Obsidian 自己的「Open in default app」菜单项
   *    （核心插件 `open-with-default-app`）走的就是它。证据在 `obsidian.asar`（1.13.7）：
   *      · 文件菜单：`app.openWithDefaultApp(n.path)`（传的是 **`TFile.path`，库内相对路径**）；
   *      · 点开"不支持的文件类型"时也是它：`this.app.openWithDefaultApp(e.path)`；
   *      · 桌面端实现：`adapter.getFilePath(path)` ⇒ `window.open(fileUrl, '_external')`
   *        —— `_external` 是 Obsidian 自己的窗口名约定，由宿主的 `setWindowOpenHandler`
   *        交给系统（同一条约定也用在"在默认浏览器里打开链接"上）。
   *    ⇒ **传库内相对路径是对的**（与宿主自己一模一样）；"必须改成绝对路径"是误解。
   *
   * ② 宿主 API 取不到时（版本差异）退回**公开 API 的同一条路**：
   *    `window.open(FileSystemAdapter.getFilePath(path), '_external')`
   *    （`getFilePath` 是官方公开 API，返回 `file://` 绝对路径，`@since 0.14.3`）。
   *
   * 两条路都**不再有 electron 依赖** ⇒ adj778 那类"动态 import 必失败"的坑在这里彻底消失。
   * 失败一律把**原文**写进 Notice（不吞掉），成功返回 `true`。
   */
  const host = app as unknown as { openWithDefaultApp?: (path: string) => unknown }
  if (typeof host.openWithDefaultApp === 'function') {
    try {
      await host.openWithDefaultApp(filePath)
      return true
    } catch (e) {
      new Notice(`用默认应用打开失败：${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }
  const adapter = app.vault.adapter
  if (!(adapter instanceof FileSystemAdapter)) {
    new Notice('当前库不是本地文件系统，无法用默认应用打开')
    return false
  }
  try {
    window.open(adapter.getFilePath(filePath), '_external')
    return true
  } catch (e) {
    new Notice(`用默认应用打开失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
