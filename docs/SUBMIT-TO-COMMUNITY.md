# 提交到 Obsidian 社区目录（面向 0.29.7）

> 官方流程已更新：**不再向 `obsidianmd/obsidian-releases` 提 PR**，而是到
> **[community.obsidian.md](https://community.obsidian.md)** 用 Obsidian 账号提交，自动审核后给出反馈。
> 依据：官方《[Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)》。

## 一、提交前的必备项（本仓库已全部满足）

| 要求 | 状态 |
|---|---|
| 公开仓库，根目录含 `README.md`（含安装与用法） | ✓ `## 安装 / Installation`、`## 用法 / Usage` |
| 根目录含 **`LICENSE`**（明确许可） | ✓ AGPL-3.0：`LICENSE.md` 为 SPDX 官方**纯全文**，版权与 SPDX 标识在 `NOTICE.md` |
| 根目录含 `manifest.json` | ✓ `id: ijipu`；版本随发布递增 |
| 网络使用**披露** | ✓ README「网络使用与权限（披露）」 |
| GitHub **Release tag 与 manifest 的 `version` 一致** | ✓ tag 跟版本走（无 `v` 前缀） |
| Release 附件含 `main.js` / `manifest.json` / `styles.css` | ✓ CI 自动产出 |
| Release 附件有**构建来源证明** | ✓ `actions/attest-build-provenance`；核验 `gh attestation verify main.js --repo snailhome/obsidian-ijipu` |
| CI 按**锁文件**严格安装（可复现构建） | ✓ `npm ci` |
| 构建信息**可复现**（同 commit ⇒ 同产物） | ✓ 指纹取**提交时间**而非"打包时刻" |
| 若用到 Node/Electron API ⇒ 必须标 `isDesktopOnly: true`；**只在移动端不可用时才标** | ✓ **`isDesktopOnly: false`**（0.32.0 起支持手机端；`node:http`/`node:crypto` 已改为**惰性加载且仅在桌面端走**，手机端改用宿主编辑器 + 原生预览，详见 README「安装」） |

## 二、你需要做的三步（需登录，AI 无法代办）

### 1. 建 Obsidian 账号并关联 GitHub
1. 打开 <https://community.obsidian.md>，用邮箱注册/登录 Obsidian 账号。
2. 在个人资料里 **Link GitHub account**（用于验证你确实是该仓库的所有者）。

### 2. 添加插件
3. 在目录里选 **Add a plugin**，填仓库地址：`https://github.com/snailhome/obsidian-ijipu`。
   目录会读取**默认分支 HEAD 的 `manifest.json`**。

### 3. 填展示信息
4. 描述可用 manifest 里那句英文，或写更长的中文说明（README 摘录会自动展示）。
   建议补上：官网 <https://ijipu.pages.dev>、以及**仅桌面端**的说明。

## 三、提交后会发生什么

- 目录**自动审核**，把要修正的点显示在仪表盘；修正方式：**改仓库 → 递增版本 → 发新 Release**。
- 审核通过并 **Publish** 后，用户即可在 Obsidian 里「设置 → 第三方插件 → 浏览 → 搜索 **iJipu**」安装。

> ⚠ 目录里的描述/名称随时可改；但 **`id` 一旦发布不能变**（本插件已定 `ijipu`）。
> ⚠ **不要用 eslint 禁用指令去满足审核建议** —— 官方有"禁止禁用"的规则清单
> （`no-deprecated`、`no-console` 等），写了禁用指令本身就是一条 Error（0.29.6 踩过此坑）。

## 四、安装目录（仅影响手动安装的用户）

- 目录名为 **`.obsidian/plugins/ijipu/`**（与 `id` 一致）。

从社区目录安装时由 Obsidian 自动放置；手动安装的用户需要把目录改名并重新启用。

## 五、可选：发布公告

首版发布后，官方建议在
[论坛 Share & showcase](https://forum.obsidian.md/c/share-showcase/9) 与
Discord 的 `#updates` 频道（需先获取 `developer` 角色）公告。
