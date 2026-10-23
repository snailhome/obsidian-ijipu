# 爱记谱 iJipu 0.44.4

> **跟随版（嵌入版同步）**（PATCH）：引擎**无变化**（仍 `0.44.0`，`vendor/engine` 差异 0），
> 只把**内嵌应用** `0.74.1 → 0.74.2` 换进来：导出视频自带封面（片头卡完整帧）、片尾落款网址写完整
> （`https://ijipu.pages.dev`）。插件自身**无代码改动**。

## 内嵌应用 0.74.1 → 0.74.2

- **导出视频自带封面**：片头标题卡的**完整帧**（`t = 3700 − 700 = 3000ms`）编成 JPEG 写进 MP4
  （`moov/udta/meta/ilst/covr`）⇒ 系统缩略图与播放器封面不再是一片空背景（`E-2026-522`）。
- **片尾落款网址写完整**：`https://ijipu.pages.dev`（不再剥协议，照抄即可打开，`E-2026-523`）。

## 插件自身

- 无代码改动；仅嵌入版同步（`vendor/engine` 无差异）。

## 工程与验证

- `vendor/engine` 与应用引擎 **0.44.0** 逐文件哈希一致（差异 **0**，67 个文件）。
- 嵌入版单文件 HTML 在应用 0.74.2 定稿后重新生成，`WEBAPP_META.appVersion = 0.74.2`（`adj733` 闸门绿）。
- 应用侧：`tsc -b` 0 错、`lint` 0 error（63 warning 同基线）、`build` 通过、`smoke` 全绿
  （新增 `adj1111` 6 条 + `adj1112` 2 条）、`verify:app-ui` 108 项全绿；
  安装包 `iJipu_0.74.2_x64-setup.exe` 通过 `check:installer`；GitHub Release `v0.74.2` 已发（附安装包）。
- 插件侧：`npx tsc -noEmit -skipLibCheck` 退出码 0；`npm run smoke` 全绿（条数以实跑输出为准）。

> 动态谱视频为**桌面端专属**；网站与 Obsidian 插件不显示入口与相机位（承接 0.44.0 的边界）。
