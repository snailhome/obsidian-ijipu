# 爱记谱 iJipu 0.49.0

> **跟随版（内嵌应用 0.81.0）**（MINOR）：内嵌应用**重新生成**，把作者行 emoji 估宽修复带进 Obsidian 里的内嵌界面。引擎号不变（仍 `0.48.0`），插件自身无功能改动。

## 为什么要重发

- 0.48.1 只把插件自己的 `vendor/engine` 同步到修好的估宽函数，**内嵌应用是构建产物**（`src/gen/webappAssets.ts`，生成于 0.48.0 发版时），里面的引擎仍是旧估宽 —— 所以内嵌界面里 emoji 还会压字。
- 这次用当前应用源码重跑嵌入版构建（`npm run build:embed` + `scripts/embed-emit.mjs`），内嵌产物里的引擎已含修复（`Extended_Pictographic` 命中 1 处）。

## 内嵌应用

- 应用版本仍为 `0.81.0`（`WEBAPP_META.appVersion`），只更新构建产物（`generatedAt` = 2026-11-16T13:51:41Z，单文件 HTML 1,838,468 字节）。
- `npm run smoke:embed` 通过：单文件产物启动成功、无运行时报错、桥端到端通过（应用 hello→ready、19 次桥调用）、宿主推 `openFile` 能真的打开、设置持久化走宿主。

## 引擎

- 版本不变（`0.48.0`）；`vendor/engine` 未改动（0.48.1 已同步完）。

## 插件自身

- 无功能改动；只是内嵌应用资产重新生成。
