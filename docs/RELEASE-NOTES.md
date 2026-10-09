# 爱记谱 iJipu 0.29.4

> **真正修掉"许可证未被识别"**：仓库里那份"AGPL-3.0"其实**被改写过**。功能与 0.29.0 相同。
> 0.29.3 → **0.29.4**（PATCH：仅合规项）。

## 根因（本轮终于查清）

0.29.2 把文件名从 `LICENSE` 改成 `LICENSE.md`、0.29.3 又把自定义头部移走 —— 都**没解决**，
GitHub 仍返回 `NOASSERTION`（无法识别）。

真正的根因：仓库里那份"AGPL-3.0"**不是标准全文**——它与 SPDX 官方英文全文**归一化后仍差约 700 字符**
（开头换成了 "This program is free software…" 式引言，正文也有改动）。
许可证识别器按**标准全文**匹配，**任何改写都会导致识别失败**。

定位手段：拿几个已知能识别的 AGPL 项目做对照（`logseq/logseq` 用 `LICENSE.md` 能被识别 ⇒ 形式没问题），
再把本项目那份与 **SPDX 官方全文**逐行比对 ⇒ 确认是内容被改写。

## 修法

- `LICENSE.md` 换为 **SPDX 许可证列表的官方英文全文**
  （`spdx/license-list-data` → `text/AGPL-3.0-or-later.txt`，235 行 / 34020 字节），**未作任何改动**；
- **`ijipu` 应用仓库的 `LICENSE` 同步为同一份**（逐字节一致，哈希校验过）；
- `NOTICE.md` 补「全文来源（重要）」小节：写明来源、以及"要写自己的版权说明请放 NOTICE/文件头、
  不要改 LICENSE"这条教训；
- `package.json` 的 `license` 字段改为标准 SPDX 表达式 **`AGPL-3.0-or-later`**。

## 版本号与文档

`0.29.4` 同步 `manifest.json` / `package.json` / `package-lock.json`（两处）；
`versions.json` 追加 `"0.29.4": "1.13.0"`；`RELEASE-NOTES.md` 只留当版。

## 验证门

`tsc -noEmit` 0 错；`npm run smoke` **274 passed, 0 failed**；
`npm ci --dry-run` **exit 0**；两份 LICENSE 严格 UTF-8 且逐字节一致。
