# 爱记谱 iJipu 0.10.1（引擎同步 adj314 → adj320）

## 引擎同步

- **同步主项目 `packages/ijipu-engine` 至 adj320**（vendor/engine 镜像更新 3 个文件）：
  - `layout/index.ts`：多声部空间优先几何重写（adj314 → adj318）——`mspSegX`/`mspBarRelW`/`mspS` 拉伸空白均分「(tb+numBars−1) 槽」、首小节节头 = 0（行首贴左）、末节线钳制 `rightLimit − halfBarW`（与单声部 `atEnd` 一致）、多声部读 `config.align_min_bars`（自然宽 ↔ 撑满分叉）
  - `layout/spacing.ts`：新增 `DOT_AFTER_DIGIT_GAP` 常量（adj317，规范化附点间隙常量于 `spacing.ts`，符合 AGENTS.md 五-3）
  - `playback/sequence.ts`：试听色块按"时值元素"分块（adj319 → adj320）——附点并入主音符（`5.` → 1 块）、增时线独立（`5---` → 4 块）、双附点 `5..` 含两个附点圆一个色块；色块右边界 = 下一时值元素左缘或小节线左缘（连续覆盖）；多声部段循环 `dur` 用主时值（去附点）防双重计入

## 用法

完全兼容旧版（0.1.0 / 0.2.0 的 `.jps` 代码块无需改动）。详细见 `README.md`。

> 0.2.0 的发布说明保留如下，未改动。

---

# 爱记谱 iJipu 0.1.0（首版）

在 Obsidian 笔记中用 ` ```jps ` 代码块把 **.jps 简谱脚本**渲染为可视化简谱（SVG），并可**试听**。渲染引擎复用 `@ijipu/engine`（与 iJipu 应用一致），设置项与 iJipu 一脉传承。

## 主要功能

- **可视化简谱渲染**：引擎支持 `.jps` 描述头、Q/C 行、修饰符、连音线、多声部、小节线 / 反复 / 跳房子
- **试听**：Web Audio 合成（SynthBackend），播放色块逐音符跟进（iJipu 同款 playheadPosOf 逻辑），多声部同时高亮
- **三种显示模式**：整页 / 满宽 / **谱面**（默认，自动消除页边距、最大化有效观看面积）
- **设置项与 iJipu 应用一脉传承**：页面 / 字体 / 行距 / 渲染 四组共 30+ 项
- **frontmatter 覆盖**：单笔记可用 `ijipu_*` 键覆盖全局默认，优先级：默认 < 全局 < frontmatter
- **插件卸载 / 切笔记自动停止试听**：避免失去控制
- **赞赏入口**：设置页「支持作者 ❤」链接到 iJipu 应用微信赞赏码

## 用法

在任意笔记写 ` ```jps ` 代码块即可：

```jps
V: 1.0
B: 两只老虎
Z: 法国童谣 词曲
D: C
P: 4/4
Q: 1 2 3 1 | 1 2 3 1 | 3 4 5 - | 3 4 5 - |
C: 两只老虎 两只老虎 跑得快 跑得快
```

详细 frontmatter 键对照表见 `README.md`。

## 链接

- [iJipu 官网](https://ijipu.pages.dev)
- [脚本规则说明](https://ijipu.pages.dev/doc/jps-spec.html)
- 引擎：[@ijipu/engine](https://github.com/snailhome/obsidian-ijipu)（vendor 内置，仓库自包含）

## 反馈

有问题请到 iJipu 官网或 GitHub Issues。
