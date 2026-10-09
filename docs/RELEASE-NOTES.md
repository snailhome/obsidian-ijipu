# 爱记谱 iJipu 0.29.2

> 按**社区目录自动审核反馈**逐条修正；功能与 0.29.0 相同。
> 0.29.1 → **0.29.2**（PATCH：仅合规项）。

## 本版修正（审核反馈）

| 审核项 | 之前 | 现在 |
|---|---|---|
| **Dependencies：Error**「npm lockfile is out of date」 | `esbuild@^0.21.0` 与 `vite@8.2.1` 的 peer 要求（`^0.27.0 \|\| ^0.28.0`）**冲突** ⇒ `npm install` 报 `ERESOLVE`，lockfile 无法与声明一致 | `esbuild` 提到 **`^0.28.0`**，重新生成 `package-lock.json`；`npm ci --dry-run` **exit 0 / up to date** |
| **License：Warning**「no recognized license」 | 文件名为无扩展名的 `LICENSE`，GitHub 未识别 | 改为 **`LICENSE.md`**，并在全文前加**项目归属 + AGPL-3.0-or-later 声明 + SPDX 标识** |
| **Manifest：Warning**「authorUrl must not point to the plugin's own repository」 | `authorUrl` 指向插件仓库 | 改为**个人主页** `https://github.com/snailhome` |
| **README：Warning**「missing installation or usage instructions」 | 小节标题为中文（`## 安装` / `## 用法`） | 改为 **`## 安装 / Installation`**、**`## 用法 / Usage`**，并补上**从社区目录安装 / 手动安装**两条完整步骤 |
| Releases：Recommendation「missing artifact attestations」 | — | **未做**（属可选；需给工作流加 `id-token: write` 与 attest 步骤，暂不引入发布链风险） |
| Behavior：Recommendation「Clipboard Access」 | — | 无需动作（只是告知；本插件仅在「粘贴导入」时读剪贴板） |

## 0.29.1 的内容摘要（同批合规修正）

- 插件 `id`：`obsidian-ijipu` → **`ijipu`**（官方要求 id 不得含 `obsidian`）；
- `isDesktopOnly`：`false` → **`true`**（用了 `node:http` / `node:crypto` / `electron`）；
- `minAppVersion`：`1.0.0` → **`1.13.0`**（按真实最低兼容版本）；
- 描述改英文一句话（≤250 字符、以句号结尾）；`name`/`author` 去掉 emoji 与中文；
- README 新增「**网络使用与权限（披露）**」小节（政策要求明确披露网络访问）。

## 升级方式

从 Obsidian 社区目录（设置 → 第三方插件 → 浏览 → 搜索 iJipu）安装或更新。
手动安装的目录名为 `.obsidian/plugins/ijipu/`（与 `id` 一致）。

---

## 0.29.0 的内容（首发版本）

**嵌入版：在 Obsidian 里直接用完整的 iJipu 编辑 `.jps`**（不必再装外部桌面端）。

- **左侧栏出现「爱记谱」图标**（设置里可关）：点开是一个完整的 iJipu —— 编辑、排版、试听、导出都在。
- **以当前 Obsidian 文库为工作区**：不需要选文件夹、不需要文件系统授权。
- **打开库里的 `.jps` 就是完整编辑器**；笔记里 `![[xx.jps]]` 仍是原来的轻量预览，
  其工具栏按钮由「应用打开」改为「**编辑**」。
- **打开方式可选**：右侧栏（默认）/ 新的页签 / 当前页签 / 默认应用（仅桌面端）。
- **即时保存**（写入后回读校验），**撤销 / 重做历史照常**；**检测外部修改**并让你选是否重新载入。
- **深浅色跟随**：记住你的选择；选「跟随系统」时自动跟随 Obsidian 主题。
- **设置只有一处**：排版与音色统一在嵌入版里改，避免两处设置打架。
- 关掉「使用嵌入版 iJipu」开关即完全回到原来的轻量渲染（**可回退**）。

**同时修掉了 10 项真机实测问题**，详见 `docs/RELEASE-NOTES-ARCHIVE.md` 的 0.29.0 条目
（最关键的是「点 A 显示 B」：应用启动时的"恢复上次绑定"与宿主推来的文件并发，
而它用陈旧快照判断，把刚打开的那份覆盖了）。
