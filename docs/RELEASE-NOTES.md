# 爱记谱 iJipu 0.29.5

> 按**社区目录自动审核的第二批反馈**（块代码静态检查）逐条修正；功能与 0.29.0 相同。
> 0.29.4 → **0.29.5**（PATCH：仅合规项）。

## 本版修掉的 5 个 Error（Source code 一节）

| 规则 | 位置 | 修法 |
|---|---|---|
| `no-static-styles-assignment`（直接写样式） | `src/embed/frame.ts` 4 处、`src/fileView.ts` 12 处、`src/settings.ts` 1 处 | 样式搬进 `styles.css` 的 `.ijipu-web-frame-fit` / `.ijipu-file-editing-fit` / `.ijipu-source-editor-fit` / `.ijipu-settings-title` / `.ijipu-offscreen`（含必要的 `!important`），JS 侧只挂类名 + 用 `setCssStyles()` 写动态高度 |
| 未描述的指令注释 | `src/openExternal.ts` 2 处 | 给 `eslint-disable-next-line` 补 `-- 原因`（说明为什么必须 `require('electron')`） |
| `Unsafe assignment to innerHTML` | `src/scorePane.ts` | 改用 Obsidian 官方 `sanitizeHTMLToDom()` 转成 `DocumentFragment` 再插入（内容仍是引擎自己画的 SVG） |
| 设置标题含插件名 | `src/settings.ts` | 标题改为「嵌入版与说明」——设置页本就挂在插件条目下，不重复插件名 |
| 禁用 `no-console` + 未描述指令 | `vendor/engine/layout/index.ts` | 删掉那段调试用 `console.log`（连带两条无效指令注释）——**同时改在引擎源码里并同步 vendor** |

## 同批修掉的 Warning

| 规则 | 修法 |
|---|---|
| `no-irregular-whitespace`（7 处） | 引擎 `modifierGlyphs.ts` 注释里的**全角空格 U+3000** 换成普通空格（源码改，vendor 同步） |
| 命令 id 含插件名 | `open-ijipu-app` → **`open-app`**（Obsidian 会自动加插件前缀） |
| `prefer-create-el` | `document.createElement` → Obsidian 全局 `createEl` / `createSpan`（`icons.ts`、`render.ts`×2、`settings.ts`） |
| `requestAnimationFrame` 未加 `window.` | `scorePane.ts`×3、`fileView.ts`×1 改为 `window.requestAnimationFrame`（弹出窗口兼容） |
| `FileManager.trashFile()` | `vault.trash(file, true)` → `fileManager.trashFile(file)`（尊重用户的删除偏好） |
| `builtin-modules` 建议替换 | 改用 Node 内置 `module.builtinModules`（**移除该依赖**） |

## 未做（附理由）

- **Releases：artifact attestations**（Recommendation）：需给工作流加 `id-token: write` 与 attest 步骤；
  属可选建议，本版不引入发布链改动。
- **Build verification：构建产物与 Release 产物不一致**（Warning）：根因是构建信息
  `BUILD_STAMP` 含**分钟级时间戳**（这是 adj407 刻意的设计——同一版本会有多次本地构建，
  需要指纹区分），因此"审核方重新构建"不可能与 CI 构建的产物逐字节一致。
  已验证**同一分钟内的连续构建是可复现的**（两次哈希一致）。
  若日后要求严格可复现，可把指纹改为只含 commit。
- **Behavior：Clipboard Access**（Recommendation）：仅告知，无需动作。

## 回归防线

`npm run smoke` 新增 12 条断言钉住本轮的写法（禁止直接写 style、禁止 `document.createElement`
与 `innerHTML`、命令 id 不含插件名、rAF 走 `window`、删除走 `trashFile`、
指令注释必须带说明、引擎里不得有全角空格与调试 `console.log` 等）。
