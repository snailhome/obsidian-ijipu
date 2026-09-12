# obsidian-ijipu（爱记谱 iJipu）

在 Obsidian 笔记中用 ` ```jps ` 代码块把 **.jps 简谱脚本渲染为可视化简谱（SVG）**，并可**试听**。渲染引擎复用 `@ijipu/engine`（与 iJipu 应用一致），设置项与 iJipu 一脉传承。

> 码即成，谱自现。

## 安装

1. 把插件文件夹（含 `main.js`、`manifest.json`、`styles.css`）拷贝到你的库：`<你的库>/.obsidian/plugins/obsidian-ijipu/`。
2. 打开 Obsidian 设置 → **第三方插件** → 关闭安全模式，在列表中找到 **iJipu** 并启用。
3. 若未显示，重开 Obsidian 或检查已加载插件列表。

## 用法

在任意笔记里写一个 `jps` 代码块：

````markdown
```jps
V: 1.0
B: 两只老虎
Z: 法国童谣 词曲
D: C
P: 4/4
J: 120
Q: 1 2 3 1 | 1 2 3 1 | 3 4 5 - | 3 4 5 - |
C: 两只老虎 两只老虎 跑得快 跑得快
```
````

- 渲染区显示简谱（多页自动分页），右上角有 **▶ 试听 / ⏹ 停止**（Web Audio 合成，无需音频文件）。
- 语法解析失败会显示错误信息，不阻断正文。
- **显示模式**（三个图标按钮）：**整页**（完整一页含页边距）/ **满宽**（撑满笔记宽度）/ **谱面**（裁掉页边距只显示内容区，默认）；悬停有文字说明。
- **排版**（田字格图标，与 iJipu 应用顶栏同一形状）：**显示/隐藏排版辅助虚线**——显示后**直接拖动虚线**即可调整版面，**松手即写入该谱源码的 `# jps-config` 行**（与 iJipu 一致，拖动过程只预览不落盘）。为能看见页边距，开启时会自动切到「整页」视图，关闭时恢复原视图。
- **设置**（滑杆图标）：打开对话框按字段精确设值（字体/字号/行距/渲染开关等**不可拖动项**），可「保存到谱面」（写 `# jps-config`）或「保存为插件默认」。工具栏会显示来源徽标（绿=谱面自带设置 / 灰=frontmatter 覆盖）。

### 可拖动的辅助虚线

| 虚线 | 拖动调整的字段 |
|---|---|
| 上 / 下 / 左 / 右 页边距 | `margin_top` / `margin_bottom` / `margin_left` / `margin_right` |
| 描述头区下沿线 | `descAreaH`（描述头内容区高；另有浅色中线为纯标注） |
| 第 1 行曲部线 | `body_margin_top`（曲部与描述头间距） |
| 多声部块内第 2+ 声部行线 | `height_shengbu`（声部行间距） |
| 其他曲部行线 | 上一行有歌词 → `height_ciqu_lyric`；否则 → `height_ciqu` |
| 歌词行线 | 第 1 行 → `height_quci`（曲-词间距）；后续行 → `height_cici`（词-词间距） |

## `.jps` 文件与嵌入

插件启用后，Obsidian 会把 **`.jps` 识别为简谱文件**：

| 用法 | 效果 |
|---|---|
| `[[我的谱.jps]]` | 链接可直接点开 → 用**简谱视图**打开（试听 / 显示模式 / 排版 / ⇄ 源码编辑），不再提示"无法打开" |
| `![[我的谱.jps]]` | 在笔记里**内联渲染**该谱（紧凑工具条，可试听）；排版保存直接改写该 `.jps` 文件 |
| 文件树里双击 `xxx.jps` | 同上打开简谱视图；工具栏「✎ 源码」可切到纯文本编辑（改动自动保存，`Ctrl+S` 立即保存） |

链接支持 `#子标题` 与 `|别名` 写法（`![[谱.jps|我的谱]]`、`![[谱.jps#第2段]]`）；找不到文件时会在原位给出提示而不是留空白。

## 设置优先级

```
引擎默认(defaultPageConfig)  <  插件设置（设置面板）  <  笔记 frontmatter（ijipu_*）  <  谱面源码内的 # jps-config 行
```

- **谱面源码内的 `# jps-config:{...}` 优先级最高**（与 iJipu 应用一致："每首谱用自己的设置"）。iJipu 点「保存设置」时会把**整份**配置写进源码那一行（纸张/边距/各字体栈/字号/行距/布局模式/连音线样式/描述头位置…），所以**把 iJipu 里的 .jps 直接复制进 Obsidian，渲染结果与 iJipu 一致**；插件设置与 frontmatter 只对**源内没写的键**生效。
- 谱面工具栏会显示来源徽标：绿色「**谱面自带设置 N 项**」（悬停看每个字段值）与「**frontmatter 覆盖 N 项**」。
- 插件设置面板每项即**全局默认**（谱面未自带设置时生效）；改设置后打开中的谱面立刻重渲染。
- 单个笔记也可用 **frontmatter** 覆盖（笔记级兜底，适合源内没写设置的谱），项见下表（键名前缀统一 `ijipu_`；设置界面每项下方的键名**点一下即可复制**）。
- **改动即时生效**：改 frontmatter（Properties 面板或 YAML）或改设置面板后，谱面**立刻重渲染**（无需重开笔记）。
- **写法宽松**：键名大小写不敏感，`ijipu_note_size` / `ijipu_noteSize`（驼峰）/ `ijipu_note_space_layout` 都能识别；数字与布尔也可以写成字符串（`"15"`、`是/否`、`1/0`）。
- **不会静默失效**：写成无法识别的键（如 `ijipu_paper`）会给出提示与**最近键名建议**（"是否想写 ijipu_page？"）。

