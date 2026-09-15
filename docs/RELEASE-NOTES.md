<!-- 本文件只保留**当前版本**的更新记录；历史版本见 docs/RELEASE-NOTES-ARCHIVE.md。
     GitHub Release 正文由 scripts/release-body.mjs 从本文件截取当前版本。

     发版流程（每次）：
     1) 写本节（H1 必须形如 `# 爱记谱 iJipu <manifest.json 的 version>`，脚本按版本号定位）；
     2) 把**上一版**的内容整段移到 docs/RELEASE-NOTES-ARCHIVE.md（本文件只留当前版本）；
     3) 同步 manifest.json / package.json / versions.json（+ package-lock.json）的版本号；
     4) 提交 → 打 tag → 推送；CI 会用 release-body.md（只含当前版本）作为 Release 正文。 -->

# 爱记谱 iJipu 0.7.4

> 本版随 `@ijipu/engine` 同步 **adj413**：**谱面设置里的 px 值一律整数**。
> 插件侧（以及应用侧）过去把「虚线拖拽的浮点位移」原样写回 `# jps-config`，
> 于是笔记里会出现 `"margin_top":40.4`、`"metaPos":{"title":{"x":10.5}}` 这类小数
> ——描述头位置更是刻意保留 0.1px 精度。现在引擎在**读取与写入两端都取整**，
> 旧笔记里的小数值**打开即归整**，不需要手动清理。插件侧不需要改代码，只是引擎换新版。

## 修复：页面设置里的 px 值会出现小数（adj413）

- **现象**：拖动排版辅助虚线、或改过「页面设置」之后，笔记里的 `# jps-config` 会带上 `"margin_top":40.4`、`"note_size":13.49`、`"metaPos":{"title":{"x":10.5}}` 这类小数；反复微调还会不断累积零碎数值。
- **根因**：虚线拖拽的落点是「鼠标位移 ÷ 预览缩放」的浮点结果，写入时**原样落盘**；读取端也不做归整，于是这些小数被一直沿用（`metaPos` 甚至按 0.1px 精度刻意保留）。
- **修复**：引擎 `settings.ts` 新增 `roundPxIntegers()`，在**读取端**（`mergeJpsConfig`，即打开/合并谱面设置时）与**写入端**（`writeJpsConfig`，即保存时）双向取整——覆盖顶层数值、按页行距 `heights`、描述头 `metaPos.x/y`；应用侧的虚线拖拽落点与设置输入框步长同步改为整数步进（插件侧无需改动）。
- **兼容**：取整**幂等**，对非数值字段（字体栈、枚举、布尔）**不做任何改动**；旧笔记里的小数在**读取时即归整**、保存时才落盘，不会造成额外改动。

## 验证

- 引擎 `npm run smoke` 新增 **22 条 adj413 断言**（新建模板的两条分隔注释恰好 30 字符 + 正文后留白 + 尾部页面设置区块原地更新；`roundPxIntegers` 对顶层/`heights`/`metaPos` 取整、幂等、默认配置全为整数、读写两端落盘均为整数）；失败项 17 == 改动前基线。
- 插件侧 `tsc -noEmit -skipLibCheck` 通过；`npm run smoke` **119 项全绿**；`vendor/engine` 与 `ijipu` 引擎**逐文件哈希一致**（29 个文件 0 处不一致，本次同步 `settings.ts` 与 `index.ts` 两个文件）。
- 应用侧另用无头 Chrome 实测：注入带小数的 `# jps-config`（`margin_top:40.4`、`heights:[12.4,8.5,20.5,0.5]`、`metaPos.x:10.5` 等）后读回，页面设置对话框显示的全是整数、无一处小数。
