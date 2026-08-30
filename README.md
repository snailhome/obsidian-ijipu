# obsidian-ijipu（iJipu 简谱）

在 Obsidian 笔记中用 ` ```jps ` 代码块把 **.jps 简谱脚本渲染为可视化简谱（SVG）**，并可**试听**。渲染引擎复用 `@ijipu/engine`（与 iJipu 应用同一份引擎），设置项与 iJipu 一脉传承。

> 敲码即谱 → 码即成，谱自现。

## 安装

### 手动安装（推荐用于本仓库）
1. 构建产物（`main.js`）后，把插件目录拷到你的库：`<你的库>/.obsidian/plugins/obsidian-ijipu/`
   - 至少需要 `main.js`、`manifest.json`、`styles.css` 三个文件。
2. Obsidian 设置 → 第三方插件（社区插件）→ 关闭安全模式，找到 **iJipu 简谱** 并启用。
3. 若未显示，检查已加载插件列表／重开 Obsidian。

### 从源码构建
```bash
cd obsidian-ijipu
npm install          # 若你的环境无解，可 --ignore-scripts --legacy-peer-deps
npm run build        # tsc 类型检查 + vite(rolldown) 打包 → main.js
```

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

- 渲染区会显示简谱 SVG（多页自动分页），右上角有 **▶ 试听 / ⏹ 停止** 按钮（Web Audio 合成，无音频文件）。
- 语法解析失败会显示错误信息（不阻断正文）。

## 设置优先级

```
默认(defaultPageConfig)  <  插件默认设置（设置面板）  <  笔记 frontmatter（ijipu_*）
```

- 插件"设置"里的每一项即**全局默认**。
- 单个笔记可用 **frontmatter** 覆盖，覆盖项见下表（键名前缀统一 `ijipu_`，便于记忆/反查）。

### frontmatter 覆盖示例
```yaml
ijipu_paper: A4_horizontal
ijipu_note_size: 15
ijipu_note_space_layout: space
ijipu_lianyinxian_type: 1
ijipu_show_instrument: true
```

## Frontmatter 键对照表

> 键 = `ijipu_` + iJipu 引擎 `PageConfig` 字段名（设置界面每项下方都显示对应键）。`boolean` 用 `true/false`，`枚举` 用所给值。

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

## 标注
- 引擎：`@ijipu/engine`（.jps 解析 → 排版 → SVG 渲染 → 播放序列 → Web Audio 试听）。引擎源码随插件 **vendor 内置**（`vendor/engine`，自包含，可上社区/云 CI）。
- 许可证：AGPL-3.0（与引擎一致）。特别致谢「番茄简谱」原作与社区。

## 开发与构建
```bash
npm install          # 依赖（若 peer 冲突可 npm install --legacy-peer-deps）
npm run build        # tsc 类型检查 + vite(rolldown) 打包 → main.js
npm run dev          # 监听构建（vite --watch）
```
- `@ijipu/engine` 以内置源码（`vendor/engine`）被打包进 `main.js`，无需外部 npm 包，仓库自包含。

## 发布到 GitHub + Obsidian 社区插件
1. **推送到 GitHub**（仓库已 git init）：
   ```bash
   git remote add origin git@github.com:<你的用户名>/obsidian-ijipu.git
   git branch -M main
   git push -u origin main
   ```
2. **打 tag 触发自动发布**：
   ```bash
   git tag 0.1.0 && git push origin 0.1.0
   ```
   GitHub Actions（`.github/workflows/release.yml`）会自动 `npm ci --legacy-peer-deps` + `npm run build`，把 `main.js` / `manifest.json` / `styles.css` 发布为 GitHub Release 资产。
3. **提交社区插件**：到 [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) 进行 Fork，编辑 `community-plugins.json` 追加：
   ```json
   {
     "id": "obsidian-ijipu",
     "name": "iJipu",
     "author": "iJipu Dev",
     "description": "在笔记中用 .jps 脚本渲染可视化简谱并试听（复用 @ijipu/engine，设置与 iJipu 应用一致）。",
     "repo": "<你的用户名>/obsidian-ijipu"
   }
   ```
   提交 PR，Obsidian 官方审核通过后即进入社区插件市场。