### frontmatter 覆盖示例
```yaml
ijipu_page: A4_horizontal
ijipu_note_size: 15
ijipu_noteSpaceLayout: space
ijipu_lianyinxian_type: 1
ijipu_showInstrument: true
```

## Frontmatter 键对照表

> 键 = `ijipu_` + iJipu 引擎 `PageConfig` 字段名。`boolean` 用 `true/false`（也可写 `是/否`、`1/0`），`枚举` 用所给值。
> 设置面板每项下方的键名**可点击复制**；面板顶部还有「**复制全部键名**」与「**复制 frontmatter 模板**」（带当前值、可直接粘贴到笔记顶部）两个按钮。

### 页面
| 设置项 | frontmatter 键 | 类型 | 取值 / 默认 |
|---|---|---|---|
| 纸张 | `ijipu_page` | 枚举 | A4 / A5 / A4_horizontal / A5_horizontal（默认 A4） |
| 上边距 | `ijipu_margin_top` | 数字 | 默认 40 |
| 下边距 | `ijipu_margin_bottom` | 数字 | 默认 40 |
| 左边距 | `ijipu_margin_left` | 数字 | 默认 40 |
| 右边距 | `ijipu_margin_right` | 数字 | 默认 40 |
| 正文上间距 | `ijipu_body_margin_top` | 数字 | 默认 20 |
| 描述头区高 | `ijipu_descAreaH` | 数字 | 默认 80 |
| 小节间距 | `ijipu_bar_gap` | 数字 | 默认 0 |
| 两端对齐最小小节数 | `ijipu_align_min_bars` | 数字 | 默认 4 |
| 音符布局模式 | `ijipu_noteSpaceLayout` | 枚举 | space（空间优先）/ duration（时值优先），默认 space |

### 字体
| 设置项 | frontmatter 键 | 类型 | 默认 |
|---|---|---|---|
| 标题字体 | `ijipu_biaoti_font` | 字体名 | 微软雅黑/PingFang/Noto 系统栈 |
| 标题字号 | `ijipu_biaoti_size` | 数字 | 20 |
| 副标题字体 | `ijipu_fubiaoti_font` | 字体名 | 系统栈 |
| 副标题字号 | `ijipu_fubiaoti_size` | 数字 | 15 |
| 描述头字体 | `ijipu_miaoshu_font` | 字体名 | 系统栈 |
| 描述头字号 | `ijipu_miaoshu_size` | 数字 | 13 |
| 说明文字字体 | `ijipu_notes_font` | 字体名 | 系统栈 |
| 说明文字字号 | `ijipu_notes_size` | 数字 | 12 |
| 歌词字体 | `ijipu_geci_font` | 字体名 | 系统栈 |
| 歌词字号 | `ijipu_geci_size` | 数字 | 11 |
| 音符字号 | `ijipu_note_size` | 数字 | 13 |
| 音符(数字)字体 | `ijipu_shuzi_font` | 字体名 | 系统栈 |

### 行距
| 设置项 | frontmatter 键 | 类型 | 默认 |
|---|---|---|---|
| 曲-词间距 | `ijipu_height_quci` | 数字 | 15 |
| 词-词间距 | `ijipu_height_cici` | 数字 | 10 |
| 曲-曲间距 | `ijipu_height_ciqu` | 数字 | 20 |
| 曲-上词间距 | `ijipu_height_ciqu_lyric` | 数字 | 10 |
| 声部间距 | `ijipu_height_shengbu` | 数字 | 0 |

### 渲染
| 设置项 | frontmatter 键 | 类型 | 取值 / 默认 |
|---|---|---|---|
| 歌词压缩(避免重叠) | `ijipu_lyricShrink` | boolean | true / false（默认 false） |
| 显示乐器名 | `ijipu_showInstrument` | boolean | true / false（默认 false） |
| 连音线样式 | `ijipu_lianyinxian_type` | 数字 | 0 自动 / 1 圆弧 / 2 平顶（默认 0） |

## 支持作者

喜欢这个插件？可在插件的**设置页**点「**支持作者 ❤**」扫码支持（与 iJipu 应用一致的微信赞赏码，`https://ijipu.pages.dev/good.png`）。也可访问 [iJipu 官网](https://ijipu.pages.dev)。

## 标注

- 引擎：`@ijipu/engine`（.jps 解析 → 排版 → SVG 渲染 → 播放序列 → Web Audio 试听）。
- 许可证：AGPL-3.0（与引擎一致）。特别致谢「番茄简谱」原作与社区。
