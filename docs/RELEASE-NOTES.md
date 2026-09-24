# 爱记谱 iJipu 0.17.0

> 同步 `@ijipu/engine`（0.18.0 → 0.19.0）——带来**方框小节计数**两项新谱面级设置
> （「显示小节计数」复选框 / 「序号间隔」整数，默认 4 ⇒ 第 4、8、12、16 小节，**全曲连续编号**，
> 多声部块内每小节只画一次；字号按**倚音音符 × 3/4** 画在曲部行自己的空间里，
> 开关它**不影响排版**——行高与词部位置都不动）。插件自身代码无功能改动。
> 0.16.0 → **0.17.0**（MINOR：聆听谱面里的 "第 N 小节" 立刻可见）。

**新增**

- **方框小节计数**（`adj625`，主项目新增的谱面级设置）—— `obsidian-ijipu` 的 `src/defs.ts` 同步登记：
  - 设置 → 谱面（或者每篇笔记的 `⚙ 排版` 对话框）→「音符布局」组下：
    - **显示小节计数**（toggle）—— 勾上后画带方框的小节序号；字号与**倚音音符**一致（实际为 `× 3/4` 缩放）。
    - **序号间隔**（number，1~99）—— 每隔几个小节显示一个（默认 4）。
  - 写入：勾选后保存到 **frontmatter `ijipu_showBarCount: true` / `ijipu_barCountInterval: 4`**（与所有
    `ijipu_*` 设置走同一条 `frontmatter.ts` 白名单 / 编译期完整性断言 ⇒ 拼错键名会告警）。
  - 渲染（引擎实现，与 iJipu 应用同源）：
    - 画在该小节**左侧**小节线**正下方**（行首隐藏小节线 ⇒ 序序号画在**边距线**位置）；
    - **多声部**块的块首序号画在**大括号与音符之间**、高度按**最上面声部**的小节线底缘算；
    - 行中间的小节线**仍画在**线正下方（多声部只在最高声部那条线上画一次，不按声部重复）。

- 前置修复（`adj382` 的延续）：`src/frontmatter.ts` 的 `PAGE_CONFIG_FIELDS` 白名单**同步补** `showBarCount` / `barCountInterval`；
  编译期完整性断言 `_PAGE_CONFIG_FIELDS_COMPLETE` 仍生效——主项目将来再加可选字段而不更新此表，`tsc` 会直接报错。
  附 smoke 断言（`scripts/smoke-frontmatter.mts` `[3b]` 6 条）：`ijipu_showBarCount` / `ijipu_barCountInterval` 双向识别（snake / camel / 旧写法 `ijipu_show_bar_count` 全部接受）、
  `DEFS` 同步登记、`ijipu_*` 复制按钮的键数同步 +1。

**升级**

- 笔记里想给谱子编号？**设置 → 谱面**或笔记 frontmatter（`---` 区）加：
  - `ijipu_showBarCount: true`
  - `ijipu_barCountInterval: 4`（默认 4，可改 1~99）
  - 保存即可在预览/排版里看到「第 4、8、12、16 小节」方框序号；**不影响排版**（行高、歌词位置、分页都不动）。
