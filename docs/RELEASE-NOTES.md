# 爱记谱 iJipu 0.44.3

> **跟随版（引擎同步）**（PATCH）：① **同步引擎** `0.43.0 → 0.44.0`（新增 `layout/measureMap.ts`：
> 小节/拍位换算收进引擎、界面与命令行共用；`resolvePracticeRange` 新增 `endInLayout`；
> `flattenScoreNotes` 新增 `includeRests`）；② **内嵌应用** `0.74.0 → 0.74.1`（标记段收口：
> 遍次只列真能到达的、区间显示、标记线断在跳过处）；插件自身**无代码改动**。

## 引擎 0.43.0 → 0.44.0

- **小节/拍位换算进引擎**（`adj1101`）：新增 `layout/measureMap.ts`（`flattenScoreNotes` /
  `measureSpotOf` / `resolveBarBeatRange` / `totalBarsOf` / `hasNoteId` / `spotOfIn` / `BEAT_EPS`），
  并从 `engine/index.ts` 导出 —— 应用里的「段1 [ 33:1 - 34:2 ]」与命令行 `--from 33:1` 从此**同一口径**；
  `noteIdStringOf` 挪到中立的 `engine/ids.ts`（`layout` 不反向依赖 `playback`）。
- **`resolvePracticeRange` 新增 `endInLayout`**（`E-2026-519`）：终点在排版里有、在播放序列里没有事件
  （被连音线/同音合并）时，按「该起点之后紧邻的前一个音」配，**这一遍到不了就不加候选**；
  候选按内容签名（`id|音高|音色`）去重并重新编号（同一线路的反复只算一遍）；
  嵌套候选**保留**、默认取最完整的第一遍。
- **`flattenScoreNotes` 新增 `includeRests`**（`E-2026-520`）：休止符端点也能查位置
  （只用于展示口径；行偏移仍按可发声音符统计，小节号不推移）。

## 内嵌应用 0.74.0 → 0.74.1

- 标记段下拉显示「段1 [ 33:1 - 34:2 ]」；端点落在休止符、段2 及以后的旧 id 对不上时也能显示区间。
- 「共几遍」只算这一段真能到达的遍历（同一线路去重、嵌套保留、默认取最完整的第一遍）。
- 标记线：在「跳过不演奏的一段」处断开（`splitIntoRuns`）、连音线后段不再断、起点/终点都补到。

## 插件自身

- 无代码改动；仅随引擎 / 嵌入版同步（`vendor/engine` 逐字节镜像 + 嵌入版重新生成）。

## 工程与验证

- `vendor/engine` 从应用引擎 **0.44.0** 逐文件镜像，哈希差异 **0**（含新增/删除两类都核对，67 个文件）。
- 嵌入版单文件 HTML 由应用 `build:embed` + `embed-emit` 在**应用版本定稿后**重新生成，
  `WEBAPP_META.appVersion = 0.74.1`（`adj733` 闸门绿）。
- 应用侧：`tsc -b` 0 错；`lint` 0 error（63 warning 同基线）；`build` 通过；`smoke` 全绿
  （新增 21 条 + CLI 1 条）；`verify:app-ui` 108 项全绿；安装包 `iJipu_0.74.1_x64-setup.exe`
  通过 `check:installer`；GitHub Release `v0.74.1` 已发（附安装包）。
- 插件侧：`npx tsc -noEmit -skipLibCheck` 退出码 0；`npm run smoke` 全绿（条数以实跑输出为准）。

> 动态谱视频为**桌面端专属**；网站与 Obsidian 插件不显示入口与相机位（承接 0.44.0 的边界）。
