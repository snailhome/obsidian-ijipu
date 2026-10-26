# 爱记谱 iJipu 0.45.2

> **跟随版（内嵌应用 0.75.2）**（PATCH）：应用联系邮箱改为 `snail.zh@foxmail.com`；
> 音色库/工具安装包改为独立资源 Release（资源版本独立于应用版本）。插件自身**无代码改动**，
> 只同步嵌入版；引擎不变（仍 `0.45.1`）。

## 内嵌应用 0.75.1 → 0.75.2

- **联系邮箱**：关于对话框、包元数据与 README 统一改为 `snail.zh@foxmail.com`。
- **资源包独立发布**：音色库/工具按「每个资源文件一个安装器」发布，文件名用资源自身版本：
  `iJipu-SoundFont-GeneralUserGS_1.471.0_x64-setup.exe` 等；固定独立 Release：
  <https://github.com/snailhome/ijipu/releases/tag/resources>。
  应用升级不重发资源安装包。
- 同时包含 0.75.0 / 0.75.1 的全部内容。

## 引擎

- 不变（`0.45.1`）；`vendor/engine` 差异 **0**。

## 插件自身

- 无代码改动；`vendor/engine` 与应用引擎逐文件哈希一致（69 个文件）。
- 内嵌应用重新生成：`WEBAPP_META.appVersion = 0.75.2`（`adj733` 闸门绿）。

## 工程与验证

- 插件侧：`npx tsc -noEmit -skipLibCheck` 退出码 0；`npm run smoke` **840 passed / 0 failed**。
- 应用侧：`smoke` **4641 / 0 失败**、`verify:app-ui` **147 项**、`build` 通过、
  `check:encoding` 463 文件、`lint` 0 error、Rust `cargo check` 通过；
  安装包 `iJipu_0.75.2_x64-setup.exe` 通过 `check:installer`，GitHub Release `v0.75.2` 已发。
- 资源包：独立 Release `resources`，两个资源安装器已上传。

> 动态谱视频、对拍为**桌面端专属**；网站与 Obsidian 插件不显示相机位/对拍入口。
