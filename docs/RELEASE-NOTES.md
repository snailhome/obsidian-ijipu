# 爱记谱 iJipu 0.29.3

> **修掉"许可证未被识别"**（社区目录 License 检查仍报 Warning 的那一条）；功能与 0.29.0 相同。
> 0.29.2 → **0.29.3**（PATCH：仅合规项）。

## 本版修正

| 审核项 | 之前 | 现在 |
|---|---|---|
| **License：Warning**「repository does not have a recognized license」 | `LICENSE.md` 在 AGPL 全文**前面加了自定义头部**（项目名/版权行）⇒ GitHub 的 Licensee **匹配不到**，仓库许可证被识别为 `NOASSERTION / Other` | `LICENSE.md` 恢复为**未改动的 AGPL-3.0 标准全文**（646 行，与应用仓库逐字节一致）；版权与 SPDX 标识移到新增的 **[`NOTICE.md`](../NOTICE.md)**；README 的许可证行同步更新为 `AGPL-3.0-or-later` |

> 结论（写进 `NOTICE.md`）：GitHub 识别许可证**要求 `LICENSE*` 是纯标准全文** ——
> 在全文前后添加任何内容都会导致 `NOASSERTION`。

## 0.29.2 的修正（同批）

| 审核项 | 修正 |
|---|---|
| **Dependencies：Error**「npm lockfile is out of date」 | 根因是**真实依赖冲突**：`esbuild@^0.21.0` 与 `vite@8.2.1` 的 peer 要求（`^0.27.0 \|\| ^0.28.0`）冲突 ⇒ `npm install` 报 `ERESOLVE`。把 `esbuild` 提到 **`^0.28.0`** 并重生成 lockfile；`npm ci --dry-run` **exit 0** |
| **Manifest：Warning**「authorUrl must not point to the plugin's own repository」 | `authorUrl` 改为**个人主页** `https://github.com/snailhome` |
| **README：Warning**「missing installation or usage instructions」 | 改为 `## 安装 / Installation`、`## 用法 / Usage`，并写全**从社区目录安装 / 手动安装**两条步骤（含目录名必须为 `ijipu`） |
| Releases：Recommendation「artifact attestations」 | **未做**：属可选建议，需给工作流加 `id-token: write` 与 attest 步骤，暂不引入发布链风险 |

## 升级方式

从 Obsidian 社区目录（设置 → 第三方插件 → 浏览 → 搜索 iJipu）安装或更新。
手动安装的目录名为 `.obsidian/plugins/ijipu/`（与 `id` 一致）。

---

## 0.29.1 的修正（同批）

- 插件 `id`：`obsidian-ijipu` → **`ijipu`**（官方要求 id 不得含 `obsidian`）；
- `isDesktopOnly`：`false` → **`true`**（用了 `node:http` / `node:crypto` / `electron`）；
- `minAppVersion`：`1.0.0` → **`1.13.0`**；
- 描述改英文一句话（≤250 字符、以句号结尾）；`name` / `author` 去掉 emoji 与中文；
- README 新增「**网络使用与权限（披露）**」小节（政策要求明确披露网络访问）。

## 0.29.0 的内容（首发版本）

**嵌入版：在 Obsidian 里直接用完整的 iJipu 编辑 `.jps`**（不必再装外部桌面端）：

- 左侧栏「爱记谱」图标打开完整编辑器；以当前文库为工作区（免授权）；
- 打开库里的 `.jps` 即完整编辑器，`![[xx.jps]]` 仍是轻量预览（按钮改「编辑」）；
- **四种打开方式**：右侧栏（默认）/ 新的页签 / 当前页签 / 默认应用；
- **即时保存 + 撤销历史**、**检测外部修改**、**深浅色跟随并记住选择**；
- 设置只留一处（排版与音色统一在嵌入版里改）。

**同时修掉了 10 项真机实测问题**，详见 `docs/RELEASE-NOTES-ARCHIVE.md` 的 0.29.0 条目
（最关键的是「点 A 显示 B」：应用启动时的"恢复上次绑定"与宿主推来的文件并发，
用陈旧快照判断把刚打开的那份覆盖了）。
