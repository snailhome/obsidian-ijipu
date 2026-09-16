<!-- 本文件只保留**当前版本**的更新记录；历史版本见 docs/RELEASE-NOTES-ARCHIVE.md。
     GitHub Release 正文由 scripts/release-body.mjs 从本文件截取当前版本。

     发版流程（每次）：
     1) 写本节（H1 必须形如 `# 爱记谱 iJipu <manifest.json 的 version>`，脚本按版本号定位）；
     2) 把**上一版**的内容整段移到 docs/RELEASE-NOTES-ARCHIVE.md（本文件只留当前版本）；
     3) 同步 manifest.json / package.json / versions.json（+ package-lock.json）的版本号；
     4) 提交 → 打 tag → 推送；CI 会用 release-body.md（只含当前版本）作为 Release 正文。 -->

# 爱记谱 iJipu 0.9.1

> 本版随 `@ijipu/engine`（0.12.0 → **0.13.0**）同步 **6 个引擎文件**：新增「谱面设置行校验」，
> 并带来几个可选的新 API。**插件的试听口径不变——仍然按谱面音色演奏**
> （曲内 `@乐器名@` > 描述头 `Y:`（按声部）> 默认音色/自动），无需改笔记里的任何写法。

## 新增：谱面设置行有问题时会给出提示

- 谱面末尾的 `# jps-config:{...}` 若是**坏 JSON**、**值类型不对**（如 `"margin_left":"abc"`）、
  **键名拼错**（如 `margin_laft`）或**整行被缩进**（必须顶格），现在会以**带行号**的告警出现在
  插件的问题提示里，并附「正确写法」。
- 此前这类问题一律**静默**处理：坏 JSON 让整行设置失效、坏值直接生效、拼错的键被丢弃，
  用户只看到「设置莫名不生效 / 退回默认」。现在不合法的那一项会被忽略并回退（**谱面照常渲染**），
  只有 JSON 整行坏掉才整行忽略。

## 引擎同步（不改变插件试听口径）

- **设置读取端类型校验**：`inspectJpsConfig` / `inspectJpsConfigLine`（引擎 `settings.ts`），
  解析器把设置行告警并进 `ParseResult.errors` —— 插件的问题提示区直接受益（告警不阻断渲染）。
- **写回只固化用户改动**：新增 `mergeConfigEdits(code, base, next)`；`writeJpsConfig` /
  `roundPxIntegers` 的入参放宽为 `Partial<PageConfig>`。插件「保存到谱面」写的仍是整份配置，行为不变。
- **试听「全篇音色」是可选参数**：`buildPlaySequence` 新增第 6 参数 `instrumentOverride`，
  并新增 `gmVoiceRef(program)` / `countScoreInstrumentSwitches(result)`。
  **插件不传该参数 ⇒ 试听依旧按谱面音色**；这与 iJipu 应用「选定具体音色 = 全篇统一」是**两套口径**
  （应用侧口径详见其 v0.22.0 的 `CHANGELOG.md`）。
- `inferBpm` 无 `J` 时的默认速度注释修正（实际为 **70**，此前注释误写 90）。

## 验证

- 插件 `npm run smoke`：**149 项全绿**（`tsc -noEmit -skipLibCheck` 通过）。
- `vendor/engine` 与 iJipu 引擎**逐文件哈希一致**；本次同步 6 个文件：
  `index.ts`、`settings.ts`、`parser/parser.ts`、`playback/{gmVoices,index,sequence}.ts`。
- 应用侧同批：`npm run smoke` 首次 **0 失败**（旧的「18 条预存失败基线」已逐条清理归零）。
