---
name: git-push-github
description: obsidian-ijipu 插件的 GitHub 推送操作（添加 remote / 推 main / 打 tag / 手动 Run workflow / 出 Release）。复用于其他仓库时改 REMOTE_URL。
---

# git-push-github

obsidian-ijipu 仓库的 GitHub 推送操作。默认远程为 `snailhome/obsidian-ijipu`，本地分支 `main`。

## 首次推送（仓库已在 GitHub 创建）

```bash
cd D:\Coding\JianpuScript\obsidian-ijipu

# 1) 加 remote（SSH / HTTPS 二选一）
git remote add origin git@github.com:snailhome/obsidian-ijipu.git      # SSH
# 或
git remote add origin https://github.com/snailhome/obsidian-ijipu.git  # HTTPS（首次需 PAT）

# 2) 改名本地默认分支为 main
git branch -M main

# 3) 推
git push -u origin main
```

## 平时推送（改完代码）

```bash
cd D:\Coding\JianpuScript\obsidian-ijipu
git status
git add .
git commit -m "feat: 你的修改说明"
git push origin main
```

## 出新版本（自动出 Release）

CI `.github/workflows/release.yml` 配置：打 tag 推送后自动 build 并把 `main.js` / `manifest.json` / `styles.css` 发布为 GitHub Release（且支持 workflow_dispatch 手动触发）。

```bash
cd D:\Coding\JianpuScript\obsidian-ijipu

# 改代码 → commit
git add . && git commit -m "release: 0.2.0 改动"
git push origin main

# 打 tag + 推送 tag → 触发 CI
git tag 0.2.0
git push origin 0.2.0

# 几分钟后到
#   https://github.com/snailhome/obsidian-ijipu/releases/tag/0.2.0
```

Release notes 默认从 `docs/RELEASE-NOTES.md` 读取（workflow 里 `body_path`）。改首版介绍时直接编辑这个 md 文件，下次 build 自动带上。

## 手动 Run workflow（补推 Release）

CI 偶尔跑挂了、或你想重新触发：

1. 打开 `https://github.com/snailhome/obsidian-ijipu/actions`
2. 左侧点 **Release Obsidian plugin**
3. 右上 **Run workflow** → 分支 `main` → **`tag` 输入 `0.1.0`**（或新版本号）→ **Run workflow**

等 1–3 分钟，0.1.0 release 会被更新（首版介绍 + 3 个资产）。

## 常见错误

| 错误 | 解决 |
|---|---|
| `Permission denied (SSH)` / `403 (HTTPS)` | SSH：检查 ssh key；HTTPS：用 PAT 作密码 |
| `Repository not found` | GitHub 端仓库名/owner 错，或没创建 |
| `non-fast-forward` | 远程有新 commit，先 `git pull --rebase` 再 push |
| `tag '0.1.0' already exists` | 删本地 `git tag -d 0.1.0`，删远程 `git push origin :refs/tags/0.1.0`，再新建 |
| Release 没资产 | 看 Actions 日志；常见原因：build 失败、workflow 缺 `permissions: contents: write`、softprops 的 `body_path` 文件不存在 |

## 一键脚本（cmd batch）

仓库根有 `scripts/git-push.bat`（cmd 批处理，Windows 直接双击或 cmd 调用）：

```bat
:: 平时推送
scripts\git-push.bat

:: 打 tag 触发 Release（如仓库配了 .github/workflows/release.yml）
scripts\git-push.bat 0.2.0

:: 自定义 remote（HTTPS）
scripts\git-push.bat 0.2.0 https://github.com/snailhome/obsidian-ijipu.git
```

参数：`%1 = Tag`、`%2 = RemoteUrl`。自动 commit 当前 staged 改动 → push main → 可选打 tag + push tag（自动清理同名旧 tag）。
