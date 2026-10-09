# 提交到 Obsidian 社区目录（面向 0.29.1）

> 官方流程已更新：**不再向 `obsidianmd/obsidian-releases` 提 PR**，而是到
> **[community.obsidian.md](https://community.obsidian.md)** 用 Obsidian 账号提交，自动审核后给出反馈。
> 依据：官方《[Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)》。

## 一、提交前的必备项（本仓库已全部满足）

| 要求 | 状态 |
|---|---|
| 公开仓库，根目录含 `README.md` | ✓ |
| 根目录含 **`LICENSE`**（明确许可） | ✓ AGPL-3.0（`./LICENSE`） |
| 根目录含 `manifest.json` | ✓ `id: ijipu` / `version: 0.29.1` |
| GitHub **Release tag 与 manifest 的 `version` 一致** | ✓ tag `0.29.1` |
| Release 附件含 `main.js` / `manifest.json` / `styles.css` | ✓（CI 自动产出） |
| `id` 只含小写字母与连字符、不含 `obsidian`、不以 `plugin` 结尾 | ✓ `ijipu` |
| `name` / `author` 用基本拉丁字符、无 emoji | ✓ `iJipu` / `SnailHome` |
| 描述 ≤250 字符、以句号结尾 | ✓ 126 字符 |
| 使用 Node/Electron API ⇒ `isDesktopOnly: true` | ✓ |
| **网络使用披露**（政策要求） | ✓ README「网络使用与权限（披露）」小节 |

## 二、你需要做的三步（需登录，AI 无法代办）

### 1. 建 Obsidian 账号并关联 GitHub
1. 打开 <https://community.obsidian.md> ，用邮箱注册/登录 Obsidian 账号。
2. 在个人资料里 **Link GitHub account**（用于验证你确实是该仓库的所有者）。
   —— 这一步是官方明确要求，没有它无法提交。

### 2. 添加插件
3. 在目录里选 **Add a plugin**，填仓库地址：`https://github.com/snailhome/obsidian-ijipu`。
   目录会读取**默认分支 HEAD 的 `manifest.json`**（当前 = `0.29.1`，已提交）。

### 3. 填展示信息
4. 描述可直接用 manifest 里的那句（英文），或写更长的中文说明（`README.md` 的摘录会自动展示）。
   建议在目录里补上：**官网 <https://ijipu.pages.dev>** 与**仅桌面端**的说明。

## 三、提交后会发生什么

- 目录会**自动审核**，把你需要在仓库里修正的点显示在仪表盘上。
- 需要修正时：**改仓库 → 递增版本号 → 发新 Release**（与本次 0.29.1 的做法相同），
  目录会读新的 tag。
- 审核通过并 **Publish** 后，用户即可在 Obsidian 里
  「设置 → 第三方插件 → 浏览 → 搜索 **iJipu**」安装。

> 目录里的描述/名称**随时可改**；但 `id` 一旦发布**不能变**，因此本次已把
> `obsidian-ijipu` → `ijipu`（原 id 含 `obsidian`，违反官方要求）。

## 四、安装目录变化（仅影响手动安装的用户）

- 旧：`<你的库>/.obsidian/plugins/obsidian-ijipu/`
- 新：`<你的库>/.obsidian/plugins/ijipu/`

从社区目录安装时由 Obsidian 自动放置；手动安装的用户需要把目录改名（并重新启用插件）。

## 五、可选：发布公告

首版发布后，官方建议在
[论坛 Share & showcase](https://forum.obsidian.md/c/share-showcase/9) 与
Discord 的 `#updates` 频道（需先获取 `developer` 角色）公告。
