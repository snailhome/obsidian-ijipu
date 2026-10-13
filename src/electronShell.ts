/**
 * electronShell.ts — **只在桌面端、按需加载**的 Electron `shell`（adj926）
 *
 * ## 为什么单独一个文件，而不是在 `openExternal.ts` 里直接 `await import('electron')`
 *
 * `adj778` 已经踩过同一个坑（用户实测的报错原文：`Failed to fetch dynamically imported module: node:http`）：
 * 插件产物是 **CJS**（`esbuild.config.mjs` 的 `format:'cjs'`，`electron` 标 external）——
 *   · **静态** `import` 一个 external ⇒ 编译成 `require("electron")`
 *     （渲染进程有 Node 集成，可用 ✓；本仓库的 `node:http` 走的就是这条）；
 *   · **动态** `import('electron')` ⇒ esbuild **不做**这条转换，那句请求被当成浏览器式的模块请求
 *     ⇒ 渲染进程里**必然失败** ✗（`main.js` 里能直接看到残留的 `import("electron")`）。
 *     `openExternal.ts` 此前（adj772 起）正是动态形态 ⇒ 用户点「默认应用」只看到一句报错。
 *
 * 但"改成静态 import"有一个代价：静态 import 会进入**模块求值期** —— 手机端也要执行
 * `require("electron")` ⇒ 插件一加载就崩 ✗（手机端没有 electron）。
 *
 * 两边都要，于是把静态 import 放进**这个独立模块**，调用侧用 `await import('./electronShell')`：
 * 内部模块的动态 import 会被 esbuild 打包成"**惰性初始化函数**"（产物里的 `__esm` / `init_*`），
 * 那句 `require("electron")` **只有真正调用到才执行** ⇒ 桌面端起得来 ✓、手机端永不执行 ✓。
 *
 * 同一手法本仓库已有先例：`main.ts` 的 `loadEmbedServer()` 把 `./embed/server`（`node:http`）
 * 只在桌面端动态 import（见 `adj778` 的说明）。
 *
 * ## 证据（`obsidian.asar` 1.13.7）
 * Obsidian 自己的**渲染进程**代码就在用 `electron.shell`：
 *   · 设置页按钮 `electron.shell.openExternal("https://discord.gg/veuWUTm")`；
 *   · 显示库文件夹 `window.electron && electron.remote.shell.showItemInFolder(...)`。
 * ⇒ 渲染进程里 `require('electron').shell` 可用（这也是本模块能在桌面端工作的前提）。
 */
import { shell } from 'electron'

export { shell }
