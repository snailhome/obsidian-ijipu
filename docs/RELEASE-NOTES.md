# 爱记谱 iJipu 0.39.1

> **本版是「嵌入产物同步版」**（PATCH）：插件**自身源码本轮零改动**，变的只有**内嵌的 iJipu 应用**
> —— 更新到 **0.59.0**（应用侧本轮的"命令行随应用发布"：CLI 内嵌进 `ijipu.exe`、控制台垫片
> `bin\ijipu.cmd`、全局设置「命令行」页签一键注册/解除当前用户 PATH、CLI 使用手册与
> `LICENSE`/`THIRD-PARTY.md` 随包、「关于」补源码仓库链接，以及**修掉嵌入版"内容相同却提示外部改动"**）。
> 0.39.0 → **0.39.1**。
> **既有谱面、`.jps` 语法、代码块参数全部零改动** —— 插件自己的代码一行未动，`vendor/engine` 也没变。

## 为什么是 PATCH 而不是 MINOR

按 `docs/VERSIONING.md`「两库版本号各自独立、各按自身代码更新量递增」＋插件历史口径：
**只有"嵌入版产物重生成"这一类改动**（插件自身 `src/` 未动、也没同步引擎）走 **PATCH**
（先例：`0.31.1`「嵌入版产物按应用 0.50.0 重生成（含引擎色块修复）」、`0.35.1`、`0.35.2`、`0.36.3`）。
本轮插件仓库 `git diff 0.39.0..HEAD` **只有 `src/gen/webappAssets.ts` 一个生成物文件**
（`5 insertions, 5 deletions`，就是版本号与产物哈希），没有任何手写源码变化 ⇒ 判 PATCH。

## 更新：内嵌的 iJipu 应用 0.58.0 → **0.59.0**

按项目的**顺序铁律**（`E-2026-374`）生成：先在应用仓库**定稿并提交**版本号（**0.59.0**，已打 tag
`v0.59.0` 并推送），**再** `npm run build:embed` + `node scripts/embed-emit.mjs` 重生成嵌入产物。
跨仓闸门 `adj733`（嵌入产物版本 == 应用 `APP_VERSION`）**通过**。

## 引擎：本轮不需要同步

应用本轮 `packages/ijipu-engine/src/engine/**` **一个文件都没动**（引擎包仍是 **0.36.0**）
⇒ `vendor/engine` 与上一版**逐字节相同**，**无需同步**（闸门 `adj770` 仍然绿）。

## 验证

- 插件：`npx tsc -noEmit -skipLibCheck` **0 错**；`npm run smoke` **717 passed, 0 failed**
  —— 含 `adj733`（嵌入版版本 == 应用 `APP_VERSION` = 0.59.0）、`adj770`（`vendor/engine` 与应用引擎
  **逐字节一致**）与「审核预检」各闸门（`adj799` 内联样式 / `adj772` `!important` 0 处）；
- `npm run build` 通过（`ijipu@0.39.1`），产物（`main.js` / `manifest.json` / `styles.css` 三个文件）
  已按源=目标逐字节一致的方式同步到本地 Obsidian 库做实测。
