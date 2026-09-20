/**
 * openExternal.ts — 「应用打开」：用**系统默认应用**打开当前 `.jps`（用户要求）
 *
 * ## 场景
 * 插件在桌面端看谱（`.jps` 文件视图）或看嵌入的 `![[x.jps]]` 时，想**一键切到关联的桌面应用**
 * （iJipu 桌面版）去编辑——此前只能自己到资源管理器里找那个文件。
 *
 * ## 实现
 * `electron.shell.openPath(绝对路径)` ⇒ 等价于在资源管理器里**双击该文件**（走 `.jps` 文件关联）。
 * 不用 `child_process` 拼命令行：那要自己找 exe 路径，而"默认应用"本来就由系统关联决定。
 *
 * ## 三条约束（都踩过或想得到）
 *  ① **仅桌面端**：手机端既没有 electron、也没有"默认应用"这回事 ⇒ 界面上按钮不渲染
 *     （`canOpenWithDefaultApp`），这里再挡一道，避免别处误用；
 *  ② **必须绝对路径**：`TFile.path` 是**库内相对路径**，直接丢给 `openPath` 会失败 ⇒
 *     用 `FileSystemAdapter.getFullPath()` 换算；库不在本地文件系统（理论上）时明确拒绝；
 *  ③ **失败必须说出来**：这是最容易变成"点了没反应"的场景（应用侧 E-2026-405 同类），
 *     所以 `openPath` 的返回字符串（空串=成功）与异常都要弹 `Notice`。
 *
 * ⚠️ 打开的是**磁盘上的内容**：调用方应在打开前把未落盘的编辑刷下去（见 `ScorePaneHost.beforeOpenExternal`），
 *    否则用户在外部应用里看到的是旧版本。
 */
import { FileSystemAdapter, Notice, Platform, type App } from 'obsidian'

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
 * @param filePath 库内相对路径（即 `TFile.path`，如 `曲谱集/小星星.jps`）
 */
export async function openWithDefaultApp(app: App, filePath: string): Promise<void> {
  if (!Platform.isDesktopApp) {
    new Notice('「应用打开」只在桌面端可用')
    return
  }
  const adapter = app.vault.adapter
  if (!(adapter instanceof FileSystemAdapter)) {
    new Notice('当前库不是本地文件系统，无法用默认应用打开')
    return
  }
  const abs = adapter.getFullPath(filePath)
  try {
    // electron 由宿主提供（esbuild 里已标 external），且只在桌面端走到这里
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { shell: { openPath: (p: string) => Promise<string> } }
    const err = await electron.shell.openPath(abs)
    // openPath 约定：成功返回空串，失败返回错误描述
    if (err) new Notice(`用默认应用打开失败：${err}`)
  } catch (e) {
    new Notice(`用默认应用打开失败：${e instanceof Error ? e.message : String(e)}`)
  }
}
