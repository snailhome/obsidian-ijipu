# 爱记谱 iJipu 0.12.0

> 引擎同步 + 引擎行为变更需复核自身断言 ⇒ 0.11.0 → **0.12.0**（MINOR）。
> vendor/engine 与应用 **0.26.0 引擎（0.15.0）完全一致**（已逐文件 SHA256 复核，差异 0）。

## 变更

- **vendor/engine 同步**：引擎 0.14.0 → **0.15.0**。新增 `playback/ornaments.ts`（波音演奏时值的纯函数模块）；
  改：`index.ts`（新增 8 个导出 `MORDENT_SYMBOLS/ORNAMENT_SHORT_MIN_MS/ORNAMENT_SHORT_MAX_MS/ORNAMENT_SHORT_RATIO/mordentOf/mordentShortMs/neighborDegree/mordentPlan` + 类型）、`layout/spaceLayout.ts`（长倚音 = 本体 ×（附点 2/3、否则 1/2）+ 短倚音 = 主音符因子 × 倚音因子）、`parser/tokenizer.ts`（倚音括号**之后**写的 `&sby` 现在挂到音符 symbols，顺带修了"长倚音没有但有 `&zkh/&ykh/&hx`"的类似潜在 bug）、`parser/parser.ts`（删除旧"Σ 超主音符"告警，由借用机制接管）、`playback/sequence.ts`（**短前倚音总是抢在拍前**：倚音占 `[拍点 − 窗宽, 拍点]`，主音符稳落拍点；时间从上一个主音符匀、最多让出一半；力度 90%；连音合并方向性修复 —— 带波音自己不能并进前一个、但后一个同音可以并进它）。

## 验证

- `tsc -noEmit -skipLibCheck`：退出码 0
- `npm run smoke`：**155 passed, 0 failed**（共 155 条断言，引擎变更未破坏插件侧既有口径）
- 应用侧 OP-05：tsc / lint (0 error, 27 warnings = 基线) / build (stamp v0.26.0) / smoke ALL PASSED

## 升级

`vendor/engine` 是 `tsconfig.json` 路径映射的消费端（`@ijipu/engine`），无需在插件侧改任何代码即可享受新引擎；
**仅当你的脚本/预览依赖了旧的倚音/连音播放时值**才会感知到行为变化（这是规范的修订，不是 bug）。
