# 爱记谱 iJipu 0.29.6

> 按**社区目录审核的第三批反馈**继续收敛；功能与 0.29.0 相同。
> **本次提交已从 `Failed` 变为 `Completed`**（5 个 Error 已全部清零），以下是剩余 Warning 的处理。
> 0.29.5 → **0.29.6**（PATCH）。

## 让构建真正可复现（消除 Build verification 警告）

审核提示「构建产物与 Release 产物不一致」。根因不是环境差异，而是**构建信息里带了"打包那一刻"的时间**：

- 旧：`BUILD_STAMP = <打包时间>` ⇒ 同一份源码每次构建**字节都不同**；审核方重新构建**永远对不上** Release 附件。
- 新：**从 git 对象里解出该提交自身的时间**（`node:zlib` 解压 `.git/objects/…`，不 spawn 子进程），
  于是「同 commit ⇒ 同产物」，同时仍能区分不同提交的构建。

验证：连续两次 `npm run build` 的 `main.js` **哈希完全一致**；且时间与 `git log -1 --format=%ci` 一致。

## CSS：`!important` 从 10 条降到 5 条

审核建议「避免 `!important`，改用更高特异性」。这条**在需要反制宿主的场景下不成立** ——
CSS 的规则是 `!important` **只能被 `!important` 压过**（要压的是 Obsidian 本体对 `textarea` 的
`height/min-height/max-height`，以及宿主给页签加的"键盘内边距"）。

但确实**有一半可以去掉**：这 10 条里有 5 条只是**我们自己的布局属性**（`display`/`flex-direction`/
`overflow`/`position`/`flex`），宿主并没有对这些属性设规则 ⇒ 已去掉 `!important`，
既让样式更干净，也避免与主题作者的样式无谓对抗。剩下 5 条保留了 `!important` 并写明原因。

## 其余修正

| 审核项 | 修法 |
|---|---|
| `prefer-create-el`：`src/scorePane.ts:219` 仍用 `document.createElementNS` | 改用 Obsidian 全局 **`createSvg('rect')`** |
| Recommendation：`display is deprecated`（`src/settings.ts:119`） | 改用 **`this.update()`**（1.13.0+ 起可用，与本插件 `minAppVersion` 一致；`display()` 在 1.13+ 不会刷新声明式设置） |
| Recommendation：`execCommand is deprecated`（`src/settings.ts:57`） | 该处**本就是回退路径**（`navigator.clipboard.writeText` 已先试）；补上带说明的禁用指令，写明"仅在 Clipboard API 不可用时使用" |

## 未做（附理由，均非阻断项）

- **`getSettingDefinitions()`（声明式设置 API）**：这是本轮唯一"值得做但没做"的较大改动 ——
  需要把整页设置改写成声明式定义，才能让设置项进入 Obsidian 1.13+ 的**设置搜索**。
  它只影响"能否被搜到"，不影响功能；且要重写并逐项回归现有交互。建议作为独立一轮专门做。
- **artifact attestations**（Recommendation）：需给工作流加 `id-token: write` 与 attest 步骤；属可选项，不动发布链。
- **Clipboard Access**（Recommendation）：仅告知。
- **引擎里的 3 处"赋值未使用"**（`cursorMap.ts:410`、`layout/index.ts:1777`、`tokenizer.ts:472`）：
  纯清理，收益低且要同步引擎与 vendor 两处，暂缓。
- **`fetch` → `requestUrl`**（`src/soundbank.ts` 与引擎 sampler）：改的是网络层行为，
  属功能改动而非纯合规，需要单独验证（尤其音源下载的回退链），不与本轮混在一起。
- **`@typescript-eslint/no-unsafe-*`（多数在引擎）**：类型收紧，量大且会牵动引擎内部实现，单独一轮做。

## 验证门

`tsc -noEmit` 0 错；`npm run smoke` **288 passed, 0 failed**；`npm ci --dry-run` exit 0；
`npm run build` 正常（`main.js` 2.85 MB）且**连续两次构建哈希一致**。
