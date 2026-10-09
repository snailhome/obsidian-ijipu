# 爱记谱 iJipu 0.31.1

> **修一个"版本没跟上"的真实问题**：插件自带的**嵌入版 iJipu** 是按上一版源码打出来的网页产物，
> 所以它里面的**引擎还是旧的**（试听色块仍会压到下一个音符），而且版本号仍显示 **0.49.0**。
> 本版把嵌入版产物按 **iJipu 0.50.0**（含引擎 0.31.1 的色块右界修复）重新生成。
> 0.31.0 → **0.31.1**（PATCH：只刷新嵌入版产物 + 版本号对齐，不改插件自身行为）。
> **语法与既有谱面零改动**。

## 修了什么

- **嵌入版 iJipu 升到 0.50.0**：`src/gen/webappAssets.ts` 按应用 **0.50.0** 源码重新生成
  （应用侧 `npm run build:embed` → `node scripts/embed-emit.mjs`）。产物里可核对到
  `v0.50.0`（1 处）与引擎修复标记 `inkLeftX`（3 处），且**不再出现** `v0.49.0`。
- **因此嵌入版的试听色块也修好了**：上一版发布时"色块右界按墨迹夹紧"（引擎 `adj732`）是在
  生成嵌入产物**之后**才做的 ⇒ 插件自己的 ` ```jps ` 预览用的是 `vendor/engine`（已修），
  而**嵌入版用的是那份旧 bundle**（未修）。用户实测口径："应用正常、插件还有覆盖"。
  现在两处同源：插件预览走 `vendor/engine`（与 0.50.0 逐文件一致），
  嵌入版走 0.50.0 的应用产物 —— 两条路都是修好的那份引擎。
- 版本号对齐：`manifest.json` / `package.json` / `versions.json` / `package-lock.json` → **0.31.1**。

## 验证门

- `npx tsc -noEmit -skipLibCheck` 0 错；`npm run smoke` **343 passed, 0 failed**；`npm run build` 正常。
- 真机行为验证（真实 Chrome + 本机 Obsidian 真实 `app.css`）**40 passed, 0 failed**。
- 产物核对：新 `webappAssets.ts` 含 `v0.50.0` 与 `inkLeftX`、不含 `v0.49.0`；
  `node scripts/release-body.mjs` 命中当版 `# 爱记谱 iJipu 0.31.1`。
