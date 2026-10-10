/**
 * scripts/smoke-frontmatter.mts — 笔记 frontmatter（ijipu_*）→ PageConfig 的纯逻辑断言
 *
 * 运行：npm run smoke（esbuild 打包到 dist-smoke/ 后 node 执行）
 * 断言来源：用户反馈「在 frontmatter 里设置像 `ijipu_note_size` 好像没生效」——
 * 覆盖键名写法兼容、值类型转换、未识别键提示、优先级四类。
 */
import { defaultPageConfig, dragDelta, formatJps, formatLine, instrumentColorMap, layoutScore, parseJps, playheadBaseOf, playheadPosIn, renderScoreToSvg, splitParseIssues, tokenizeJpsLine, JPS_HIGHLIGHT_COLORS, JPS_PLAIN_COLORS, JPS_PROBLEM_COLORS, trackKeysOf, writeJpsConfig, mergeConfigEdits, configCarryover, SCORE_FONT_OPTIONS, buildPlaySequence, GUIDE_LIMITS, GUIDE_LIMITS_EX, SEGMENT_ROW_GAP_DEFAULT, OPTIONAL_CONFIG_FIELDS, defaultConfigForReset, extractJpsConfig, extractLegacyEditorPrefs, nonDefaultConfigKeys, GM_GROUPS, highlightLineModel } from '@ijipu/engine'
import type { PageConfig } from '@ijipu/engine'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * adj773：**离线闸门** —— 套件不得依赖外网。
 *
 * 由来：本轮跑套件时出现 `TypeError: fetch failed`（ECONNRESET），停在"音源下载"那条路径上；
 * 而这些用例本意是验"下载后写缓存/写插件目录"的逻辑，**不该真的联网**（今天早些时候网络可用才一直是绿的
 * ⇒ 等于把"网络可用性"混进了测试结果）。
 *
 * 现在：**本地地址**（嵌入版本地服务那批用例，走 127.0.0.1）照旧放行；
 * **外网**一律返回一个**可预测的假响应**（200 + 4 字节），于是"下载路径"照旧跑通、套件在任何网络环境下结果一致。
 * 想验真实下载行为的，请在该用例里自行替换 `globalThis.fetch` 打桩（而不是依赖外网）。
 */
/**
 * adj775：**负向判据的默认姿势 —— 先剥注释**。
 *
 * 由来：本仓库的负向断言（"源码里不得再出现 X"）已经**三次**被自己的注释绊倒 ——
 * 我们习惯在删掉某段能力后留一句"原本是 X，已删除"的说明，那句话本身就包含 X
 * ⇒ 断言误判成"X 还在"，红灯。凡是要断言"不存在"的地方，一律用这个帮手取源码。
 * （只剥 `/* … *​/` 与行尾 `// …`；字符串字面量里的 // 极少见，且这些断言都只看代码骨架。）
 */
export function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request).url)
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
    try {
      return await realFetch(input, init)
    } catch (e) {
      // 排查用：本地服务请求失败时把 URL 打出来（否则只看到 `fetch failed`，不知道是哪一个）
      console.log(`[smoke] 本地请求失败：${url} ⇒ ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  }
  return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
}) as typeof fetch

// adj738：原来这里从 `../src/frontmatter` 导入 applyFrontmatter / frontmatterKey / PAGE_CONFIG_FIELDS 等
// ——笔记 frontmatter 那一层（连同 `src/frontmatter.ts`）已整体删除，相关断言一并删除。
import { PAGE_NUM_RANGES, clampNum } from '../src/numRanges'
// adj631：设置面板的纯逻辑（页签/收藏音色分类列表/「保存为插件默认」的改动判据）
// —— `obsidian` 依赖已由 `npm run smoke` 的 `--alias:obsidian=./scripts/obsidianStub.ts` 替换掉
import { DEFS, changedDefs, getDefault, isDefaultValue } from '../src/defs'
import { clearVoices, filterVoices, groupVoices, invertVoices, normalizeVoices, selectAllVoices, selectedInGroup, setGroupVoices, toggleVoice, voiceSummary } from '../src/voiceChooser'
import { resolvePageConfig } from '../src/config'
import { codeBlockBody, jpsLinkpath, replaceCodeBlockBody } from '../src/sourceEdit'
import { computeGuideLines, cropRectFor, guideLimits, guidePlacement } from '../src/guides'
// adj724b：「打开 .jps 的方式 → 开在哪里」是**纯函数**，冒烟直接跑它
// （此前只能对 main.ts 做字符串匹配：脆，且注释里写同样的字都会误判）
import { embedEditLeavesObsidian, planEmbedTarget } from '../src/embed/openPlan'
// 新建 JPS 文件（文件夹右键菜单 + 点击未解析链接 + 默认模板）
import {
  NEW_JPS_BASE,
  NEW_JPS_TEMPLATE,
  consumeJpsLinkCreate,
  createJpsFile,
  dirOfPath,
  jpsLinkTarget,
  jpsParentFolder,
  markJpsLinkCreate,
  materializeJpsFile,
  nextJpsFileName,
  planJpsLinkCreate,
  registerJpsFileCreator,
  resolveJpsLinkPath,
  unregisterJpsFileCreator,
} from '../src/newFile'
import { TFolder as StubTFolder } from './obsidianStub'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * adj738（用户决定）：**笔记 frontmatter 那一层已整体删除**（`src/frontmatter.ts` 一并删除）。
 *
 * 原来这里有 6 个小节专门测它（[1] 键名写法兼容 / [2] 值类型转换 / [3] 可选字段识别 /
 * [4] 未识别键的最近键名建议 / [5] 非业务键与优先级 / [6] 键名映射与全字段命中）。
 * 现在的口径只剩两层：**插件设置（全局默认）< 谱面源码内的 `# jps-config`** ——
 * 后者的优先级与差量写回由 [7]/[8] 两节继续守着（`resolvePageConfig` + `writeJpsConfig`）。
 *
 * 仍未变的口径（不要误删）：`.jps` 文件视图与内联嵌入**从来没有** frontmatter 这一层
 * （`fileView.ts` / `embed.ts` 那时就传 null），只读文件内的 `# jps-config`。
 */

console.log('[3] 可选字段（无默认值）必须被识别——否则键会被静默忽略')
{
  /**
   * adj738：口径从"frontmatter 键"换成"**谱面源码里的 `# jps-config`**"——
   * 要守的性质不变：没有默认值的**可选字段**（`showInstrument` / `lyricShrink` 等）
   * 也必须被识别（否则写进源码会被静默忽略）。
   */
  const src = `# jps-config:{"showInstrument":true,"lyricShrink":true}\nD: C\nP: 4/4\nQ: 1 2 3 4 |\n`
  const opt = resolvePageConfig(src, {})
  check('# jps-config 里的可选字段 showInstrument 被识别并生效', opt.config.showInstrument === true, String(opt.config.showInstrument))
  check('# jps-config 里的可选字段 lyricShrink 被识别并生效', opt.config.lyricShrink === true, String(opt.config.lyricShrink))
  check('两个可选字段都记进了 sourceFields（对话框据此列"谱面自带设置"）',
    opt.sourceFields.includes('showInstrument') && opt.sourceFields.includes('lyricShrink'),
    JSON.stringify(opt.sourceFields))
  const fields = Object.keys(defaultPageConfig)
  check(`源内设置能覆盖引擎默认字段（共 ${fields.length} 个）`, fields.every((f) => typeof (opt.config as Record<string, unknown>)[f] !== 'undefined'))
}

console.log('[3b] adj625 方框小节序号两项（同步主项目：谱面变量里可设）')
{
  // adj738：口径从"frontmatter 键"换成"**谱面源码里的 `# jps-config`**"（要守的性质不变：
  // 这两项可选字段写进源码后必须真的生效、且被计数为"谱面自带设置"）。
  const g = resolvePageConfig(`# jps-config:{"showBarCount":true,"barCountInterval":2}\nD: C\nP: 4/4\nQ: 1 2 3 4 |\n`, {})
  check('源内 showBarCount 被识别并生效（布尔）',
    g.config.showBarCount === true && g.sourceFields.includes('showBarCount'), String(g.config.showBarCount))
  check('源内 barCountInterval 被识别并生效（数字）',
    g.config.barCountInterval === 2 && g.sourceFields.includes('barCountInterval'), String(g.config.barCountInterval))
  check('关闭时不写多余值：false 原样',
    resolvePageConfig(`# jps-config:{"showBarCount":false}\nQ: 1 |\n`, {}).config.showBarCount === false)
  // DEFS（defs.ts）import 了 `obsidian`，纯逻辑冒烟不能引入它 ⇒ 读源码断言两项都在定义表里
  // （设置面板与「排版」对话框共用同一份 DEFS，登记即两处同时出现）
  const defsSrc = String(readFileSync('src/defs.ts', 'utf8'))
  check('两项都在 DEFS 里（设置面板与「排版」对话框共用同一份定义）',
    /key: 'showBarCount', label: '显示小节计数', type: 'toggle'/.test(defsSrc) &&
      /key: 'barCountInterval', label: '序号间隔', type: 'number'/.test(defsSrc))
}

console.log('[3c] adj629q 设置口径与应用一致（字段集 / 标签 / 范围 / 默认值）')
{
  const defsSrc = String(readFileSync('src/defs.ts', 'utf8'))
  // ① 临时段三项（同步应用「布局 → 临时段」）：子项 + 应用同款标签
  check('`segmentRowGap` 三个子项都在设置表里（bz / dsb / tp，标签与应用同款）',
    /key: 'segmentRowGap', sub: 'bz', label: 'bz 段上下间距'/.test(defsSrc) &&
      /key: 'segmentRowGap', sub: 'dsb', label: 'dsb 段上下间距'/.test(defsSrc) &&
      /key: 'segmentRowGap', sub: 'tp', label: '替谱行与下方歌词间距'/.test(defsSrc))
  // ② 应用不暴露的字段（bar_gap）设置面板也不再给控件，但仍可随谱携带
  //    （adj738：原来用 `PAGE_CONFIG_FIELDS` 判——那是 frontmatter 层的字段表；现在直接看
  //     "写进 `# jps-config` 能不能生效"这一口径更准）
  check('应用不暴露的 `bar_gap` 不再出现在设置表里（但仍可随谱携带）',
    !/key: 'bar_gap'/.test(defsSrc) &&
      resolvePageConfig(`# jps-config:{"bar_gap":7}\nQ: 1 |\n`, {}).config.bar_gap === 7)
  // ③ 文案与应用逐项对齐（抽几个此前不一致的）
  check('行距 / 布局类标签与应用一致（曲部与词部间距、布局模式、序号间隔…）',
    /key: 'height_quci', label: '曲部与词部间距'/.test(defsSrc) &&
      /key: 'height_cici', label: '词部与词部间距'/.test(defsSrc) &&
      /key: 'height_ciqu', label: '曲部与曲部间距'/.test(defsSrc) &&
      /key: 'height_ciqu_lyric', label: '曲部与上词部间距'/.test(defsSrc) &&
      /key: 'noteSpaceLayout', label: '布局模式'/.test(defsSrc) &&
      /key: 'body_margin_top', label: '首行至描述头间距'/.test(defsSrc) &&
      /key: 'descAreaH', label: '描述头高'/.test(defsSrc) &&
      /key: 'showInstrument', label: '乐器显示'/.test(defsSrc) &&
      /key: 'lyricShrink', label: '歌词压缩'/.test(defsSrc))
  // ④ 范围表逐项引用引擎表（与应用 `numFieldRanges.ts` 同一份来源，值不许各写一份）
  const keys = Object.keys(PAGE_NUM_RANGES) as (keyof typeof PAGE_NUM_RANGES)[]
  const want: Record<string, readonly [number, number]> = {
    margin_top: GUIDE_LIMITS.margin_top,
    margin_bottom: GUIDE_LIMITS.margin_bottom,
    margin_left: GUIDE_LIMITS.margin_left,
    margin_right: GUIDE_LIMITS.margin_right,
    height_ciqu: GUIDE_LIMITS.height_ciqu,
    descAreaH: GUIDE_LIMITS_EX.descAreaH,
    body_margin_top: GUIDE_LIMITS_EX.body_margin_top,
    height_quci: GUIDE_LIMITS_EX.height_quci,
    height_cici: GUIDE_LIMITS_EX.height_cici,
    height_ciqu_lyric: GUIDE_LIMITS_EX.height_ciqu_lyric,
    height_shengbu: GUIDE_LIMITS_EX.height_shengbu,
    segmentRowGap_bz: GUIDE_LIMITS_EX.segmentRowGap_bz,
    segmentRowGap_dsb: GUIDE_LIMITS_EX.segmentRowGap_dsb,
    segmentRowGap_tp: GUIDE_LIMITS_EX.segmentRowGap_tp,
    barCountInterval: GUIDE_LIMITS_EX.barCountInterval,
  }
  check('范围表 15 项与应用同一份引擎表逐项相等',
    keys.length === Object.keys(want).length &&
      keys.every((k) => {
        const r = PAGE_NUM_RANGES[k]
        const w = want[k as string]
        return w !== undefined && r[0] === w[0] && r[1] === w[1]
      }),
    JSON.stringify(keys.map((k) => `${k}=${PAGE_NUM_RANGES[k]}`)))
  check('越界值按引擎范围钳制（bz 段间距 5 → 10、tp 取 0 合法、序号间隔 200 → 99）',
    clampNum('segmentRowGap', 'bz', 5) === GUIDE_LIMITS_EX.segmentRowGap_bz[0] &&
      clampNum('segmentRowGap', 'tp', 0) === 0 &&
      clampNum('barCountInterval', undefined, 200) === GUIDE_LIMITS_EX.barCountInterval[1] &&
      clampNum('note_size', undefined, 999) === 999) // 引擎表里没有范围的字段不钳制
  // ⑤ 默认值一律来自引擎（`SEGMENT_ROW_GAP_DEFAULT`），插件不另立默认
  check('临时段三项的默认值 = 引擎 `SEGMENT_ROW_GAP_DEFAULT`（bz 22 / dsb 22 / tp 14）',
    SEGMENT_ROW_GAP_DEFAULT.bz === 22 && SEGMENT_ROW_GAP_DEFAULT.dsb === 22 && SEGMENT_ROW_GAP_DEFAULT.tp === 14 &&
      /SEGMENT_ROW_GAP_DEFAULT/.test(defsSrc))
  // ⑥ adj738：原来这里核对"frontmatter 模板把 segmentRowGap 合成一行 YAML"——
  //    模板入口已随 frontmatter 层删除。改守同一件事的**现口径**：嵌套字段写进
  //    `# jps-config` 后能往返（读回来是对象、不是 `[object Object]`，且差量写入只一行）。
  const nestedSrc = `D: C\nP: 4/4\nQ: 1 2 3 4 |\n`
  const nestedSaved = writeJpsConfig(nestedSrc, {
    ...defaultConfigForReset(),
    segmentRowGap: { bz: 22, dsb: 22, tp: 14 },
  } as never)
  const nestedLine = nestedSaved.split('\n').filter((l) => l.startsWith('# jps-config'))
  const nestedBack = resolvePageConfig(nestedSaved, {}).config.segmentRowGap
  check('嵌套字段（segmentRowGap）写进 `# jps-config` 后往返保真、且只占一行',
    nestedLine.length === 1 &&
      !nestedLine[0].includes('[object Object]') &&
      nestedBack?.bz === 22 &&
      nestedBack?.dsb === 22 &&
      nestedBack?.tp === 14,
    `${nestedLine.join('|')} → ${JSON.stringify(nestedBack)}`)
}

console.log('[3f] adj629z 插件默认值/字段集/文档 与 iJipu 应用逐项同步')
{
  // 大背景：应用侧默认值是**代码默认**（`defaultPageConfig` / `SEGMENT_ROW_GAP_DEFAULT`），
  // 插件运行期一律直接读引擎（`getDefault` → 引擎）⇒ 只要 vendor/engine 同步，默认值就同步。
  // 真正会漂移的是**文档与登记表**（应用改了默认值、插件 README 还写着旧数字；应用加了设置项、插件没行）。
  // 下面把 DEFS 逐行解析出来，与引擎默认值、README 对照表逐项核，作为长期守卫。
  const defsSrc = String(readFileSync('src/defs.ts', 'utf8'))
  const rows = [...defsSrc.matchAll(/\{\s*group:\s*'([^']+)',\s*key:\s*'([^']+)'(?:,\s*sub:\s*'([^']+)')?,\s*label:\s*'([^']+)',\s*type:\s*'([^']+)'/g)].map((m) => ({
    group: m[1],
    key: m[2],
    sub: m[3],
    label: m[4],
    type: m[5] as 'select' | 'number' | 'text' | 'toggle',
  }))
  check(`defs.ts 解析出 ${rows.length} 行设置项（含 segmentRowGap 三个子项）`, rows.length >= 30, `got ${rows.length}`)
  // ① 字段名都必须是引擎字段（不许插件自造字段）
  const engineFields = new Set<string>([...Object.keys(defaultPageConfig), ...OPTIONAL_CONFIG_FIELDS])
  const invented = rows.filter((r) => !engineFields.has(r.key)).map((r) => r.key)
  check('① 每行 key 都是引擎 `PageConfig` 字段（插件不自造字段）', invented.length === 0, invented.join(','))
  // ② 默认值只来自引擎（行内不许自带 default 字面量——那才会与应用漂移）
  check('② 默认值只来自引擎：行内无 `default:` 字面量，且 `getDefault` 读 defaultPageConfig / SEGMENT_ROW_GAP_DEFAULT',
    !/,\s*default:/.test(defsSrc) &&
      /return defaultPageConfig\[def\.key\]/.test(defsSrc) &&
      /SEGMENT_ROW_GAP_DEFAULT/.test(defsSrc))
  // ③ 数值字段的范围必须等于引擎范围表（与应用 `numFieldRanges.ts` 同源）
  const engineRanges: Record<string, readonly [number, number]> = { ...GUIDE_LIMITS, ...GUIDE_LIMITS_EX }
  const rangeMismatch: string[] = []
  for (const [k, r] of Object.entries(PAGE_NUM_RANGES)) {
    const e = engineRanges[k]
    if (!e || e[0] !== r[0] || e[1] !== r[1]) rangeMismatch.push(`${k}: [${r}] ≠ [${e}]`)
  }
  check(`③ 范围表 ${Object.keys(PAGE_NUM_RANGES).length} 项与引擎逐项相等`, rangeMismatch.length === 0, rangeMismatch.join(' | '))
  // ④ README「设置键对照表」逐行核对（adj738：键名从 `ijipu_xxx` 改为**引擎字段名** `xxx`）：
  //    每个设置项都有一行，且行里写的默认值 = 引擎默认值
  //    （字体行文档只写"系统栈"，不做数值核对；可选布尔项要求写明默认 false）
  const readme = String(readFileSync('README.md', 'utf8'))
  const docRows = readme.split('\n').filter((l) => l.trim().startsWith('|') && /\|\s*`[A-Za-z_][A-Za-z0-9_]*`\s*\|/.test(l))
  const cellOf = (key: string) => {
    const row = docRows.find((r) => r.includes(`\`${key}\``))
    if (!row) return null
    const cells = row.split('|')
    return cells[cells.length - 2] ?? ''
  }
  const missing: string[] = []
  const stale: string[] = []
  for (const r of rows) {
    if (r.type === 'select' && /font$/i.test(r.key)) continue // 字体：文档写"系统栈"
    const cell = cellOf(r.key)
    if (cell === null) { missing.push(r.sub ? `${r.key}.${r.sub}` : r.key); continue }
    if (r.sub) continue // segmentRowGap 三个子项共一行，统一在 ⑤ 核
    const v = (defaultPageConfig as unknown as Record<string, unknown>)[r.key]
    if (v === undefined) {
      if (!/默认\s*(false|关)/.test(cell)) stale.push(`${r.key}（可选字段默认未设置，文档写「${cell.trim()}」）`)
      continue
    }
    if (typeof v === 'number') {
      if (!new RegExp(`(^|[^\\d.-])${String(v).replace('.', '\\.')}([^\\d]|$)`).test(cell)) stale.push(`${r.key}=${v}，文档写「${cell.trim()}」`)
      continue
    }
    if (typeof v === 'boolean') {
      if (!cell.includes(String(v))) stale.push(`${r.key}=${v}，文档写「${cell.trim()}」`)
      continue
    }
    if (!cell.includes(String(v))) stale.push(`${r.key}=${String(v)}，文档写「${cell.trim()}」`)
  }
  check('④a README 对照表覆盖每一项设置（缺行=用户照文档写 frontmatter 会找不到键）', missing.length === 0, `缺行：${missing.join(',')}`)
  check('④b README 里写的默认值与引擎默认值一致（改了默认值必须同步文档）', stale.length === 0, stale.join(' | '))
  // ⑤ segmentRowGap：一行里要写全三个子项默认值
  const segCell = cellOf('segmentRowGap') ?? ''
  check('⑤ README 写明 `segmentRowGap` 三个子项默认值（bz/dsb/tp = 22/22/14）',
    /bz\D*22/.test(segCell) && /dsb\D*22/.test(segCell) && /tp\D*14/.test(segCell), segCell.trim())
  // ⑥ 应用暴露的字段（TAB_CONFIG_KEYS 登记表）插件都有控件；插件不许有应用没有的谱面字段
  const appSrc = String(readFileSync('../ijipu/src/dialogs/PageConfigDialog.tsx', 'utf8'))
  const tabBlock = appSrc.match(/const TAB_CONFIG_KEYS[\s\S]*?\n\}/)?.[0] ?? ''
  if (tabBlock) {
    const appKeys = [...new Set([...tabBlock.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((m) => m[1]))]
    const pluginKeys = new Set(rows.map((r) => r.key))
    const gaps = appKeys.filter((k) => engineFields.has(k) && !pluginKeys.has(k))
    check('⑥ 应用暴露的谱面字段插件都有控件（跨仓对账）', gaps.length === 0, `插件缺：${gaps.join(',')}`)
  } else {
    check('⑥ 应用 PageConfigDialog 可读（跨仓对账）', false, '未找到 ../ijipu/src/dialogs/PageConfigDialog.tsx 的 TAB_CONFIG_KEYS')
  }
}

console.log('[3g] adj631 设置面板：多页签 / 收藏音色分类列表 / 与预览页面的同步口径')
{
  // ---- ① 收藏音色的分类与勾选运算（纯逻辑，voiceChooser.ts）----
  const groups = groupVoices()
  check('① 收藏音色按 GM 分类分组（14 类，与应用「音色库」同一张引擎表 GM_GROUPS）',
    groups.length === GM_GROUPS.length && GM_GROUPS.length === 14, `组的数=${groups.length}`)
  const flat = groups.flatMap((g) => g.voices.map((v) => v.program))
  check('① 分类**覆盖全部 128 个音色、不重不漏**（区间首尾相接）',
    flat.length === 128 && new Set(flat).size === 128 && [...flat].sort((a, b) => a - b).every((p, i) => p === i),
    `count=${flat.length}`)
  check('② 关键词过滤按显示名包含（空关键词原样返回）',
    filterVoices('').length === 128 && filterVoices('钢琴').length > 0 && filterVoices('钢琴').every((v) => v.label.includes('钢琴')),
    JSON.stringify(filterVoices('钢琴').map((v) => v.label)))
  check('③ 勾选运算：单个切换 / 去重排序 / 丢弃非法 program',
    toggleVoice([0], 1).join(',') === '0,1' &&
      toggleVoice([0, 1], 0).join(',') === '1' &&
      normalizeVoices([5, 5, 200, -1, 3, 5.5]).join(',') === '3,5',
    `${toggleVoice([0], 1)} | ${normalizeVoices([5, 5, 200, -1, 3, 5.5])}`)
  check('③ 全选 / 全消 / 反选（反选两次回到原集合）',
    selectAllVoices().length === 128 && clearVoices().length === 0 &&
      invertVoices(invertVoices([0, 10])).join(',') === '0,10',
    `${invertVoices([0, 10]).length}`)
  check('③ 整组选 / 消：只动本类（首类 0-7），其它类的勾选原样保留',
    setGroupVoices([100], [0, 7], true).length === 9 &&
      selectedInGroup(setGroupVoices([100], [0, 7], true), [0, 7]) === 8 &&
      setGroupVoices(setGroupVoices([100], [0, 7], true), [0, 7], false).join(',') === '100',
    `${setGroupVoices([100], [0, 7], true).length}`)
  check('④ 摘要文案「已选 N / 128」随勾选变化',
    voiceSummary([0, 1, 1, 999]) === '已选 2 / 128', voiceSummary([0, 1, 1, 999]))

  // ---- ⑤ 与预览页面同步：`changedDefs` 只认"真正改动过的项" ----
  // 复现用户场景：这份谱的**生效值**来自 frontmatter / 源内 # jps-config（与插件默认不同）
  const effective: PageConfig = { ...defaultPageConfig, note_size: 17, margin_left: 60, segmentRowGap: { bz: 30, dsb: 22, tp: 14 } }
  check('⑤a 打开对话框后**什么都没改** ⇒ 没有"改动项"（旧实现会把整份生效值写成全库默认）',
    changedDefs(effective, { ...effective }).length === 0,
    JSON.stringify(changedDefs(effective, { ...effective }).map((d) => d.key)))
  const edited: PageConfig = { ...effective, note_size: 15, segmentRowGap: { bz: 30, dsb: 22, tp: 20 } }
  const changed = changedDefs(effective, edited).map((d) => (d.sub ? `${String(d.key)}.${d.sub}` : String(d.key))).sort()
  check('⑤b 只改两项 ⇒ 只有这两项算改动（嵌套字段 `segmentRowGap.tp` 也能识别）',
    changed.join(',') === 'note_size,segmentRowGap.tp', changed.join(','))
  check('⑤c 等于引擎默认的改动**不写进插件设置**（保持稀疏；可选布尔字段的 false/未设置都算默认）',
    isDefaultValue({ key: 'note_size', label: '', type: 'number', group: '字体' }, 13) &&
      !isDefaultValue({ key: 'note_size', label: '', type: 'number', group: '字体' }, 15) &&
      isDefaultValue({ key: 'showInstrument', label: '', type: 'toggle', group: '渲染' }, false) &&
      isDefaultValue({ key: 'showInstrument', label: '', type: 'toggle', group: '渲染' }, undefined) &&
      isDefaultValue({ key: 'segmentRowGap', sub: 'tp', label: '', type: 'number', group: '行距' }, 14) &&
      !isDefaultValue({ key: 'segmentRowGap', sub: 'tp', label: '', type: 'number', group: '行距' }, 20),
    '')
  check('⑤d 插件设置里的默认逐项来自引擎（`getDefault`）',
    getDefault({ key: 'note_size', label: '', type: 'number', group: '字体' }) === defaultPageConfig.note_size &&
      getDefault({ key: 'segmentRowGap', sub: 'bz', label: '', type: 'number', group: '行距' }) === SEGMENT_ROW_GAP_DEFAULT.bz)

  // ---- ⑥ 源码级：多页签 + 流式分类列表 + 两处同步接线 ----
  const settingsSrc = String(readFileSync('src/settings.ts', 'utf8'))
  const mainSrc = String(readFileSync('src/main.ts', 'utf8'))
  const paneSrc = String(readFileSync('src/scorePane.ts', 'utf8'))
  const cssSrc = String(readFileSync('styles.css', 'utf8'))
  /**
   * adj724b（用户实测反馈 #3，口径变更）：设置页签从 7 个**收敛为 2 个**——
   * 「嵌入版」+「说明」。用户要求"只开一处"：排版/音色设置统一在**嵌入版 iJipu** 里改，
   * 插件侧不再重复提供（否则两处值不一致，且要改两遍）。
   * 本断言按**新口径**更新（不是放宽）：钉住"只剩这两页、且顺序如此"，
   * 并**反向**钉住那四类排版页签与音色库页签**不再出现**（防止有人又加回来）。
   */
  check('⑥a 设置面板只剩「嵌入版」「说明」两页（排版/音色统一在嵌入版 iJipu 里改）', 
    /SETTINGS_TABS: SettingsTabId\[\] = \['嵌入版', '说明'\]/.test(settingsSrc) &&
      /ijipu-settings-tabs/.test(settingsSrc) && /ijipu-settings-tab/.test(cssSrc))
  /**
   * adj724b（用户要求）：**「打开 .jps 的方式」下拉**——四种方式齐全，且**默认是"右侧栏"**。
   *
   * 用户原话：「在嵌入版页签中添加一个下拉列表选择，默认打开方式，添加以下几个打开方式选择：
   * ① 右侧栏 ② 新的页签 ③ 当前页签 ④ 默认应用；并实现相应的打开方式，**默认选择为右侧栏**」。
   * 断言覆盖：① 四种选项都在下拉里；② 默认值常量为 `'right'`；
   * ③ 四种方式在 `openIjipuFile`/`openEmbedLeaf` 里都真的有对应实现（不是只加了个下拉）。
   */
  check('adj724b 「打开 .jps 的方式」下拉有四种方式，默认「右侧栏」，且四种都真的有实现',
    /addOption\('right', '右侧栏（默认）'\)/.test(settingsSrc) &&
      /addOption\('tab', '新的页签'\)/.test(settingsSrc) &&
      /addOption\('current', '当前页签'\)/.test(settingsSrc) &&
      /addOption\('defaultApp', '默认应用（仅桌面端）'\)/.test(settingsSrc) &&
      settingsSrc.includes('?? DEFAULT_EMBED_OPEN_MODE') &&
      /DEFAULT_EMBED_OPEN_MODE: EmbedOpenMode = 'right'/.test(String(readFileSync('src/types.ts', 'utf8'))) &&
      /openIjipuFile\(file: TFile \| null, sourceLeaf: WorkspaceLeaf \| null = null\): Promise<void>/.test(mainSrc) &&
      // `defaultApp` 分支里夹着"非桌面端 ⇒ 提示并改走右侧栏"的回退，窗口给足
      // adj727：判据已抽成纯函数 `embedEditLeavesObsidian`（同一口径也用于"嵌入区要不要留链接"）
      /embedEditLeavesObsidian\(mode\)[\s\S]{0,460}?openWithDefaultApp\(/.test(mainSrc) &&
      // 三种嵌入方式各自走对应的 API（"开在哪里"的判定已抽到纯函数，见下面的组合断言）
      /workspace\.getRightLeaf\(false\)/.test(mainSrc) &&
      /workspace\.getLeaf\('tab'\)/.test(mainSrc) &&
      /getMostRecentLeaf\(workspace\.rootSplit\)/.test(mainSrc) &&
      /planEmbedTarget\(mode, sourceLeaf !== null\)/.test(mainSrc))
  /**
   * adj724b（用户实测 ①②）：「点 `.jps` 只展开了右栏/切了页签，但应用里没打开那份谱」。
   *
   * 根因：原先靠 `ViewState.state` 的令牌让 `onOpen()` 去取"要打开的文件"，
   * 而这依赖"`setViewState()` 会重建视图"这个**不成立的假设**——
   * **复用同一个 leaf 时 Obsidian 不重建视图**，`onOpen` 不再跑 ⇒ 令牌没人读。
   *
   * 断言：打开路径必须是"**拿到视图实例直接驱动**"，且视图侧要**等 iframe 就绪**
   * （`setViewState()` 返回时 `onOpen` 可能还没跑完，不等就会静默丢掉这一次打开）。
   */
  {
    const appViewSrc = String(readFileSync('src/embed/appView.ts', 'utf8'))
    const bridgeSrc2 = String(readFileSync('src/embed/bridge.ts', 'utf8'))
    check('adj724b 打开 `.jps` 由"直接驱动视图实例"完成（不依赖 setViewState 重建视图），且视图等待 iframe 就绪',
      /const view = target\.view as unknown as \{ openFile\?:/.test(mainSrc) &&
        /await view\.openFile\(file\.path\)/.test(mainSrc) &&
        // 视图侧：openFile 先 await frameReady（否则 this.frame 还是 null ⇒ 这一次打开被丢掉）
        /async openFile\(path: string\): Promise<void> \{[\s\S]{0,200}?await this\.frameReady/.test(appViewSrc) &&
        // 桥：应用就绪后可直接推
        /openFile\(frame: HTMLIFrameElement, path: string\): void \{[\s\S]{0,300}?info\.ready[\s\S]{0,140}?emitTo\(frame, 'openFile'/.test(
          bridgeSrc2,
        ) &&
        // 未就绪则记下来，`ready` 时补发
        /if \(info\.ready\) \{[\s\S]{0,160}?info\.pendingOpen = path/.test(bridgeSrc2))
  }
  /**
   * adj724b：「打开 `.jps` 的方式 → 开在哪里」——**直接跑纯函数**断言全部组合。
   *
   * 为什么改成跑函数：这段规则是用户可见行为，此前只对 `main.ts` 做**字符串匹配**，
   * 结果每轮改实现断言就断（且注释里写同样的字还会误判）；
   * 更糟的是——用户实测「当前页签没生效」时，**没有任何断言能跑它**。
   * 抽成 `embed/openPlan.ts` 的 `planEmbedTarget()` 之后，四方式 × 有/无来源页签 全部可断言。
   */
  {
    // 由 `.jps` 文件视图路由而来（有"用户点开的那个页签"）
    check('adj724b 打开方式（有来源页签）：当前页签=**就地替换**且不关；新页签=另开并关掉中间页签；右栏=右栏并关掉中间页签',
      planEmbedTarget('current', true).kind === 'replace-source' &&
        planEmbedTarget('current', true).detachSource === false &&
        planEmbedTarget('tab', true).kind === 'new-tab' &&
        planEmbedTarget('tab', true).detachSource === true &&
        planEmbedTarget('right', true).kind === 'right-sidebar' &&
        planEmbedTarget('right', true).detachSource === true,
      JSON.stringify({
        current: planEmbedTarget('current', true),
        tab: planEmbedTarget('tab', true),
        right: planEmbedTarget('right', true),
      }))
    // 没有来源页签（点侧栏图标打开应用）⇒ 不该关任何页签
    check('adj724b 打开方式（无来源页签）：当前页签=主编辑区最近页签；新页签=新页签；右栏=右栏；都不关页签',
      planEmbedTarget('current', false).kind === 'replace-source' &&
        planEmbedTarget('tab', false).kind === 'new-tab' &&
        planEmbedTarget('right', false).kind === 'right-sidebar' &&
        [planEmbedTarget('current', false), planEmbedTarget('tab', false), planEmbedTarget('right', false)].every(
          (p) => p.detachSource === false,
        ))
    // ⚠ 关键回归：**「新页签」与「当前页签」必须是两个不同的动作**。
    // 用户实测的 bug 就是"两者都开在新页签"⇒ 这一条直接钉住它们的差别。
    check('adj724b 「新页签」与「当前页签」是两个不同动作（此前两者的效果一样 ⇒ 用户报"当前页签没生效"）',
      planEmbedTarget('current', true).kind !== planEmbedTarget('tab', true).kind &&
        planEmbedTarget('current', true).kind === 'replace-source' &&
        planEmbedTarget('tab', true).kind === 'new-tab' &&
        // 「当前页签」不得把来源页签关掉（它变成了 iJipu 本身）
        planEmbedTarget('current', true).detachSource === false)
    // 同一模式下"有/无来源页签"的差别只在"要不要关中间页签"（位置规则一致）
    check('adj724b 打开方式：位置只由模式决定（有/无来源页签不改变开在哪里）',
      (['current', 'tab', 'right'] as const).every(
        (m) => planEmbedTarget(m, true).kind === planEmbedTarget(m, false).kind,
      ))
  }
  /**
   * adj724b（用户实测 #2）：「在页签中打开 ijipu 时，页签名应显示**文件名**，而不是爱记谱」。
   *
   * 页签名来自视图的 `getDisplayText()`（`ViewState` 里**没有** `title` 字段，已核对 `obsidian.d.ts`）。
   */
  {
    const appViewSrc2 = String(readFileSync('src/embed/appView.ts', 'utf8'))
    check('adj724b 应用页签的标题：打开谱时显示文件名、没打开时显示「爱记谱」',
      /getDisplayText\(\): string \{[\s\S]{0,200}?return this\.activeFileName \?\? DISPLAY_TEXT/.test(appViewSrc2) &&
        /private activeFileName: string \| null = null/.test(appViewSrc2) &&
        /setActiveFileName\(name: string \| null\)/.test(appViewSrc2) &&
        // `openFile()` 里要把文件名记下来（否则标题永远停在「爱记谱」）
        /async openFile\(path: string\): Promise<void> \{[\s\S]{0,200}?setActiveFileName\(path\.split\('\/'\)\.pop\(\)/.test(appViewSrc2))
  }
  /**
   * adj724b（用户要求）：「点文件列表的 `.jps` **不要再出**那个『已在爱记谱中打开…』的页签，
   * 直接在 iJipu 打开即可」。
   *
   * 实现口径：文件视图负责**路由 + 关掉自己这个中间页签**（`leaf.detach()`），
   * 但「当前页签」模式下**不能关**（被替换的就是它自己）。
   */
  {
    const viewSrc = String(readFileSync('src/fileView.ts', 'utf8'))
    check('adj724b/adj773 点 `.jps` 不再"中转进嵌入版"：原生预览直出；`routeToIjipu` 仅供「编辑」调用（仍交出本页签）',
      /private routeToIjipu\(file: TFile\): void \{/.test(viewSrc) &&
        // 关键：把 `this.leaf` 交出去 —— 「当前页签」靠它做就地替换，而不是靠猜
        /await this\.plugin\.openIjipuFile\(file, this\.leaf\)/.test(viewSrc) &&
        // 关页签的判断已收到插件的纯函数计划里（`plan.detachSource`），视图不再自己判断
        !/this\.leaf\.detach\(\)/.test(viewSrc) &&
        // 一个文件只路由一次（视图重画不该反复跳）；但「编辑」按钮每次都会先重置它 ⇒ 每次点都生效
        /if \(this\.embedRoutedFor === file\.path\) return/.test(viewSrc) &&
        /**
         * adj773：中转页（"正在打开…" + "用源码视图编辑"按钮）整块删除 —— 点文件不再跳嵌入版。
         * ⚠ 负向判据先**剥注释**：文件里保留了一句"已删除 renderEmbedPlaceholder"的说明，
         * 直接搜整份源码会被自己的注释绊倒（仓库里记过的坑，见 E-2026-237 与 adj734/adj736）。
         */
        !/正在爱记谱（嵌入版）中打开/.test(viewSrc.replace(/\/\*[\s\S]*?\*\//g, '')) &&
        !/renderEmbedPlaceholder/.test(viewSrc.replace(/\/\*[\s\S]*?\*\//g, '')))
    // 插件侧：按计划关掉中间页签（`plan.detachSource`），且"就地替换"时不关
    check('adj724b 插件按计划关掉中间页签（`plan.detachSource`），就地替换时不动它',
      /await this\.plugin\.openIjipuFile\(file, this\.leaf\)/.test(viewSrc) &&
        /if \(plan\.detachSource && !isSameLeaf && sourceLeaf\)/.test(mainSrc) &&
        /sourceLeaf\.detach\(\)/.test(mainSrc))
  }
  /**
   * adj724b：原「收藏音色」页签（`renderVoiceList` 流式分类列表）**已随设置整并删除**。
   *
   * 这里不再断言它存在，而是断言**它确实不在了**——音色选择只保留在嵌入版 iJipu 里
   * （用户要求"只开一处"）。样式类 `.ijipu-voice-*` 仍留在 `styles.css`（嵌入版目前用自己的样式，
   * 插件侧这套已无消费者，后续可清理，但删样式不属于本次范围）。
   */
  check('⑥b 插件侧不再有「收藏音色」设置页（音色统一在嵌入版 iJipu 里改）',
    // 先**剥注释**再查：文件头的历史说明里会提到这两个标识符（同 E-2026-237 的坑）
    !/renderVoiceList/.test(settingsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')) &&
      !/ijipu-voice-groups/.test(settingsSrc))
  check('⑥c 「保存为插件默认」只写改动项（`changedDefs` + 等于默认则删除该键），不再整份覆盖',
    /changedDefs\(resolved\.config, next\)/.test(paneSrc) && /isDefaultValue\(def, src\[k\]\)\) delete bag\[k\]/.test(paneSrc) &&
      !/for \(const def of DEFS\) bag\[def\.key as string\] = src\[def\.key as string\]/.test(paneSrc))
  check('⑥d 别处改插件设置 ⇒ 设置页签就地重画（页签自己改的不重画，避免打断输入焦点）',
    /registerSettingsRefresh/.test(settingsSrc) && /registerSettingsRefresh/.test(mainSrc) &&
      /from !== 'settingsTab'/.test(mainSrc) && /saveSettings\(\{ from: 'settingsTab' \}\)/.test(settingsSrc))
  check('⑥e 对话框写清"生效值 ≠ 本库全局默认"（用户报两边不同步的口径说明）',
    /这一份谱的生效值/.test(String(readFileSync('src/configDialog.ts', 'utf8'))))

  // ---- ⑦ 用户要求（插件侧 UI）：排版对话框**页签化** + 「未随谱携带 N 项」从工具条移入对话框 ----
  const dlgSrc = String(readFileSync('src/configDialog.ts', 'utf8'))
  // 断言前先剥注释：注释里**故意写了**被禁用的旧写法/说明（同 E-2026-237 的坑）
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const paneCode = stripComments(paneSrc)
  check('⑦a 排版对话框按页签组织（页面/字体/行距/渲染 + 说明，与设置页签同款样式）',
    /readonly tabs = \[\.\.\.GROUPS, '说明'\]/.test(dlgSrc) &&
      /ijipu-config-tabs/.test(dlgSrc) && /ijipu-settings-tab/.test(dlgSrc) &&
      /toggleClass\('is-active'/.test(dlgSrc) && /\.ijipu-config-tabs \{/.test(cssSrc),
    `tabs=${/readonly tabs = \[\.\.\.GROUPS, '说明'\]/.test(dlgSrc)} cls=${/ijipu-config-tabs/.test(dlgSrc)}`)
  /**
   * ⑦b adj738：原来这里守的是「未随谱携带 N 项」从工具条搬进对话框、以及它与
   * 「谱面自带设置 N 项」的上下顺序。**笔记 frontmatter 层整体删除后，"未随谱携带"的来源恒为空**
   * （插件设置那一层被当作本库默认、不算未携带）⇒ 该块连同 `carryover` 选项一起删除。
   * 现在要守的口径相反：**它不该再出现在任何地方**（防止有人把死代码/死提示又加回来）。
   */
  check('⑦b 「未随谱携带」提示与 carryover 传参已彻底移除（来源随 frontmatter 层一起消失）',
    !/未随谱携带/.test(paneCode) &&
      !/未随谱携带/.test(stripComments(dlgSrc)) &&
      !/carryover/.test(paneCode) &&
      !/carryover/.test(stripComments(dlgSrc)),
    `pane 残留=${/未随谱携带/.test(paneCode)} 对话框有=${/未随谱携带/.test(stripComments(dlgSrc))}`)
  // 页签化后不能有字段"点不到"：DEFS 里每个 group 都必须是 GROUPS 的一员，且四组都有项
  {
    const defsSrc7 = String(readFileSync('src/defs.ts', 'utf8'))
    const rows = [...defsSrc7.matchAll(/\{\s*group:\s*'([^']+)',\s*key:\s*'([^']+)'/g)].map((m) => m[1])
    const groups = [...new Set(rows)]
    const declared = (defsSrc7.match(/GROUPS = \[([^\]]*)\]/)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
    check('⑦d 页签化后没有字段被"藏起来"：DEFS 的每个 group 都在 GROUPS 里，且四组都有项',
      groups.every((g) => declared.includes(g)) && declared.length === 4 && declared.every((g) => groups.includes(g)),
      `DEFS 组=${groups.join('/')} GROUPS=${declared.join('/')}`)
  }

  // ---- ⑧ 用户要求（插件侧 UI）：排版对话框**固定大小** + 页签内容滚动 + 底部按钮常驻可见 ----
  check('⑧a 对话框固定大小（宽 + 高都定死，不再是随内容长高矮的 560px 宽）',
    /\.ijipu-config-modal \{[\s\S]*?width: min\(720px, 94vw\);[\s\S]*?height: min\(82vh, 720px\);/.test(cssSrc) &&
      /\.ijipu-config-modal \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/.test(cssSrc))
  check('⑧b 内容区不再自己滚（`overflow: hidden`）——只让页签内容区滚，顶部提示与按钮组不动',
    /\.ijipu-config-modal \.modal-content \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/.test(cssSrc) &&
      !/\.ijipu-config-modal \.modal-content \{[\s\S]*?max-height: 70vh/.test(cssSrc))
  check('⑧c 页签内容区提供滚动（`flex:1` + `overflow-y: auto`）⇒「页面」等长页签一次看到更多',
    /\.ijipu-config-panel \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/.test(cssSrc))
  check('⑧d 按钮组常驻对话框底部（`flex: 0 0 auto`），页签栏同样固定在滚动区上方',
    /\.ijipu-config-footer \{[\s\S]*?flex: 0 0 auto;/.test(cssSrc) &&
      /\.ijipu-config-tabs \{[\s\S]*?flex: 0 0 auto;/.test(cssSrc) &&
      /\.ijipu-config-src \{[\s\S]*?flex: 0 1 auto;[\s\S]*?max-height: 32%;[\s\S]*?overflow-y: auto;/.test(cssSrc))
  check('⑧e 页面元素顺序 = 顶部提示 → 信息卡 → 页签栏 → 内容区 → 按钮组（滚动区在按钮组之上）',
    dlgSrc.indexOf("cls: 'ijipu-config-tabs'") < dlgSrc.indexOf("cls: 'ijipu-config-panel'") &&
      dlgSrc.indexOf("cls: 'ijipu-config-panel'") < dlgSrc.indexOf("cls: 'ijipu-config-footer'"))
}

console.log('[3d] adj629q 段层虚线与应用同口径（拖 bz/dsb/tp 改 segmentRowGap.*，不是谱面行距）')
{
  const src =
    'V: 1.0\nB: t\nD: C\nP: 4/4\n' +
    'Q: |: 1 2 3 4 | 5 6 7 1 :|\n' +
    'C: 一 二 三 四 五 六 七 八\n' +
    "C2: 一 二 {tp 1' 2'} 三 四 五 六 七\n" +
    'Q: 3 4 | {bz 1 2 3 4} 5 6 7 1 |\n' +
    'Q: 3 4 | {dsb 1 2 3 4} 5 6 7 1 |\n'
  const lay = layoutScore(parseJps(src), defaultPageConfig)
  const lines = computeGuideLines(lay, defaultPageConfig, 0)
  const seg = lines.filter((l) => l.kind === 'segment')
  const keys = [...new Set(seg.map((l) => l.key))]
  check('段层虚线用 `segmentRowGap_*` 键（bz / dsb / tp 都认），不是 `height_ciqu*`',
    keys.includes('segmentRowGap_bz') && keys.includes('segmentRowGap_dsb') && keys.includes('segmentRowGap_tp') &&
      seg.every((l) => l.key.startsWith('segmentRowGap_')),
    JSON.stringify(keys))
  check('段层“上层”虚线 `invert`（往上拖 = 增大间距，与应用同口径）',
    seg.filter((l) => l.key !== 'segmentRowGap_dsb').every((l) => l.invert === true) &&
      seg.some((l) => l.key === 'segmentRowGap_dsb'),
    JSON.stringify(seg.map((l) => `${l.key}:${l.invert}`)))
  check('段层虚线有专门的 kind="segment"（宿主据此换紫色，与应用观感一致）',
    lines.some((l) => l.kind === 'segment'))
  check('`segmentRowGap_*` 的范围取自引擎表（可与虚线拖拽范围互校）',
    guideLimits('segmentRowGap_tp')[0] === GUIDE_LIMITS_EX.segmentRowGap_tp[0] &&
      guideLimits('segmentRowGap_tp')[1] === GUIDE_LIMITS_EX.segmentRowGap_tp[1])
  // 拖拽写回必须落到子对象（不能写成顶层 `segmentRowGap_bz` 字段——引擎不认那个键）
  const paneSrc = String(readFileSync('src/scorePane.ts', 'utf8'))
  check('拖拽写回落到 `segmentRowGap` 子对象（含落盘提示取值）',
    /segmentRowGap: \{ \.\.\.\(cur\.segmentRowGap \?\? \{\}\), \[segKey\]: value \}/.test(paneSrc) &&
      /const segKey = line\.key\.startsWith\('segmentRowGap_'\)/.test(paneSrc))
}

console.log('[3e] adj629s 「恢复默认」用引擎的 defaultConfigForReset（清掉可选字段）')
{
  const reset = defaultConfigForReset()
  check('引擎 `defaultConfigForReset()` 不含可选字段、差量写入为空',
    OPTIONAL_CONFIG_FIELDS.every((k) => !(k in (reset as unknown as Record<string, unknown>))) &&
      nonDefaultConfigKeys(reset).length === 0,
    JSON.stringify(nonDefaultConfigKeys(reset)))
  const withMeta = 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 2 3 4 |\n\n# jps-config:{"metaPos":{"keyline":{"x":0,"y":-21}}}\n'
  const saved = writeJpsConfig(withMeta, reset)
  check('恢复默认后保存：设置行**清空为 `# jps-config:{}`**（不再含 metaPos，也不整行消失）',
    saved.split('\n').filter((l) => l.startsWith('# jps-config')).join('|') === '# jps-config:{}' && !saved.includes('metaPos'),
    saved.split('\n').find((l) => l.startsWith('# jps-config')) ?? '(无)')
  // 「⚙ 排版」对话框的「恢复默认」必须走同一份（直接展开 defaultPageConfig 会留下可选字段）
  // 先剥注释再断言：注释里**故意写了**要禁用的旧写法（同 E-2026-237 的坑）
  const dlgFlat = String(readFileSync('src/configDialog.ts', 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  check('插件的「恢复默认」用 `defaultConfigForReset()`，不再 `{ ...defaultPageConfig }`',
    /defaultConfigForReset\(\)/.test(dlgFlat) && !/\{ \.\.\.defaultPageConfig \}/.test(dlgFlat))
}

/**
 * adj738：原来这里还有三节 ——
 *  [4] 未识别的 frontmatter 键给出"最近键名建议"（`unknownKeyHint`）
 *  [5] 非业务键（`position`/`aliases`/`tags`）不误判 + frontmatter > 插件设置 的优先级
 *  [6] 键名映射与全字段命中 + 「复制最小/完整模板」的 include 过滤器（`buildFrontmatterTemplate`）
 * 全随"笔记 frontmatter 层"删除而删除。现在写错键只可能发生在**谱面源码的 `# jps-config`** 里，
 * 那由引擎的解析告警照常提示（见本套件的 [11] 解析问题分级）。
 */

console.log('[7] 谱面自带设置 # jps-config 优先级最高（阶段 1：复制 iJipu 的 .jps 即一模一样）')
{
  const SRC = 'V: 1.0\nB: 探针\nD: G\nP: 4/4\nJ: 90\n\nQ: | 6,--- &ykh ||\n'
  // 模拟 iJipu「保存设置」：把整份配置写进源码 # jps-config 行
  const withCfg = writeJpsConfig(SRC, {
    ...defaultPageConfig,
    note_size: 15,
    margin_left: 32,
    noteSpaceLayout: 'duration',
    lianyinxian_type: 2,
    showInstrument: true,
    lyricShrink: true,
  })
  const r = resolvePageConfig(withCfg, { note_size: 99, margin_left: 99 })
  check('源内设置 > 插件设置（note_size=15）', r.config.note_size === 15, String(r.config.note_size))
  check('源内设置生效（margin_left=32 / noteSpaceLayout=duration / lianyinxian_type=2）', r.config.margin_left === 32 && r.config.noteSpaceLayout === 'duration' && r.config.lianyinxian_type === 2)
  check('源内可选字段往返保真（showInstrument/lyricShrink=true）', r.config.showInstrument === true && r.config.lyricShrink === true, `${r.config.showInstrument}/${r.config.lyricShrink}`)
  // adj738：源内没写的键 ⇒ 由**插件设置**兜底（笔记 frontmatter 那一层已删除）
  check('源内没写的键由插件设置兜底（margin_right=40）', resolvePageConfig(withCfg, { margin_right: 40 }).config.margin_right === 40)
  // 源内写了的键优先级最高（差量写入：源内只含与默认不同的项）
  const srcWins = resolvePageConfig(writeJpsConfig(SRC, { ...defaultPageConfig, margin_left: 32 }), { margin_left: 99 })
  check('源内写了的键 > 插件设置（margin_left 用源内 32，而非 99）', srcWins.config.margin_left === 32, String(srcWins.config.margin_left))
  // 源内只写部分键（手写的最小设置行）→ 其余键交给插件设置
  const partial = `${SRC}\n# jps-config:{"note_size":15}\n`
  const rp = resolvePageConfig(partial, { margin_right: 40 })
  check('源内只写部分键时，其他键由插件设置生效（margin_right=40）', rp.config.margin_right === 40, String(rp.config.margin_right))
  check('源内部分设置里的键仍最高优先（note_size=15）', rp.config.note_size === 15, String(rp.config.note_size))
  check('源内没写 → 插件设置生效（bar_gap）', resolvePageConfig(SRC, { bar_gap: 7 }).config.bar_gap === 7)
  check('sourceFields 报告源内生效字段数（差量写入⇒只含非默认项）且含 showInstrument', r.sourceFields.length >= 5 && r.sourceFields.includes('showInstrument'), `${r.sourceFields.length}:${r.sourceFields.join(',')}`)
  check('无源内设置时 sourceFields 为空', resolvePageConfig(SRC, {}).sourceFields.length === 0)
  check('无源内设置时行为与此前一致（插件设置 > 默认）', resolvePageConfig(SRC, { note_size: 20 }).config.note_size === 20)
  check('源内设置行不影响解析（仍是 1 个曲行、无错误）', resolvePageConfig(withCfg, {}).config.note_size === 15)
  // 端到端等价性：同一份 .jps（含设置行）在两端解析出的配置应完全一致
  const dst = resolvePageConfig(withCfg, {}).config
  const appSide = { ...defaultPageConfig, ...(JSON.parse(withCfg.split('\n').find((l) => l.startsWith('# jps-config:'))!.slice('# jps-config:'.length)) as object) }
  const diff = Object.keys(appSide).filter((k) => JSON.stringify((dst as unknown as Record<string, unknown>)[k]) !== JSON.stringify((appSide as unknown as Record<string, unknown>)[k]))
  check('端到端：插件解析结果与 iJipu 源内配置逐字段一致（无一差异）', diff.length === 0, diff.join(','))
}

console.log('[8] 写回源码的纯函数（阶段 2：「⚙ 排版」保存到谱面用）')
{
  const note = ['# 标题', '', '```jps', 'V: 1.0', 'Q: 1 2 3 4 |', '```', '', '后记'].join('\n')
  // 开栅栏在第 2 行（0 基），闭栅栏在第 5 行
  const out = replaceCodeBlockBody(note, 2, 5, 'V: 1.0\nQ: 5 5 5 5 |\n# jps-config:{"note_size":15}\n')
  const lines = out.split('\n')
  check('替换后围栏保持（第 3 行仍是 ```jps）', lines[2] === '```jps', lines[2])
  check('正文被替换为新源码（含 # jps-config 行）', lines[3] === 'V: 1.0' && lines[4] === 'Q: 5 5 5 5 |' && lines[5].startsWith('# jps-config:'), lines.slice(3, 6).join(' / '))
  check('闭栅栏与后文未被破坏', lines[6] === '```' && lines[7] === '' && lines[8] === '后记', lines.slice(6, 9).join(' / '))
  check('行数收敛：末尾多余空行被归一（不含连续两个空行）', !out.includes('\n\n\n'), JSON.stringify(out))
  check('区间非法时原样返回（不写坏笔记）', replaceCodeBlockBody(note, 5, 2, 'x') === note)
  check('越界行号原样返回', replaceCodeBlockBody(note, 2, 99, 'x') === note)
  const body = codeBlockBody(note, 2, 5)
  check('取回原代码块正文', body === 'V: 1.0\nQ: 1 2 3 4 |', JSON.stringify(body))
  check('取正文：区间非法返回 null', codeBlockBody(note, 5, 2) === null)
  // CRLF 归一
  const crlf = replaceCodeBlockBody('a\r\n```jps\r\nQ: 1 |\r\n```\r\nb', 1, 3, 'Q: 2 |')
  check('CRLF 输入的写回结果不含回车符', !crlf.includes('\r') && crlf.includes('Q: 2 |'), JSON.stringify(crlf))
  // 链接路径判定（![[xxx.jps]] / [[xxx.jps#标题]] / [[xxx.jps|别名]]）
  check('jpsLinkpath 识别 xxx.jps', jpsLinkpath('xxx.jps') === 'xxx.jps')
  check('jpsLinkpath 去掉 #子标题', jpsLinkpath('子目录/我的谱.jps#第2段') === '子目录/我的谱.jps')
  check('jpsLinkpath 去掉 |别名与尺寸', jpsLinkpath('a/谱.jps|别名') === 'a/谱.jps')
  check('jpsLinkpath 大小写不敏感', jpsLinkpath('X.JPS') === 'X.JPS')
  check('jpsLinkpath 非 jps 返回 null', jpsLinkpath('笔记.md') === null && jpsLinkpath('图.png|200') === null)
}

console.log('[9] 排版辅助虚线的几何（纯逻辑：线集合/位置/范围/拖拽换算）')
{
  const src = ['V: 1.0', 'B: t', 'D: C', 'P: 4/4', '', 'Q: 1 2 3 4 |', 'C: 一 二 三 四', ''].join('\n')
  const r = parseJps(src)
  const cfg = { ...defaultPageConfig }
  const lay = layoutScore(r, cfg)
  const page = lay.pages[0]
  const lines = computeGuideLines(lay, cfg, 0)
  const byKind = (k: string) => lines.filter((l) => l.kind === k)
  const find = (kind: string, key: string) => lines.find((l) => l.kind === kind && l.key === key)

  check('四边距虚线齐备', byKind('margin').length === 4, String(byKind('margin').length))
  const mt = find('margin', 'margin_top')
  const mb = find('margin', 'margin_bottom')
  const ml = find('margin', 'margin_left')
  const mr = find('margin', 'margin_right')
  check('上边距线 y = margin_top', mt?.pos === cfg.margin_top, String(mt?.pos))
  check('下边距线 y = page.height − margin_bottom', mb?.pos === page.height - cfg.margin_bottom, String(mb?.pos))
  check('左边距线 x = margin_left', ml?.pos === cfg.margin_left, String(ml?.pos))
  check('右边距线 x = page.width − margin_right', mr?.pos === page.width - cfg.margin_right, String(mr?.pos))
  check('上下线为水平虚线（dir=v，跨整页宽）', mt?.dir === 'v' && mt.from === 0 && mt.to === page.width)
  check('左右线为竖直虚线（dir=h，跨整页高）', ml?.dir === 'h' && ml.from === 0 && ml.to === page.height)
  check('下/右线 invert（拖动方向相反）', mb?.invert === true && mr?.invert === true && mt?.invert === undefined)

  const desc = find('desc', 'descAreaH')!
  check('描述头下沿线 y = margin_top + descAreaH', desc.pos === cfg.margin_top + cfg.descAreaH, String(desc.pos))
  check('描述头线只跨内容区（不跨页边距）', desc.from === cfg.margin_left && Math.abs(desc.to - (page.width - cfg.margin_right)) < 1e-6)
  check('描述头中线为纯标注（不可拖）', lines.some((l) => l.kind === 'desc' && l.readonly === true && l.dir === 'h'))

  const row = byKind('row')
  check('有曲部行虚线', row.length >= 1, String(row.length))
  check('第 1 行曲部线拖 body_margin_top', row[0]?.key === 'body_margin_top', String(row[0]?.key))
  check('有歌词时存在词部行虚线（第 1 行拖 height_quci）', byKind('lyric').length >= 1 && byKind('lyric')[0]?.key === 'height_quci', String(byKind('lyric')[0]?.key))
  check('行/词虚线均为水平线且跨内容区', [...row, ...byKind('lyric')].every((l) => l.dir === 'v' && l.from === cfg.margin_left))

  check('可调范围：边距 [20,400]', JSON.stringify(guideLimits('margin_left')) === '[20,400]', JSON.stringify(guideLimits('margin_left')))
  check('可调范围：descAreaH [40,400]', JSON.stringify(guideLimits('descAreaH')) === '[40,400]', JSON.stringify(guideLimits('descAreaH')))
  check('可调范围：允许负值的 height_ciqu_lyric [-80,120]', JSON.stringify(guideLimits('height_ciqu_lyric')) === '[-80,120]', JSON.stringify(guideLimits('height_ciqu_lyric')))

  // 显示模式裁剪框 + 百分比定位 + 拖拽换算
  const full = cropRectFor('page', cfg, page.width, page.height)
  check('整页模式裁剪框 = 整页', full.x === 0 && full.y === 0 && full.w === page.width && full.h === page.height)
  const crop = cropRectFor('score', cfg, page.width, page.height)
  check('谱面模式裁剪框 = 内容区（裁掉四边距）', crop.x === cfg.margin_left && crop.y === cfg.margin_top && Math.abs(crop.w - (page.width - cfg.margin_left - cfg.margin_right)) < 1e-6, JSON.stringify(crop))
  const boxW = 600 // 假定显示宽 600px
  const placeFull = guidePlacement(ml!, full, page.width, page.height, boxW)
  check('整页下左边距线 left% = margin_left/页宽', Math.abs(parseFloat(placeFull.style.left) - (cfg.margin_left / page.width) * 100) < 0.01, placeFull.style.left)
  check('scale = 显示像素 / 页面单位', Math.abs(placeFull.scale - boxW / page.width) < 1e-9, String(placeFull.scale))
  const placeCrop = guidePlacement(ml!, crop, page.width, page.height, boxW)
  check('谱面模式下左边距线落在裁剪框左缘（0%）', Math.abs(parseFloat(placeCrop.style.left)) < 0.01, placeCrop.style.left)
  // 拖拽换算：在整页模式下把线向右拖「显示宽」的距离 = 页面宽（scale 换算自洽）
  const delta = dragDelta({ key: 'margin_left', dir: 'h' }, 0, 0, boxW, 0, placeFull.scale)
  check('拖拽换算：拖一个显示宽 = 一个页面宽', Math.abs(delta - page.width) < 1e-6, String(delta))
  const deltaInv = dragDelta({ key: 'margin_right', dir: 'h', invert: true }, 0, 0, boxW, 0, placeFull.scale)
  check('反向项（右边距）拖动方向取反', Math.abs(deltaInv + page.width) < 1e-6, String(deltaInv))
}

console.log('[10] 设置分层：编辑器偏好不再随谱 / 差量写入 / 字体 fallback（adj-font）')
{
  // ① adj738：原来这里核对"frontmatter 里的编辑器偏好旧键归入已降级"——
  //    笔记 frontmatter 层删除后，同类判断落在**引擎**侧：`extractLegacyEditorPrefs` 负责
  //    从**源码**里认出"写法合法但已不再随谱保存"的旧编辑器偏好键（引擎单测/冒烟已覆盖）。
  const legacy = extractLegacyEditorPrefs('V: 1.0\nQ: 1 |\n# jps-config:{"editorFont":"SimHei","editorFontSize":22}\n')
  check('引擎能从源码设置行里认出旧的编辑器偏好键（不再随谱保存）',
    legacy?.font === 'SimHei' && legacy?.fontSize === 22, JSON.stringify(legacy))
  check('编辑器偏好键不会再写进配置对象（本机偏好，不属于谱面）',
    !('editorFont' in (resolvePageConfig('Q: 1 |\n', {}).config as unknown as Record<string, unknown>)) &&
      !('editorFontSize' in (resolvePageConfig('Q: 1 |\n', {}).config as unknown as Record<string, unknown>)))

  // ② 差量写入：源内只记录与默认不同的项；全部默认则删除设置行
  const src = 'V: 1.0\nB: t\nD: G\nP: 4/4\nQ: 1 2 3 4 |\n'
  const changed = resolvePageConfig(src, { margin_left: 32 }).config
  const line = writeJpsConfig(src, changed).split('\n').find((l) => l.startsWith('# jps-config:')) ?? ''
  const written = JSON.parse(line.slice('# jps-config:'.length)) as Record<string, unknown>
  check('插件路径同样差量写入（只含 margin_left）', Object.keys(written).join(',') === 'margin_left', Object.keys(written).join(','))
  check('全部为默认时不写设置行', !writeJpsConfig(src, { ...defaultPageConfig }).includes('# jps-config:'))

  // ③ 字体：候选都以通用族兜底；旧谱面裸字体名读取时自动补 fallback
  //   （插件 defs.ts 的 FONTS 直接引用引擎 SCORE_FONT_OPTIONS，此处断言引擎目录即可）
  check(`插件字体候选（${SCORE_FONT_OPTIONS.length} 项）都以通用族兜底`, SCORE_FONT_OPTIONS.every((o) => /sans-serif|serif|monospace|system-ui/.test(o.value)), SCORE_FONT_OPTIONS.map((o) => o.label).join(','))
  const legacyFont = `V: 1.0\nB: t\nD: G\nP: 4/4\nQ: 1 2 3 4 |\n\n# jps-config:{"geci_font":"SimSun"}\n`
  check('旧谱面裸字体名（SimSun）读取时自动补 serif', resolvePageConfig(legacyFont, {}).config.geci_font === 'SimSun, serif', String(resolvePageConfig(legacyFont, {}).config.geci_font))
}

// ---- 10b. 分享保真：只写本次改动 vs 随谱固化（adj480；adj738 起只剩"插件设置"这一个本地层）----
console.log('[10b] 分享保真：本库默认层（插件设置）不随谱走（adj480）')
{
  const src = 'V: 1.0\nB: t\nD: G\nP: 4/4\nQ: 1 2 3 4 |\n'
  // 本库默认层：插件设置 note_size=15（源码里没写）
  const effective = resolvePageConfig(src, { note_size: 15 }).config
  // ① 用户只改了 height_quci 一项 → 「保存到谱面」只应写入这一项
  const next = { ...effective, height_quci: 21 }
  const edits = mergeConfigEdits(src, effective, next)
  check('adj480 保存到谱面：只含本次改动（不含插件设置带来的项）', Object.keys(edits).join(',') === 'height_quci', Object.keys(edits).join(','))
  const savedLine = writeJpsConfig(src, edits)
  check('adj480 保存到谱面后：本库层仍然生效（源码没写就还会兜底）', resolvePageConfig(savedLine, { note_size: 15 }).config.note_size === 15)
  // ② 分享保真检查：引擎口径（不传 baseline）会列出"非默认值但没随谱携带"的项
  const gap = configCarryover(savedLine, resolvePageConfig(savedLine, { note_size: 15 }).config)
  check('adj480 configCarryover 列出未随谱携带项（note_size）',
    !gap.ok && gap.missing.length === 1 && gap.missing.some((m) => m.key === 'note_size'),
    JSON.stringify(gap.missing))
  /**
   * ②b adj639/adj738：传 `baseline`（代码默认 ← **插件设置**）之后，**插件设置那一层不再算未随谱携带** ——
   * 它在用户眼里就是"本库默认值"，等价于应用里的代码默认值。
   * （adj738 之前这里还剩"笔记 frontmatter"那类差异；该层删除后，传 baseline 时结论就是**零提示**。）
   */
  {
    const res = resolvePageConfig(savedLine, { note_size: 15 })
    const withBase = configCarryover(savedLine, res.config, res.baseline)
    check('adj639 传 baseline 后：插件设置的项不再提示（已随本库默认携带）', withBase.ok, JSON.stringify(withBase.missing))
    check('adj639 baseline = 代码默认 ← 插件设置：note_size=15 在基线里',
      res.baseline.note_size === 15, `note_size=${res.baseline.note_size}`)
    // 用户的原始诉求：插件设置里有非默认值（含可选字段）而源码没写 ⇒ **零提示**
    const res2 = resolvePageConfig(src, { note_size: 15, align_min_bars: 3, showInstrument: true })
    const carry2 = configCarryover(src, res2.config, res2.baseline)
    check('adj639 插件设置（note_size / align_min_bars / showInstrument）≠ 引擎默认时也不提示（应用里正常的谱零提示）',
      carry2.ok, JSON.stringify(carry2.missing))
  }
  // ③ 「随谱固化」= 差量模式写**生效配置** → 非默认项全部落盘，且不再写成全量（不出现与默认相同的项）
  const solidified = writeJpsConfig(src, resolvePageConfig(savedLine, { note_size: 15 }).config)
  const solidLine = solidified.split('\n').find((l) => l.startsWith('# jps-config:')) ?? ''
  const solid = JSON.parse(solidLine.slice('# jps-config:'.length)) as Record<string, unknown>
  check('adj480 随谱固化：非默认项全部写入（含本库层带来的）',
    solid.note_size === 15 && solid.height_quci === 21,
    JSON.stringify(solid))
  check('adj480 随谱固化：与默认相同的项不写（仍是差量口径，不是全量 ~900 字符）',
    !('page' in solid) && !('margin_top' in solid) && !('align_min_bars' in solid),
    Object.keys(solid).join(','))
  check('adj480 固化后该谱自包含（换到 iJipu 应用也无缺口）',
    configCarryover(solidified, resolvePageConfig(solidified, {})).ok,
    JSON.stringify(configCarryover(solidified, resolvePageConfig(solidified, {})).missing))
}

// ---- 11. 解析问题分级：warning 不阻断渲染（adj394）----
console.log('[11] 解析问题分级（warning 不阻断）')
{
  // 引擎同时产出 error 与 warning；插件此前用 errors.length>0 判定失败 → 一条告警就整页不渲染
  const onlyWarn = parseJps('V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 2 3 < ! 4 5 6 |\n')
  const splitWarn = splitParseIssues(onlyWarn)
  check('仅告警的谱面：errors 为空（可正常渲染）', splitWarn.errors.length === 0, JSON.stringify(splitWarn))
  check('仅告警的谱面：warnings 含具体消息与行列', splitWarn.warnings.length >= 1 && /第5行/.test(splitWarn.warnings[0].text), JSON.stringify(splitWarn.warnings))
  // adj394：每条问题都带「正确语法规则」（hint），端侧据此显示「正确写法」
  check('adj394 告警带正确写法（hint，含示例）', splitWarn.warnings.every((w) => !!w.hint && w.hint.includes('`')), JSON.stringify(splitWarn.warnings.map((w) => w.hint)))

  const withErr = parseJps('V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1"未闭合 2 |\n')
  const splitErr = splitParseIssues(withErr)
  check('含错误的谱面：errors 非空（阻断渲染）', splitErr.errors.length >= 1, JSON.stringify(splitErr))
  check('adj394 错误带正确写法（hint：引号成对）', splitErr.errors.every((e) => !!e.hint && e.hint.includes('引号')), JSON.stringify(splitErr.errors.map((e) => e.hint)))

  const clean = splitParseIssues(parseJps('V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 2 3 4 |\n'))
  check('正常谱面：errors 与 warnings 均为空', clean.errors.length === 0 && clean.warnings.length === 0, JSON.stringify(clean))

  // 渐强/渐弱跨行的告警也属 warning（不阻断），并带正确写法
  const crossLine = splitParseIssues(parseJps('V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 2 3 < 4 |\nQ: 5 6 7 ! |\n'))
  check('跨行渐强/渐弱属 warning（不阻断渲染）', crossLine.errors.length === 0 && crossLine.warnings.some((w) => w.text.includes('不能跨行')), JSON.stringify(crossLine))
  check(
    'adj394 跨行渐强/渐弱的告警带正确写法（同一行内配对）',
    // adj594 起引擎还会报「小节时值不符」等同谱面的其它告警 ⇒ 这里只校验**渐强那条**的 hint
    crossLine.warnings
      .filter((w) => w.text.includes('不能跨行'))
      .every((w) => !!w.hint && w.hint.includes('同一行')),
    JSON.stringify(crossLine.warnings.map((w) => w.hint)),
  )
  // adj394：所有报错点都必须带正确写法（逐个场景扫一遍，防止新增报错时漏挂 hint）
  {
    const badSources: [string, string][] = [
      ['多空格', 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1  2 |\n'],
      ['孤立 &', 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 & 2 |\n'],
      ['无法识别的符号', 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 % 2 |\n'],
      ['引号未闭合', 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1"未闭合 2 |\n'],
      ['渐强起止同音符', 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 2 3 < ! 4 |\n'],
      ['渐强跨行', 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 2 < 3 |\nQ: 4 5 ! |\n'],
      ['渐强未结束又新起', 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: 1 2 < 3 4 > 5 |\n'],
      ['跳房子写错位置', 'V: 1.0\nB: t\nD: C\nP: 4/4\nQ: [ "1." 1 2 3 |\n'],
      ['C 行缺曲行', 'V: 1.0\nB: t\nD: C\nP: 4/4\nC: 孤零零的歌词\n'],
      ['未识别行', 'V: 1.0\nB: t\nD: C\nP: 4/4\nX: 这是啥\nQ: 1 2 3 4 |\n'],
    ]
    const missing: string[] = []
    for (const [name, src] of badSources) {
      const issues = splitParseIssues(parseJps(src))
      const all = [...issues.errors, ...issues.warnings]
      if (all.length === 0) missing.push(`${name}(未产生任何问题)`)
      else if (all.some((i) => !i.hint)) missing.push(`${name}(${all.filter((i) => !i.hint).map((i) => i.message).join('/')})`)
    }
    check('adj394 十类语法问题全部带正确写法（无漏挂 hint）', missing.length === 0, missing.join('；'))
  }
}

// ---- 12. .jps 文件视图：源码态严格填满窗口（adj402 回归护栏） ----
// 用户反馈（移动端）：切到「✎ 源码」时窗格**缩两次**（键盘弹出缩一次、随后又缩一次），
// 而且收缩后填不满可用空间。根因是两套机制叠加：容器 `height:100% + overflow:auto` 自己会滚，
// textarea 又有 `min-height:240px` 硬下限。修法：容器 flex 列 + min-height:0、源码态容器不滚
// （`.ijipu-file-editing` → overflow:hidden，滚动交给 textarea）、textarea 去掉硬下限 + flex:1。
// 这几条断言防的是"以后有人把 240px 加回来 / 忘了加 editing 类"，那种回归在桌面端看不出来。
console.log('[12] .jps 文件视图：源码态填满窗口（adj402）')
{
  const css = readFileSync('styles.css', 'utf8')
  const view = readFileSync('src/fileView.ts', 'utf8')
  const blockOf = (sel: string): string => {
    const i = css.indexOf(`${sel} {`)
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i))
  }
  const viewBlock = blockOf('.ijipu-file-view')
  const editorBlock = blockOf('.ijipu-source-editor')
  check('adj402 视图容器 height:100% + min-height:0 + border-box（可随窗口一起收缩）', viewBlock.includes('height: 100%') && viewBlock.includes('min-height: 0') && viewBlock.includes('box-sizing: border-box'), viewBlock.replace(/\s+/g, ' '))
  check('adj402 源码态容器不自己滚（.ijipu-file-editing → overflow:hidden）', /\.ijipu-file-view\.ijipu-file-editing\s*\{[^}]*overflow:\s*hidden/.test(css))
  /**
   * adj744：手机端默认改用 Obsidian 自己的编辑器（源码模式）⇒ 这个 textarea 只是**回退路径**，
   * 而回退路径在手机上得有个高度下限（用户正是报"框太矮"）。所以：
   *  · 基规则仍须"无 240px 硬下限 + flex:1"（桌面端就是靠它等于窗口剩余高度）；
   *  · 手机端另有一条 `min-height: 50vh` 的**回退下限**（只在 `.is-mobile` 下生效）。
   * 断言因此按"基规则块"取（`blockOf` 取的是第一次出现），不再被后面那条手机规则干扰。
   */
  check('adj402/744 textarea 基规则无 240px 硬下限 + flex:1；手机端回退另有 min-height 下限',
    editorBlock.includes('flex: 1 1 auto') && editorBlock.includes('min-height: 0') && !editorBlock.includes('240px') &&
      /\.is-mobile \.ijipu-file-view\.ijipu-file-editing \.ijipu-source-editor\s*\{[^}]*min-height:\s*50vh/.test(css),
    editorBlock.replace(/\s+/g, ' ').slice(0, 60))
  check('adj402 fileView 源码态给容器加 .ijipu-file-editing', view.includes("addClass('ijipu-file-editing')"))
  // adj404：真机上 WebView（随键盘缩布局视口）与 Obsidian（`--keyboard-height` 再扣一次）双重扣减，
  // 源码框会比可视区矮一个键盘高 → 按 visualViewport 实测定高，必要时临时解除 .app-container 上限。
  // 断言这两件事都在（并都有还原），防止后人"简化"掉导致真机回归。
  check('adj404 源码框按可视区域实测定高（visualViewport + 键盘高补偿）', view.includes('visualViewport') && view.includes('vv.offsetTop + vv.height') && view.includes('keyboardVar'))
  check('adj404 必要时解除 .app-container 上限并还原（不留副作用）', view.includes("setCssStyles({ maxHeight: 'none' })") && view.includes("removeProperty('max-height')") && view.includes('teardownHeightFit') && view.includes('Platform.isMobile'))
  // adj407：设置页显示「构建 日期 时间 @commit」——同一版本号会有多个本地构建，没有指纹就无法判断
  // 手机上装的到底是哪一份（复测时反复踩过）。这条断言防的是"以后有人把指纹去掉"。
  const settingsSrc = readFileSync('src/settings.ts', 'utf8')
  const pkgJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
  check('adj407 设置页显示构建指纹（日期 时间 + commit）', settingsSrc.includes('BUILD_STAMP') && settingsSrc.includes('GIT_COMMIT') && settingsSrc.includes('构建 '))
  check('adj407 build/smoke 前置生成构建信息（gen:info → src/gen/buildInfo.ts，已 gitignore）', (pkgJson.scripts?.build ?? '').includes('gen:info') && (pkgJson.scripts?.smoke ?? '').includes('gen:info') && readFileSync('.gitignore', 'utf8').includes('src/gen/'))
  // adj408/adj409：真机上"源码框少一个键盘高"的两条真凶（都在宿主的样式里，需要 `!important` 反制）——
  // ① 宿主 textarea 的 height/min-height/max-height；② `.view-content` 的 padding-bottom = 键盘高。
  // 这两条最容易被人"顺手简化"掉，而回归只在真机上暴露，故用断言钉住。
  //
  // adj724b（社区审核）：反制手段由"逐条 inline + !important"改为 **CSS 类**
  // （官方 lint 规则 `obsidianmd/no-static-styles-assignment` 不允许直接写 style），
  // 断言同步改为钉"类名 + styles.css 里的对应规则"——**防的仍是同一件事**（这两条反制被删掉）。
  //
  // adj772（社区审核 CSS 一节："Avoid !important — override styles by increasing selector specificity"）：
  // 反制宿主**不再用 `!important`**，改为**重复类名提权**（`.a.a` ⇒ 特异性 0,2,0）。
  // 断言因此同步升级，而且**比原来更强**：既要"规则在、能压过宿主（重复类名）"，又要"全文件不再有 !important 声明"。
  const cssSrc = readFileSync('styles.css', 'utf8')
  check('adj408/adj772 反制宿主 textarea 的 height/min/max-height（重复类名提权，不用 !important）',
    view.includes("addClass('ijipu-source-editor-fit')") &&
      /\.ijipu-source-editor-fit\.ijipu-source-editor-fit\s*\{[\s\S]{0,200}?min-height:\s*0;/.test(cssSrc) &&
      /\.ijipu-source-editor-fit\.ijipu-source-editor-fit\s*\{[\s\S]{0,200}?max-height:\s*none;/.test(cssSrc) &&
      /\.ijipu-source-editor-fit\.ijipu-source-editor-fit\s*\{[\s\S]{0,200}?height:\s*auto;/.test(cssSrc))
  check('adj409/adj772 反制宿主的键盘 padding-bottom（真凶；重复类名提权，不用 !important）',
    view.includes("addClass('ijipu-file-editing-fit')") &&
      /\.ijipu-file-editing-fit\.ijipu-file-editing-fit\s*\{[\s\S]{0,240}?padding-bottom:\s*8px;/.test(cssSrc))
  check('adj409 源码框高度按实测位置算（不再用 offsetHeight 估算）',
    view.includes('ta.getBoundingClientRect().top') && /height:\s*auto;/.test(cssSrc))
  /** adj772：CSS 审核那条"避免 !important"的总闸门 —— 全文件不得再出现任何 `!important;` 声明 */
  check('adj772 styles.css 不再出现 !important 声明（社区审核 CSS 一节）',
    !/!important\s*;/.test(cssSrc), (cssSrc.match(/!important\s*;/g) ?? []).length + ' 处')
  // adj724b（社区审核）：样式必须走 CSS 类，不得再出现"直接写 style"的写法
  check('adj724b 不再直接写 style（社区审核 no-static-styles-assignment）',
    !/\.style\.(setProperty|width|height|display|border|maxHeight|flex)\b/.test(view))
}

// ---- adj450：与 iJipu 应用同步的音色口径（默认「自动」+ 通道独占 + 名称全量解析）----
// 对应应用侧 adj446/adj447/adj448：插件此前自持一份 GM 音色表、后端用 `ch = program % 16` 分通道、
// 且「默认音色」会连伴奏/`@乐器名@` 一起覆盖（应用侧 adj427/adj434 明确保留它们）。
console.log('[adj450] plugin playback timbre parity with the app')
{
  const soundbankSrc = readFileSync('src/soundbank.ts', 'utf8')
  const settingsSrcSb = readFileSync('src/settings.ts', 'utf8')
  const renderSrc = readFileSync('src/render.ts', 'utf8')
  // ① GM 音色表唯一来源 = engine 的 GM_VOICES（不再在插件里另存一份）
  check('adj450 GM 音色表取自 engine 的 GM_VOICES', soundbankSrc.includes('GM_VOICE_OPTIONS: GmVoice[] = GM_VOICES'))
  // ② 通道按**音色独占**分配（旧的 `program % 16` 会让不同音色撞同一通道，
  //    且 program%16===9 会落到 GM 打击乐通道 ⇒ 音色走样）
  check('adj450 通道用 GmChannelAllocator（不再 program % 16）',
    soundbankSrc.includes('GmChannelAllocator') && !/const\s+ch\s*=\s*program\s*%\s*16/.test(soundbankSrc))
  check('adj450 触发时刻核对通道音色（channelProgram），不再「发过就不再发」',
    soundbankSrc.includes('channelProgram.get(ch) !== program') && !soundbankSrc.includes('programSet'))
  check('adj450 stop() 清空通道音色记录', /stop\(\)[\s\S]{0,400}channelProgram\.clear\(\)/.test(soundbankSrc))
  // ③ 默认音色不得覆盖伴奏/第二声部与曲内 @乐器名@（引擎 schedulePlay 会传 keepInstrument）
  check('adj450 play() 支持 opts.keepInstrument（伴奏/@乐器名@ 保留自身音色）',
    soundbankSrc.includes('keepInstrument') && soundbankSrc.includes('opts?.keepInstrument'))
  // ④ 默认值 = 自动（settings.hqVoice 未设置 → null → 声部路由）
  check('adj450 默认音色未设置时为「自动」（render 传 null）', renderSrc.includes('opts?.hqVoice ?? null'))
  /**
   * adj724b：原断言核的是**插件设置页**里那句"选具体音色会覆盖谱面 Y:"的说明；
   * 该设置页已随设置整并删除（音色只在嵌入版 iJipu 里改）⇒ 断言对象改为
   * **插件设置里不再出现音色设置**，覆盖关系的口径仍由引擎/嵌入版负责。
   */
  check('adj750 插件设置里不再重复提供音色设置（统一在嵌入版 iJipu 里改）',
    !/GM_VOICE_OPTIONS|hqVoice/.test(settingsSrcSb))
  // ⑤ 试听走引擎的事件序列（音色由 Y:/@ 决定；被全局覆盖时才用默认音色）
  check('adj450 试听调用引擎 schedulePlay（音色链路与应用一致）',
    renderSrc.includes('schedulePlay(seq, backend') && !renderSrc.includes('backend.play('))
  // ⑥ adj451：色块轨道把引擎给出的「边界/音色/声部角色/**力度**」一并透传
  //    （此前只传 x/y/width ⇒ 多声部色块退化成单声部默认高度；力度变量也没到插件侧）
  for (const f of ['yTopMin', 'yBottomMax', 'playVoice', 'instrument', 'gain']) {
    check(`adj451 PlayheadSeg 透传 ${f}`, renderSrc.includes(`${f}: s.${f}`))
  }
  check('adj451 力度变量与音频同源（引擎拍段 gain）',
    renderSrc.includes('gain: s.gain') && readFileSync('vendor/engine/playback/sequence.ts', 'utf8').includes('gain?: number'))
}

// ---- adj452：试听色块按「声部角色 / 音色 / 动态上下边界」绘制（与 iJipu 应用同规则）----
// 用户：先按建议补上色块的 yTopMin/yBottomMax（高度）与 playVoice（声部角色），后面再考虑完善。
// 插件此前是"每个曲行只取一个当前拍段 + 硬编码高度 + 按声部号配色"的简版。
console.log('[adj452] playhead blocks follow playVoice / instrument / engine bounds')
{
  const src = 'V: 1.0\nB: t\nD: C\nP: 4/4\nY: 钢琴\nY: 弦乐\n' +
    'Q1: 1 3 5 3 | 1 - - - |\nQ2: 5 1 3 1 | 5 - - - |\n' +
    "Q: 3 4 {bz 1 2 3 4 | 5 6 7 1'} 5 6 7 1' | 1' 7 6 5 | 5 5 5 5 | 5 - - - |\n"
  const pr = parseJps(src)
  const layout = layoutScore(pr, defaultPageConfig)
  const seq = buildPlaySequence(pr, layout, 100)
  const noteSize = layout.config.note_size
  /** 与 render.ts 的轨道映射同构（只取纯数据，不碰音频） */
  const beatMs = 60000 / 100
  const track = seq.events.flatMap((e) =>
    (e.playheadSegs ?? []).map((s) => ({
      atMs: e.atMs + s.beat * beatMs,
      durationMs: s.beats * beatMs,
      pageIndex: s.pageIndex,
      x: s.x,
      y: s.y,
      width: s.width,
      voice: s.voice,
      group: s.group,
      ...(s.instrument !== undefined ? { instrument: s.instrument } : {}),
      ...(s.yTopMin !== undefined ? { yTopMin: s.yTopMin } : {}),
      ...(s.yBottomMax !== undefined ? { yBottomMax: s.yBottomMax } : {}),
      ...(s.playVoice !== undefined ? { playVoice: s.playVoice } : {}),
      ...(s.gain !== undefined ? { gain: s.gain } : {}),
    })),
  )
  const groups = trackKeysOf(track)
  // ① 分组键含 playVoice：同一曲行里"主旋律 + bz 伴奏"必须是两组（旧键会把它们并成一块）
  const bzGroup = seq.events.find((e) => e.playVoice === 'accomp')?.placed.id.group
  const groupsOfBz = [...groups.entries()].filter(([k]) => k.startsWith(`0|${bzGroup}|`))
  check('adj452 同一曲行内主旋律与 bz 伴奏各成一组（分组键含 playVoice）',
    groupsOfBz.length >= 2, `键=${groupsOfBz.map(([k]) => k).join(' / ')}`)
  // ② 重复调用命中缓存（同引用不重建）
  check('adj452 trackKeysOf 按 track 引用缓存', trackKeysOf(track) === groups)
  // ③ 定位：上下边界优先用引擎给的值；缺省时回退单声部默认 [y−1.6×字号, y+0.6×字号]
  {
    const withBounds = [...groups.values()].find((segs) => segs[0]?.yTopMin !== undefined)
    check('adj452 存在带动态定界的组（多声部/临时段）', withBounds !== undefined)
    const seg0 = withBounds![0]
    const pos = playheadPosIn(withBounds!, seg0.atMs + 1, 0, noteSize)
    check('adj452 有 yTopMin/yBottomMax 时按引擎定界绘制（不再硬编码高度）',
      pos !== null && pos.yTop === seg0.yTopMin && pos.yBottom === seg0.yBottomMax,
      pos ? `${pos.yTop}/${seg0.yTopMin} · ${pos.yBottom}/${seg0.yBottomMax}` : 'null')
    // 无动态定界的组（普通单声部行）→ 默认公式
    const plain = [...groups.values()].map((segs) => segs.find((s) => s.yTopMin === undefined)).find(Boolean)
    if (plain) {
      const p2 = playheadPosIn([plain], plain.atMs + 1, plain.pageIndex, noteSize)
      check('adj452/758 无动态定界时回退单声部默认 [y−1.6×字号, y+1.1×字号]（统一按**应用**那版：上下各留 0.5 字号延伸）',
        p2 !== null && Math.abs(p2.yTop - (plain.y - noteSize * 1.6)) < 1e-9 &&
        Math.abs(p2.yBottom - (plain.y + noteSize * 1.1)) < 1e-9,
        p2 ? `${p2.yTop}/${p2.yBottom}` : 'null')
    }
    // ④ 最后一段播完 / 别的页 → 不残留旧块
    const last = withBounds![withBounds!.length - 1]
    check('adj452 末段播完后返回 null（段间空隙不残留）',
      playheadPosIn(withBounds!, last.atMs + last.durationMs + 1, 0, noteSize) === null)
    check('adj452 不是本页时返回 null', playheadPosIn(withBounds!, seg0.atMs + 1, 9, noteSize) === null)
  }
  // ⑤ 配色：声部角色固定色优先，其次按音色，最后按声部号
  {
    const cmap = instrumentColorMap(track)
    const blue = 'rgba(87, 170, 255,'
    const green = 'rgba(63, 122, 46,'
    const red = 'rgba(255, 93, 108,'
    check('adj452 bz 伴奏 = 蓝', playheadBaseOf({ voice: 1, playVoice: 'accomp' }, cmap) === blue)
    check('adj452 dsb 下层 = 绿', playheadBaseOf({ voice: 1, playVoice: 'second' }, cmap) === green)
    check('adj452 dsb 上层 = 红', playheadBaseOf({ voice: 1, playVoice: 'main' }, cmap) === red)
    const v1Inst = track.find((t) => t.voice === 1 && t.playVoice === undefined)?.instrument
    check('adj452 主旋律/单声部按音色取色（第 1 音色 = 红）',
      playheadBaseOf({ voice: 1, instrument: v1Inst }, cmap) === red, String(v1Inst))
    check('adj452 同一音色恒定同色（map 稳定）',
      playheadBaseOf({ voice: 2, instrument: v1Inst }, cmap) === playheadBaseOf({ voice: 3, instrument: v1Inst }, cmap))
  }
  // ⑥ 多声部：Q1/Q2 是两个曲行（group），各画一块且纵向不重叠
  {
    const g0 = [...groups.entries()].find(([k]) => k.startsWith('0|0|'))
    const g1 = [...groups.entries()].find(([k]) => k.startsWith('0|1|'))
    check('adj452 Q1/Q2 两个曲行各有自己的色块组', g0 !== undefined && g1 !== undefined)
    if (g0 && g1) {
      const a = playheadPosIn(g0[1], 1, 0, noteSize)
      const b = playheadPosIn(g1[1], 1, 0, noteSize)
      check('adj452 多声部两声部色块纵向不重叠',
        a !== null && b !== null && (a.yBottom <= b.yTop + 0.01 || b.yBottom <= a.yTop + 0.01),
        a && b ? `[${a.yTop},${a.yBottom}] vs [${b.yTop},${b.yBottom}]` : 'null')
    }
  }
  // ⑦ dsb：**同一曲行**里上下两层各一块（旧的"每曲行只取一段"只能画一块）
  {
    const srcDsb = 'V: 1.0\nB: t\nD: C\nP: 4/4\n' +
      "Q: 3 4 {dsb 1 2 3 4 | 5 6 7 1'} 5 6 7 1' | 1' 7 6 5 | 5 5 5 5 | 5 - - - |\n"
    const prD = parseJps(srcDsb)
    const layoutD = layoutScore(prD, defaultPageConfig)
    const seqD = buildPlaySequence(prD, layoutD, 100)
    const trackD = seqD.events.flatMap((e) =>
      (e.playheadSegs ?? []).map((s) => ({
        atMs: e.atMs + s.beat * (60000 / 100),
        durationMs: s.beats * (60000 / 100),
        pageIndex: s.pageIndex,
        x: s.x,
        y: s.y,
        width: s.width,
        voice: s.voice,
        group: s.group,
        ...(s.yTopMin !== undefined ? { yTopMin: s.yTopMin } : {}),
        ...(s.yBottomMax !== undefined ? { yBottomMax: s.yBottomMax } : {}),
        ...(s.playVoice !== undefined ? { playVoice: s.playVoice } : {}),
      })),
    )
    const gD = [...trackKeysOf(trackD).entries()].filter(([k]) => k.startsWith('0|0|'))
    /**
     * adj722（应用侧同批）：`{dsb}` 的**主副声部对换**了——**段内容 = 副声部**（`second`）、
     * **包络外主旋律 = 主声部**（**不再设 `playVoice`** ⇒ 分组键尾为空）。
     * 旧断言写死 `|main`，翻转后自然取不到（插件 `smoke` 报 `键=0|0|1|| / 0|0|1||second`）。
     * 新口径：主声部 = `|main` **或**键尾为空；副声部 = `|second`。
     */
    const keyMain = gD.find(([k]) => k.endsWith('|main') || /^0\|0\|\d+\|(?:[^|]*)\|$/.test(k))
    const keySecond = gD.find(([k]) => k.endsWith('|second'))
    check('adj452/adj722 dsb 同一曲行上下两层各成一组（playVoice 进键；段内容=副声部、段外主旋律=主声部）',
      keyMain !== undefined && keySecond !== undefined,
      `键=${gD.map(([k]) => k).join(' / ')}`)
    if (keyMain && keySecond) {
      const ns = layoutD.config.note_size
      /**
       * adj722：必须取**同一时刻、且都在 `{dsb}` 段内**的一对来比——
       * 主声部组的**首个**拍段是段**之前**的普通主旋律音（走默认定界 `[y−1.6ns, y+0.6ns]`），
       * 与副声部（段内、走上半定界）比会得出"重叠"的假象
       * （实测 `[147.4, 176] vs [139.6, 164.95]`）。
       * 判据：主声部组里**带头一个带 `yTopMin` 的拍段**（带定界 = 在 `{dsb}` 段内）。
       */
      const inSeg = keyMain[1].find((t) => t.yTopMin !== undefined && t.yBottomMax !== undefined)
      const t0 = inSeg?.atMs
      const a = t0 !== undefined ? playheadPosIn(keyMain[1], t0 + 1, 0, ns) : null
      const b = t0 !== undefined ? playheadPosIn(keySecond[1], t0 + 1, 0, ns) : null
      check('adj452 dsb 下（主声部）上（副声部）色块纵向不重叠、各用各自定界',
        a !== null && b !== null && (a.yBottom <= b.yTop + 0.01 || b.yBottom <= a.yTop + 0.01),
        a && b ? `t=${t0} [${a.yTop},${a.yBottom}] vs [${b.yTop},${b.yBottom}]` : `null t0=${t0}`)
    }
  }
}

// ── 「应用打开」（用户要求：视图按钮组之后的入口，用系统默认应用去编辑）────────────────
{
  const scorePaneSrc = readFileSync('src/scorePane.ts', 'utf8')
  const openExtSrc = readFileSync('src/openExternal.ts', 'utf8')
  const fileViewSrcAp = readFileSync('src/fileView.ts', 'utf8')
  const embedSrcAp = readFileSync('src/embed.ts', 'utf8')

  check(
    '应用打开：按钮在**显示模式（视图）组之后**，文案「应用打开」、悬浮提示「使用默认应用打开」',
    scorePaneSrc.indexOf('const modeWrap') < scorePaneSrc.indexOf('ijipu-app-open-btn') &&
      scorePaneSrc.includes("text: '应用打开'") &&
      scorePaneSrc.includes("setAttr('title', '使用默认应用打开')"),
    '',
  )

  check(
    '应用打开：**仅桌面端 + 仅知道文件时**渲染（手机端不出现；代码块没有文件）',
    // adj773：原来的 `} else if (host.filePath && …)` 去掉了 `else` ——
    // 因为"编辑"按钮已统一到工具条末尾（由上面那段按宿主/平台分派），这里只剩"应用打开"这一支。
    /if \(!hasEditEntry && host\.filePath && canOpenWithDefaultApp\(plugin\.app\)\)/.test(scorePaneSrc) &&
      /if \(!Platform\.isDesktopApp\) return false/.test(openExtSrc),
    '',
  )

  check(
    '应用打开：走系统默认应用（shell.openPath）且把库内相对路径换算成绝对路径；失败必须 Notice',
    openExtSrc.includes('shell.openPath') &&
      openExtSrc.includes('getFullPath(filePath)') &&
      openExtSrc.includes('new Notice(`用默认应用打开失败'),
    '',
  )

  check(
    '应用打开：两个"自带文件"的入口都传了 filePath（.jps 文件视图 / ![[x.jps]] 嵌入）',
    /filePath: this\.file\?\.path/.test(fileViewSrcAp) && /filePath: file\.path/.test(embedSrcAp),
    '',
  )

  check(
    '应用打开：打开前先刷未落盘的编辑（fileView 传 beforeOpenExternal=saveNow，scorePane 先 await 它）',
    /beforeOpenExternal: \(\) => this\.saveNow\(\)/.test(fileViewSrcAp) &&
      /await host\.beforeOpenExternal\?\.\(\)/.test(scorePaneSrc),
    '',
  )
}

// ── 「新建 JPS 文件」（用户要求：文件列表里文件夹右键菜单 + 默认模板内容）────────────
{
  const mainSrcNf = readFileSync('src/main.ts', 'utf8')
  const newFileSrcNf = readFileSync('src/newFile.ts', 'utf8')

  check(
    '新建 JPS：菜单项注册在 `file-menu` 上、且**只对文件夹**出现（文件右键不出这一项）',
    /workspace\.on\('file-menu'/.test(mainSrcNf) &&
      /if \(!\(file instanceof TFolder\)\) return/.test(mainSrcNf) &&
      mainSrcNf.includes("setTitle('新建 JPS 文件')"),
    '',
  )
  check(
    '新建 JPS：菜单项带图标，点击后**在该文件夹内**创建（把 `file` 当目标目录传下去）',
    /setIcon\('file-plus'\)/.test(mainSrcNf) && /createJpsFile\(this\.app, file\)/.test(mainSrcNf),
    '',
  )
  check(
    '新建 JPS：创建走 vault API（`vault.create`）并**打开新文件**；失败只弹 Notice 不抛',
    /app\.vault\.create\(path, NEW_JPS_TEMPLATE\)/.test(newFileSrcNf) &&
      /workspace\.getLeaf\(false\)\.openFile\(file\)/.test(newFileSrcNf) &&
      /new Notice\(`新建 JPS 文件失败/.test(newFileSrcNf),
    '',
  )
  check(
    '新建 JPS：库根目录（`path === \'/\'`）不再拼一次分隔符',
    /folder\.path === '\/' \|\| folder\.path === ''/.test(newFileSrcNf),
    '',
  )

  check('新建 JPS 命名：无同名文件 → `未命名.jps`', nextJpsFileName([]) === '未命名.jps', nextJpsFileName([]))
  check(
    '新建 JPS 命名：已有 `未命名.jps` → `未命名 1.jps`（与 Obsidian 自带「新建笔记」同款）',
    nextJpsFileName(['未命名.jps']) === '未命名 1.jps',
    nextJpsFileName(['未命名.jps']),
  )
  check(
    '新建 JPS 命名：取**第一个空位**（删掉中间那个后不复用已占用的后一个）',
    nextJpsFileName(['未命名.jps', '未命名 1.jps', '未命名 3.jps']) === '未命名 2.jps',
    nextJpsFileName(['未命名.jps', '未命名 1.jps', '未命名 3.jps']),
  )
  check(
    '新建 JPS 命名：大小写不敏感（Windows/macOS 上 `未命名.JPS` 与 `.jps` 是同一个文件）',
    nextJpsFileName(['未命名.JPS']) === '未命名 1.jps' && nextJpsFileName(['未命名 1.Jps']) === '未命名.jps',
    nextJpsFileName(['未命名.JPS']),
  )
  check(
    '新建 JPS 命名：忽略非 .jps 的同名文件与不相干文件',
    nextJpsFileName(['未命名.md', '别的.jps']) === '未命名.jps',
    nextJpsFileName(['未命名.md', '别的.jps']),
  )
  check(
    '新建 JPS 命名：基名可换（`未命名` 是默认口径，能被参数覆盖）',
    nextJpsFileName([], '我的曲子') === '我的曲子.jps' && NEW_JPS_BASE === '未命名',
    nextJpsFileName([], '我的曲子'),
  )

  // 模板：与应用「新建」模板同口径（描述头 + 一行示例 + 页面设置占位），且**引擎解析 0 错 0 警**
  const tplParsed = parseJps(NEW_JPS_TEMPLATE)
  check(
    '新建 JPS 模板：引擎解析**零错误零告警**（新建出来立刻是一份合法谱）',
    tplParsed.errors.length === 0,
    JSON.stringify(tplParsed.errors.map((e) => e.message)),
  )
  check(
    '新建 JPS 模板：描述头 + 曲词主体 + 页面设置占位齐备（V/B/Z/D/P/S、Q、C、`# jps-config:{}`）',
    ['V: 1.0', 'B: ', 'Z: ', 'D: C', 'P: 4/4', 'S: ', 'Q: ', 'C: '].every((k) => NEW_JPS_TEMPLATE.includes(k)) &&
      NEW_JPS_TEMPLATE.includes('# jps-config:{}') &&
      NEW_JPS_TEMPLATE.includes('#===========描述头定义===========') &&
      NEW_JPS_TEMPLATE.includes('#==========以下为简谱主体==========') &&
      NEW_JPS_TEMPLATE.includes('#===以下为页面设置，请勿手动修改==='),
    '',
  )
  check(
    '新建 JPS 模板：以换行结尾、且是 LF（与应用模板逐字一致的写法口径）',
    NEW_JPS_TEMPLATE.endsWith('\n') && !NEW_JPS_TEMPLATE.includes('\r'),
    JSON.stringify(NEW_JPS_TEMPLATE.slice(-12)),
  )
  check(
    '新建 JPS 模板：谱尾说明 `S:` 带官网链接（与应用「新建」模板同一句，别只写「爱记谱」）',
    NEW_JPS_TEMPLATE.includes('S: 本乐谱使用「爱记谱 https://ijipu.pages.dev」编制'),
    JSON.stringify(NEW_JPS_TEMPLATE.split('\n').filter((l) => l.startsWith('S: '))),
  )
  const tplLayout = layoutScore(tplParsed, defaultPageConfig)
  check(
    '新建 JPS 模板：能正常排版（1 小节 4 拍、标题为「未命名」）',
    tplLayout.pages[0].notes.length === 4 && tplParsed.header.titles[0] === '未命名',
    JSON.stringify({ notes: tplLayout.pages[0].notes.length, title: tplParsed.header.titles[0] }),
  )

  // 端到端：用假 vault/app 真跑一遍 `createJpsFile`（路径拼装 + 写入内容 + 打开新文件）
  const created: { path: string; data: string }[] = []
  const opened: string[] = []
  const fakeApp = {
    vault: {
      // 父目录已存在的场景：`ensureFolders` 查得到就不再建目录
      getAbstractFileByPath: () => ({ path: '乐谱' }),
      create: async (path: string, data: string) => {
        created.push({ path, data })
        return { path }
      },
    },
    workspace: {
      getLeaf: () => ({ openFile: async (f: { path: string }) => void opened.push(f.path) }),
    },
  }
  await createJpsFile(fakeApp as never, { path: '乐谱', children: [{ name: '未命名.jps' }] } as never)
  check(
    '新建 JPS：在**该文件夹**内建不重名文件、写入的就是模板内容、并打开它',
    created.length === 1 &&
      created[0].path === '乐谱/未命名 1.jps' &&
      created[0].data === NEW_JPS_TEMPLATE &&
      opened.length === 1 &&
      opened[0] === '乐谱/未命名 1.jps',
    JSON.stringify({ path: created[0]?.path, opened }),
  )
  created.length = 0
  opened.length = 0
  await createJpsFile(fakeApp as never, { path: '/', children: [] } as never)
  check(
    '新建 JPS：库根目录建出来的是 `未命名.jps`（不是 `/未命名.jps`）',
    created[0]?.path === '未命名.jps',
    String(created[0]?.path),
  )
  let threw = false
  const badApp = {
    vault: {
      create: async () => {
        throw new Error('磁盘只读')
      },
    },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
  }
  try {
    await createJpsFile(badApp as never, { path: '', children: [] } as never)
  } catch {
    threw = true
  }
  check(
    '新建 JPS：创建失败**不向上抛**（只弹 Notice；右键菜单回调里抛出去会成未捕获异常）',
    !threw,
    '',
  )

  // ── 菜单项落在 Obsidian 自带的「新建」组（section = action-primary）────────────────────
  // 事实来源：`obsidian.asar` 里文件夹右键菜单的构建代码
  //   `c.addItem(e => e.setSection("action-primary").setTitle(...menuOptNewNote())...)`（新建笔记/新建文件夹同组）
  check(
    '新建 JPS 菜单项与 Obsidian 自带「新建笔记 / 新建文件夹」**同组**（section = `action-primary`）',
    /\.setSection\('action-primary'\)/.test(mainSrcNf) &&
      /\.setTitle\('新建 JPS 文件'\)\s*\n\s*\.setSection\('action-primary'\)/.test(mainSrcNf),
    '',
  )

  // ── 点击「不存在的 [[谱名.jps]]」→ 在**链接所在笔记的同级目录**建文件 ────────────────
  check(
    '链接建文件：`[[谱名.jps]]` → 建在**链接所在笔记的目录**下（用户口径：同级目录）',
    JSON.stringify(planJpsLinkCreate('谱名.jps', '乐谱/笔记.md', () => false)) === JSON.stringify({ path: '乐谱/谱名.jps' }),
    JSON.stringify(planJpsLinkCreate('谱名.jps', '乐谱/笔记.md', () => false)),
  )
  check(
    '链接建文件：笔记在**库根**时路径不多一层（`谱名.jps` 而不是 `/谱名.jps`）',
    planJpsLinkCreate('谱名.jps', '笔记.md', () => false)?.path === '谱名.jps',
    JSON.stringify(planJpsLinkCreate('谱名.jps', '笔记.md', () => false)),
  )
  check(
    '链接建文件：链接带子目录（`[[子/谱.jps]]`）时目录也一起补齐成路径',
    planJpsLinkCreate('子/谱.jps', '乐谱/笔记.md', () => false)?.path === '乐谱/子/谱.jps',
    JSON.stringify(planJpsLinkCreate('子/谱.jps', '乐谱/笔记.md', () => false)),
  )
  check(
    '链接建文件：以 `/` 开头 = 从**库根**起算（`[[/谱库/我的谱.jps]]`）',
    planJpsLinkCreate('/谱库/我的谱.jps', '乐谱/笔记.md', () => false)?.path === '谱库/我的谱.jps',
    JSON.stringify(planJpsLinkCreate('/谱库/我的谱.jps', '乐谱/笔记.md', () => false)),
  )
  check(
    '链接建文件：别名与子标题先剥掉（`[[谱名.jps|别名]]` / `[[谱名.jps#第2段]]`）',
    jpsLinkTarget('谱名.jps|别名') === '谱名.jps' && jpsLinkTarget('谱名.jps#第2段') === '谱名.jps' &&
      planJpsLinkCreate('谱名.jps|别名', '乐谱/笔记.md', () => false)?.path === '乐谱/谱名.jps',
    JSON.stringify([jpsLinkTarget('谱名.jps|别名'), jpsLinkTarget('谱名.jps#第2段')]),
  )
  check(
    '链接建文件：**不是 `.jps`** 的未解析链接不接管（`[[普通笔记]]` / `[[图.png]]` 仍归 Obsidian，会建 .md）',
    planJpsLinkCreate('普通笔记', '乐谱/笔记.md', () => false) === null &&
      planJpsLinkCreate('图.png', '乐谱/笔记.md', () => false) === null &&
      planJpsLinkCreate('', '乐谱/笔记.md', () => false) === null,
    JSON.stringify([jpsLinkTarget('普通笔记'), jpsLinkTarget('图.png'), jpsLinkTarget('')]),
  )
  check(
    '链接建文件：**文件已存在**时不接管（把点击还给 Obsidian 原本的打开逻辑）',
    planJpsLinkCreate('谱名.jps', '乐谱/笔记.md', () => true) === null,
    '',
  )
  check(
    '链接建文件：`..` 一律拒绝（不往库外/上级乱写）',
    planJpsLinkCreate('../谱名.jps', '乐谱/笔记.md', () => false) === null &&
      planJpsLinkCreate('子/../../谱名.jps', '乐谱/笔记.md', () => false) === null &&
      resolveJpsLinkPath('..', '乐谱/笔记.md') === null,
    JSON.stringify(resolveJpsLinkPath('子/../../谱名.jps', '乐谱/笔记.md')),
  )
  check(
    '链接建文件：扩展名大小写不敏感（`[[谱名.JPS]]` 也认，路径保留用户写法）',
    planJpsLinkCreate('谱名.JPS', '乐谱/笔记.md', () => false)?.path === '乐谱/谱名.JPS',
    JSON.stringify(planJpsLinkCreate('谱名.JPS', '乐谱/笔记.md', () => false)),
  )
  // 接线：document 捕获阶段的 click 监听 + 同步判断 + 用 Keymap 决定新叶子
  check(
    '链接建文件：接在 document 的 **capture** 阶段 click 上（先拦下再冒泡给 Obsidian）',
    /registerDomEvent\(document, 'click'/.test(mainSrcNf) && /capture: true/.test(mainSrcNf) &&
      /a\.classList\.contains\('is-unresolved'\)/.test(mainSrcNf),
    '',
  )
  check(
    '链接建文件：`preventDefault`/`stopPropagation` 在**同步**路径上（先拦后 await，否则会被 Obsidian 抢走）',
    mainSrcNf.indexOf('evt.preventDefault()') > mainSrcNf.indexOf('planJpsLinkCreate(href') &&
      mainSrcNf.indexOf('void (async () =>') > mainSrcNf.indexOf('evt.stopPropagation()'),
    '',
  )
  check(
    '链接建文件：源码模式（非实时预览）与 Obsidian 一致——要按住 Ctrl/Cmd 才跟随，避免"想放光标却建了文件"',
    /const inEditor = a\.closest\('\.cm-editor'\) !== null/.test(mainSrcNf) &&
      /const livePreview = a\.closest\('\.is-live-preview'\) !== null/.test(mainSrcNf) &&
      /if \(inEditor && !livePreview && !evt\.ctrlKey && !evt\.metaKey\) return/.test(mainSrcNf),
    '',
  )
  check(
    '链接建文件：嵌入笔记里的链接按**被嵌入那篇**的目录算（`.internal-embed` 的 `src`）',
    /closest\('\.internal-embed, \.markdown-embed'\)/.test(mainSrcNf) &&
      /embed\?\.getAttribute\('src'\)/.test(mainSrcNf),
    '',
  )
  check(
    '链接建文件：Ctrl/Cmd 点链接 = 在新页签/分屏打开（与 Obsidian 同款 `Keymap.isModEvent`）',
    /Keymap\.isModEvent\(evt\)/.test(mainSrcNf) && /import \{[^}]*Keymap[^}]*\} from 'obsidian'/.test(mainSrcNf),
    '',
  )
  // 端到端：真建一次（含父目录补齐）
  created.length = 0
  opened.length = 0
  const foldersMade: string[] = []
  const deepApp = {
    vault: {
      getAbstractFileByPath: () => null,
      createFolder: async (p: string) => {
        foldersMade.push(p)
      },
      create: async (path: string, data: string) => {
        created.push({ path, data })
        return { path }
      },
    },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
  }
  const made = await materializeJpsFile(deepApp as never, '乐谱/子/谱名.jps')
  check(
    '链接建文件：父目录缺失时**逐级补齐**，再写入模板内容（`乐谱/子/谱名.jps` → 建 `乐谱`、`乐谱/子`）',
    made !== null && JSON.stringify(foldersMade) === JSON.stringify(['乐谱', '乐谱/子']) &&
      created[0]?.path === '乐谱/子/谱名.jps' && created[0]?.data === NEW_JPS_TEMPLATE,
    JSON.stringify({ foldersMade, created: created.map((c) => c.path) }),
  )

  // ── 让 Obsidian 自己也认 `.jps` 扩展名（否则 [[谱名.jps]] 会被建成 `谱名.jps.md`）────────
  // 事实来源：`obsidian.asar` 的 `FileManager.createNewFile`
  //   `this.fileParentCreatorByType.hasOwnProperty(n) || (n = "md")`  ← 未注册的扩展名一律回退 md
  //   而 `Workspace.openLinkText` 走的是 `createNewFile(parent, linktext)`（不带扩展名参数）
  check(
    '扩展名识别：向 Obsidian 的创建器注册 `jps`（注册后 `[[谱名.jps]]` 才建成 `谱名.jps` 而不是 `.jps.md`）',
    /registerFileParentCreator\(NEW_JPS_EXT\.slice\(1\)/.test(newFileSrcNf) &&
      /typeof fm\.registerFileParentCreator !== 'function'/.test(newFileSrcNf),
    '',
  )
  const calls: string[] = []
  const rootFolder = new StubTFolder()
  const subFolder = new StubTFolder()
  let creator: ((p: string) => unknown) | null = null
  const fmApp = {
    fileManager: {
      registerFileParentCreator: (ext: string, fn: (p: string) => unknown) => {
        calls.push('register:' + ext)
        creator = fn
      },
      unregisterFileCreator: (ext: string) => calls.push('unregister:' + ext),
    },
    vault: {
      getRoot: () => rootFolder,
      getAbstractFileByPath: (p: string) => (p === '乐谱' ? subFolder : null),
    },
  }
  registerJpsFileCreator(fmApp as never)
  check(
    '扩展名识别：注册的键就是 `jps`（不带点），并有对应的注销',
    calls.includes('register:jps') && creator !== null,
    JSON.stringify(calls),
  )
  consumeJpsLinkCreate() // 清掉注册期间可能留下的标记
  const parent = creator === null ? null : creator('乐谱/笔记.md')
  check(
    '扩展名识别：创建器给出**链接所在笔记的同级目录**，同时打上"这次要补模板"的标记',
    parent === subFolder && consumeJpsLinkCreate() === true && consumeJpsLinkCreate() === false,
    '',
  )
  check(
    '扩展名识别：目录取不到时退回**库根**（绝不返回 null——Obsidian 的创建器必须有返回）',
    jpsParentFolder(fmApp as never, '乐谱/没有这个目录/笔记.md') === rootFolder &&
      jpsParentFolder(fmApp as never, '根目录笔记.md') === rootFolder,
    '',
  )
  check(
    '扩展名识别：`dirOfPath` 取目录（`a/b/c.md` → `a/b`；根笔记 → 空串）',
    dirOfPath('a/b/c.md') === 'a/b' && dirOfPath('c.md') === '' && dirOfPath('a\\b\\c.md') === 'a/b',
    JSON.stringify([dirOfPath('a/b/c.md'), dirOfPath('c.md'), dirOfPath('a\\b\\c.md')]),
  )
  unregisterJpsFileCreator(fmApp as never)
  check('扩展名识别：注销走 Obsidian 的 `unregisterFileCreator`', calls.includes('unregister:jps'), JSON.stringify(calls))
  check(
    '扩展名识别：内部 API 不存在时**静默降级**（不抛错；点击接管那条路仍会建带模板的文件）',
    (() => {
      try {
        registerJpsFileCreator({ fileManager: {}, vault: {} } as never)
        unregisterJpsFileCreator({ fileManager: {}, vault: {} } as never)
        return true
      } catch {
        return false
      }
    })(),
    '',
  )
  check(
    '扩展名识别：空 `.jps`（Obsidian 那条路径建的）在 `vault.create` 后补默认模板，且只在标记命中时补',
    /vault\.on\('create'/.test(mainSrcNf) && /consumeJpsLinkCreate\(\)/.test(mainSrcNf) &&
      /file\.stat\.size === 0\) void this\.app\.vault\.modify\(file, NEW_JPS_TEMPLATE\)/.test(mainSrcNf) &&
      /registerJpsFileCreator\(this\.app\)/.test(mainSrcNf) &&
      /this\.register\(\(\) => unregisterJpsFileCreator\(this\.app\)\)/.test(mainSrcNf),
    '',
  )
  check('扩展名识别：标记是"一次性"的（消费后即清零，不会误伤后续创建）',
    (() => {
      markJpsLinkCreate()
      return consumeJpsLinkCreate() === true && consumeJpsLinkCreate() === false
    })(),
    '',
  )
}

// ── 谱面文本里的链接（adj652，用户要求："链接文本自动转换为链接，点击即可打开链接"）────────
{
  const U = 'https://ijipu.pages.dev'
  const scorePaneSrc652 = readFileSync('src/scorePane.ts', 'utf8')
  const openExtSrc652 = readFileSync('src/openExternal.ts', 'utf8')
  const css652 = readFileSync('styles.css', 'utf8')

  const code652 = `V: 1.0\nB: 测试\nD: C\nP: 4/4\nS: 本乐谱使用「爱记谱 ${U}」编制\nQ: 1 2 3 4 |\nC: 这 是 歌 词\n`
  const svg652 = renderScoreToSvg(layoutScore(parseJps(code652), defaultPageConfig))[0]
  const notes652 = /<text data-meta="notes_0"[^>]*>([\s\S]*?)<\/text>/.exec(svg652)
  check(
    'adj652 引擎把 `S:` 里的 URL 渲染成 `<a class="jp-link" data-href=…>`（插件用的是同一份引擎）',
    notes652 !== null &&
      /<a class="jp-link" href="https:\/\/ijipu\.pages\.dev" data-href="https:\/\/ijipu\.pages\.dev"/.test(notes652[1]),
    notes652 ? notes652[1].slice(0, 110) : '(未找到 notes_0)',
  )
  check(
    'adj652 点击由 scorePane **委托**接管（挂在 container 上，paint 重建 SVG 后依然有效）',
    /container\.addEventListener\('click'/.test(scorePaneSrc652) &&
      /closest\?\.\('a\.jp-link'\)/.test(scorePaneSrc652) &&
      /void openUrlExternally\(/.test(scorePaneSrc652),
    '',
  )
  check(
    'adj652 先 `preventDefault` 再自己打开（不让 SVG 自带的 `target="_blank"` 抢着走）',
    scorePaneSrc652.indexOf('evt.preventDefault()') < scorePaneSrc652.indexOf('void openUrlExternally('),
    '',
  )
  check(
    'adj652 桌面端走 `electron.shell.openExternal`（系统浏览器打开），非桌面端退回 `window.open`；失败弹 Notice',
    /electron\.shell\.openExternal/.test(openExtSrc652) &&
      /Platform\.isDesktopApp/.test(openExtSrc652) &&
      /window\.open\(target, '_blank'/.test(openExtSrc652) &&
      /new Notice\(`打开链接失败/.test(openExtSrc652),
    '',
  )
  check(
    'adj652 链接样式：`.ijipu-svgs a.jp-link` 手型 + 下划线（一眼看出能点）',
    /\.ijipu-svgs a\.jp-link\s*\{[^}]*cursor:\s*pointer/.test(css652) &&
      /\.ijipu-svgs a\.jp-link\s*\{[^}]*text-decoration:\s*underline/.test(css652),
    '',
  )
}

// ---- adj724b：Obsidian 社区目录**自动审核**的静态检查（Source code 一节）----
// 官方会对仓库跑一套 ESLint 规则（`eslint-plugin-obsidianmd`），其中任何 **Error** 都会让提交显示 Failed。
// 这些断言钉住"已经改对的写法"，防止后人改回被禁的 API/写法而再次被驳回。
console.log('\n[adj724b] community review: forbidden APIs / styles must stay fixed')
{
  const s = (p: string): string => readFileSync(p, 'utf8')
  const frameSrc = s('src/embed/frame.ts')
  const viewSrc = s('src/fileView.ts')
  const settingsSrc2 = s('src/settings.ts')
  const scorePaneSrc = s('src/scorePane.ts')
  const iconsSrc = s('src/icons.ts')
  const renderSrc = s('src/render.ts')
  const bridgeSrc = s('src/embed/bridge.ts')
  const mainSrc = s('src/main.ts')
  const openExtSrc = s('src/openExternal.ts')
  const cssSrc2 = s('styles.css')

  // ① 不再直接写 style（no-static-styles-assignment）
  const styleWriters = [frameSrc, viewSrc, settingsSrc2, iconsSrc].filter((src) =>
    /\.style\.(setProperty|width|height|display|border|maxHeight|flex|className)\b/.test(src),
  )
  check('adj724b 不再直接写 style（no-static-styles-assignment）', styleWriters.length === 0)
  // ② iframe 尺寸改由 CSS 类负责
  check('adj724b iframe 尺寸走 CSS 类', frameSrc.includes("addClass('ijipu-web-frame-fit')") && cssSrc2.includes('.ijipu-web-frame-fit'))
  // ③ 不再用 document.createElement / innerHTML（prefer-create-el / no-innerHTML）
  //    注意：注释里仍会**提到**这两个名字（说明为什么不用），故先剥掉行注释再判断
  const stripLineComments = (src: string): string => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('adj724b 不再用 document.createElement（prefer-create-el）',
    !/document\.createElement\(/.test(stripLineComments(iconsSrc)) &&
      !/document\.createElement\(/.test(stripLineComments(renderSrc)) &&
      !/document\.createElement\(/.test(stripLineComments(settingsSrc2)))
  // ③′ adj725d：插 SVG **优先 XML 解析**（Obsidian 的 sanitizeHTMLToDom = DOMPurify 会剥
  //    `dominant-baseline`，见 scorePane 的 svgToDom()），并保留 sanitizeHTMLToDom 作兜底
  check('adj725d 插 SVG 走 svgToDom()（XML 解析优先 + sanitizeHTMLToDom 兜底），仍不碰 innerHTML',
    !/\.innerHTML\s*=/.test(scorePaneSrc) &&
      scorePaneSrc.includes('wrap.appendChild(svgToDom(svg, plugin))') &&
      scorePaneSrc.includes("parseFromString(svg, 'image/svg+xml')") &&
      scorePaneSrc.includes("plugin.lastSvgParse = 'xml'") &&
      /return sanitizeHTMLToDom\(svg\)/.test(scorePaneSrc) &&
      /class="language-/.test(scorePaneSrc) === false)
  // ④ 命令 id 不含插件名（on obsidian 会自动加前缀）
  check('adj724b 命令 id 不含插件名', /id: 'open-app'/.test(mainSrc) && !/open-ijipu/.test(mainSrc))
  // ⑤ rAF 走 window（popout 窗口兼容）
  check('adj724b requestAnimationFrame 走 window.*',
    !/(?<!window\.)(?<!\.)\brequestAnimationFrame\(/.test(scorePaneSrc) && !/(?<!window\.)(?<!\.)\brequestAnimationFrame\(/.test(viewSrc))
  // ⑥ 删除走 FileManager.trashFile（尊重用户的删除偏好）
  check('adj724b 删除走 fileManager.trashFile（不再 vault.trash）',
    bridgeSrc.includes('fileManager.trashFile(file)') && !bridgeSrc.includes('vault.trash('))
  // ⑦ eslint 指令注释必须带描述（未描述的指令注释本身就是一个 Error）
  const directives = [openExtSrc, frameSrc, viewSrc, settingsSrc2, scorePaneSrc, iconsSrc, renderSrc, bridgeSrc, mainSrc]
    .flatMap((src) => src.split('\n').filter((line) => /eslint-disable(-next-line|-line)?\s/.test(line)))
  // ⚠ 注意：`eslint-disable` 后面紧跟的是 `-next-line`（连字符），所以**不能**写成
  // `/eslint-disable\s+\S+/`（实测永远不匹配）。这里按"是否有 `-- 说明`"判断。
  if (!directives.every((line) => /eslint-disable.*?--\s*\S/.test(line))) {
    for (const line of directives) {
      if (!/eslint-disable.*?--\s*\S/.test(line)) console.log('  未通过的行 =', JSON.stringify(line))
    }
  }
  check('adj724b eslint 指令注释都带说明（`-- 原因`）',
    directives.every((line) => /eslint-disable.*?--\s*\S/.test(line)))
  // ⑧ 设置页标题不得含插件名
  check('adj724b 设置页标题不含插件名', !/setName\('iJipu/.test(settingsSrc2) && !/setHeading\(\)[\s\S]{0,60}iJipu/.test(settingsSrc2))
  // ⑨ 不再依赖 builtin-modules 包（审核建议替换）
  const pkg = JSON.parse(s('package.json')) as { devDependencies?: Record<string, string> }
  check('adj724b 不再依赖 builtin-modules', !(pkg.devDependencies && 'builtin-modules' in pkg.devDependencies))
  check('adj724b esbuild 用 Node 内置 builtinModules',
    s('esbuild.config.mjs').includes('builtinModules') && s('esbuild.config.mjs').includes('node:module'))
  // ⑩ 引擎的"不规则空白"（全角空格 U+3000 在注释里会被判为 irregular whitespace）
  const glyphs = s('vendor/engine/render/modifierGlyphs.ts')
  check('adj724b 引擎里不再有全角空格（no-irregular-whitespace）', !glyphs.includes('\u3000'))
  // ⑪ 引擎里不再有"调试用 console.log + 禁掉 no-console"这种组合
  // ⚠ 不要用 `/no-console/` 或 `/内容左缘/` 这种宽判据：前者会命中说明文字，
  //   后者是该文件里正常存在的几何术语（实测误报过）。只钉"指令注释 + 具体那条日志"。
  const layoutSrc = s('vendor/engine/layout/index.ts')
  check('adj724b 引擎里不再禁用 no-console，也没有那条调试日志',
    !/eslint-disable[^\n]*no-console/.test(layoutSrc) && !/console\.log\(/.test(layoutSrc))
  // ⑫ 构建信息必须**可复现**（adj724b：社区审核的 Build verification 警告）
  //    指纹里的时间必须取自**提交自身**，不能是"打包那一刻"，否则同一份源码每次构建字节都不同，
  //    "审核方重建 vs Release 附件"永远对不上。
  const genInfo = s('scripts/gen-build-info.mjs')
  check('adj724b 构建信息取提交时间（可复现），不再取打包时刻',
    genInfo.includes('commitTime') && genInfo.includes("node:zlib") && !/const now = new Date\(\)/.test(genInfo))
  // ⑬ 剪贴板优先现代 API；弃用的 execCommand 只作回退
  //    ⚠ 回退**不能用 `eslint-disable` 压** —— 审核明确「Disabling '@typescript-eslint/no-deprecated'
  //    is not allowed」，写了禁用指令本身就是一条 Error（0.29.6 恰好踩中）。
  //    故这里断言：① 优先 Clipboard API；② 源码里不得出现 no-deprecated 的禁用指令。
  /**
   * adj736（用户判断：取消 frontmatter 那块内容）：设置页里那两个"复制模板"入口撤掉后，
   * 连**剪贴板回退实现**（`copyText` + `execCommand` 的绕行写法）也没有调用方了 ⇒ 一并删除。
   * 这条断言按**新口径**改：不得再出现那套实现（而不是继续断言它存在）。
   * 旧口径（adj724b）保的是"复制模板按钮在旧环境下也能用"；入口没了，这个目标随之消失。
   */
  check('adj736 设置页不再残留剪贴板回退实现（复制模板入口已撤）',
    !settingsSrc2.includes('navigator.clipboard.writeText') &&
      !settingsSrc2.includes("'exec' + 'Command'") &&
      !/eslint-disable[^\n]*no-deprecated/.test(stripLineComments(settingsSrc2)))
  // ⑭ 设置页重画用 update()（1.13+ 里 display() 不刷新声明式设置）
  check('adj724b 设置页用 this.update() 重画（不是 display()）',
    settingsSrc2.includes('this.update()') && !settingsSrc2.includes('this.display()'))
  // ⑮ SVG 元素用全局 createSvg，不用 document.createElementNS
  check('adj724b SVG 用 createSvg（不用 createElementNS）',
    scorePaneSrc.includes("createSvg('rect')") && !/document\.createElementNS\(/.test(scorePaneSrc))
  // ⑯ !important 只保留"必须反制宿主"的那几条（其余我们自己布局属性一律不加）
  // ⚠ 必须**先剥掉 CSS 注释**再计数：注释里会解释为什么保留 !important，否则把说明文字也算进去（实测踩过）
  const cssNoComments = cssSrc2.replace(/\/\*[\s\S]*?\*\//g, '')
  const importantCount = (cssNoComments.match(/!important/g) ?? []).length
  check('adj724b styles.css 的 !important 收敛到 ≤5 条（仅反制宿主所必需）', importantCount <= 5)
  // ⑰ adj738：原来这条守的是"frontmatter **只对 ` ```jps ` 代码块生效**"（嵌入与完整编辑器硬编码 null）。
  //    整层删除后口径变成：**三条渲染路径都不再读笔记 frontmatter**，`getFrontmatter` 这个约定也没了。
  const embedApiSrc = s('src/embed.ts')
  const fileViewApiSrc = s('src/fileView.ts')
  const mainApiSrc = s('src/main.ts')
  check('adj738 三条渲染路径都不再读笔记 frontmatter（`getFrontmatter` 约定随该层删除）',
    !/getFrontmatter/.test(embedApiSrc) &&
      !/getFrontmatter/.test(fileViewApiSrc) &&
      !/getFrontmatter/.test(mainApiSrc) &&
      // 只禁"读笔记的 frontmatter 字段"；`metadataCache` 本身还用于正常的链接解析，不能一并禁掉
      !/metadataCache[\s\S]{0,80}?\.frontmatter/.test(mainApiSrc) &&
      !existsSync('src/frontmatter.ts'))
  /**
   * ⑱ adj736（用户判断：取消 frontmatter 那块）：说明页不再讲 frontmatter，
   * 改为**一句话指路**——设置写在**谱面里的 `# jps-config`**（跟谱走、可逐个代码块写），
   * 并告诉用户能用工具条的「设置」按钮可视化改、自动写回。
   *
   * 旧口径（adj724b）要求"说明页写明 frontmatter 仅对代码块生效"——
   * 那是为了让用户别误以为它对嵌入的 `.jps` 也生效；现在整块撤掉，这个误解自然不存在了。
   * ⚠ 引擎/插件对笔记 frontmatter 的**读取**路径仍在（老笔记里的 `ijipu_*` 继续生效，不破坏既有用户），
   * 只是不再在界面上宣传；要不要连支持一起删，等用户定。
   */
  check('adj736 说明页改为指路 `# jps-config`（不再讲 frontmatter）',
    settingsSrc2.includes('谱面设置写在哪里（跟着谱走）') &&
      settingsSrc2.includes('# jps-config') &&
      settingsSrc2.includes('每块各自写自己的') &&
      // 负对照去注释再判（注释里会写到这两个按钮名——adj734 那次已经栽过一回）
      !stripLineComments(settingsSrc2).includes('复制 frontmatter 模板') &&
      !stripLineComments(settingsSrc2).includes('复制最小模板'))
  // ⑲ 低频的「复制全部键名」已移除（模板里已含键名，清单本身不能直接生效）
  check('adj724b 已移除「复制全部键名」按钮', !settingsSrc2.includes('复制全部键名'))
  // ⑳ 新增「复制最小模板」：只含与默认不同的项
  // ㉑ 「谱面」视图必须裁到**真实内容**（用户要求：不要四周空白），且不得踩两个已知陷阱
  //    ① **不能**用 `svgEl.getBBox()` —— 引擎第一层是整页白底 `<rect data-page-bg>`，
  //       对 svg 求 bbox 会把它算进去 ⇒ 等于没裁（这是最容易写错的一点）；
  //    ② 量取必须发生在**插入 DOM 之后**（getBBox 要渲染树）、**辅助虚线层之前**（否则会量进虚线）。
  //    真实裁剪几何由 `scripts/verify-score-crop.mjs` 在 Chrome 里验证（Node 里没有 getBBox）。
  check('adj724b 「谱面」视图按真实内容包围盒裁剪（排除整页白底、量在插入之后）',
    /function measureContentBox\(svgEl: SVGSVGElement\)/.test(scorePaneSrc) &&
      /getAttribute\('data-page-bg'\)/.test(scorePaneSrc) &&
      /const box = measureContentBox\(svgEl\)/.test(scorePaneSrc) &&
      /svgEl\.dataset\.contentBox = /.test(scorePaneSrc) &&
      /const box = contentBoxOf\(svgEl\)/.test(scorePaneSrc))
  //    ③ 量到的盒**必须真的比整页小**（容差 2%）才用它 —— 防止 `getBBox()` 把整页白底算进来
  //       导致"裁剪等于没裁"（现象正是"谱面还是 A4 那么大空白"）；不满足则退回边距兜底。
  check('adj724b 裁剪以"实测内容盒"为主路径，且要求它真的比整页小（否则退回边距兜底）',
    /if \(box && shrunk\) \{[\s\S]{0,900}?\} else \{[\s\S]{0,900}?margin_left/.test(scorePaneSrc) &&
      /const shrunk = .*box\.h < h \* 0\.98/.test(scorePaneSrc))

  /**
   * ㉒ ` ```jps ` 代码块是**长期特性**，不得因为"有 .jps 文件了"就把它当过渡用法删掉。
   *
   * 用户 2026-10 明确：「` ```jps ` 还是有存在的必要的，这在**单行/部分乐谱的展示**尤其有用，应该保留」。
   * 它不可替代的场景：笔记里只想放一两句谱、或"一句谱 + 一段讲解"穿插 ——
   * 十几字节的源码直接写在笔记里，不必为一句谱单独建一个 `.jps` 文件；
   * 一个笔记里放多个片段、各自调排版试效果，也只有代码块能做到（嵌入只能用多个文件）。
   *
   * 本断言钉住三件事：① 代码块处理器仍注册；② 说明/文档里仍把它当推荐用法之一；
   * ③ 文档里明确写出"两种用法取舍"，避免以后有人再提"取消代码块"。
   */
  const readmeSrc = s('README.md')
  check('adj724b ` ```jps ` 代码块仍是长期特性（处理器注册 + 文档并列说明）',
    /registerMarkdownCodeBlockProcessor\(\s*'jps'/.test(mainApiSrc) &&
      readmeSrc.includes('代码块还是') &&
      readmeSrc.includes('单行 / 片段乐谱'))

  /**
   * ㉓ 工具条**默认隐藏、悬停才显示**（用户要求：避免 Obsidian「导出为 PDF」把操作界面一起导出）。
   *
   * 三条实现要点都在断言里（真实浏览器行为另由 `ijipu/scripts/verify-score-crop.mjs` 验证）：
   *  ① CSS 用 `visibility: hidden`（不是只降 `opacity`：透明元素仍会被绘制、仍能 Tab 聚焦）；
   *  ② 移动端 / 触屏常显（没有 hover，隐藏后按钮点不到）；
   *  ③ JS 侧有 pointermove 显示 + pointerleave 收起，且**键盘有入口**
   *     （隐藏时不可聚焦 ⇒ 必须有容器级 keydown 唤醒，否则键盘用户看不到工具条）。
   * ⚠ adj725 起工具条落在**块外**正上方 —— 由此产生的"宿主 widget 容器悬停裁剪"由
   *   `.ijipu-cm-host` 处理（见下面 adj725 那一节）。
   */
  const cssToolbar = s('styles.css')
  /**
   * 工具条：**绝对定位浮在谱面块外侧正上方、悬停淡入、谱面不位移**（用户要求）。
   *
   * ⚠ 刻意不写"尺寸块里不得有 display:flex"那种负向正则，也不数"规则条数"：
   * 实测两者都会自伤 —— `.ijipu-score-toolbar\s*\{` 允许零个空白 ⇒ 会误命中
   * `.is-mobile .ijipu-score-toolbar {…}`；条数会随 `@container`/媒体查询变化。
   * 只盯**真正的不变量**。
   */
  check('adj724b 工具条绝对定位（不占布局 ⇒ 谱面不位移）',
    /\.ijipu-score\s*\{[^}]*position:\s*relative/.test(cssToolbar) &&
      /\.ijipu-score-toolbar\s*\{[^}]*position:\s*absolute/.test(cssToolbar) &&
      /\.ijipu-score-toolbar\s*\{[^}]*z-index:\s*\d/.test(cssToolbar))
  check('adj724b 工具条默认不可见（visibility:hidden，导出不出现）→ 悬停淡入 → 移动端常显',
    /\.ijipu-score-toolbar\s*\{[^}]*visibility:\s*hidden/.test(cssToolbar) &&
      /\.ijipu-score-toolbar\s*\{[^}]*opacity:\s*0/.test(cssToolbar) &&
      /\.ijipu-score-toolbar\.is-revealed\s*\{[^}]*visibility:\s*visible/.test(cssToolbar) &&
      /\.ijipu-score-toolbar\.is-revealed\s*\{[^}]*opacity:\s*1/.test(cssToolbar) &&
      /\.is-mobile\s+\.ijipu-score-toolbar\s*\{[^}]*visibility:\s*visible/.test(cssToolbar) &&
      // 淡入淡出靠 transition（visibility 延迟到淡出结束再隐藏）
      /\.ijipu-score-toolbar\s*\{[^}]*transition:[\s\S]{0,80}?visibility 0s linear/.test(cssToolbar))
  /**
   * ⚠ adj724b 两个**实测真因**，任何一条写回去都会让浮层坏掉：
   *  ① `container-type: inline-size` **不能留在工具条自身上** —— 绝对定位 + 尺寸包含 ⇒ 内在宽度算成 0，
   *     实测 `width: 8px`（只剩 padding）、按钮被挤成竖排、背景看不出边界。
   *     容器查询必须挂到外层 `.ijipu-score`（按窗外可用宽度判断，也更符合原意）。
   *  ② 背景要带**兜底值**（`var(--background-secondary, …)`）——否则在没有该主题变量的环境里全透明。
   */
  {
    // ⚠ 必须**先剥掉 CSS 注释**再检查：本轮反复踩同一个坑 ——
    //    "解释为什么不能用 X"的注释里就写着 X，宽判据会把它当成真的用了 X。
    const cssNoComments = cssToolbar.replace(/\/\*[\s\S]*?\*\//g, '')
    const toolbarBlocks = [...cssNoComments.matchAll(/\.ijipu-score-toolbar\s+\{([^}]*)\}/g)].map((m) => m[1])
    const toolbarHasContainerType = toolbarBlocks.some((b) => b.includes('container-type'))
    const outerHasContainer = cssNoComments.includes('container-name: ijipu-score')
    const outerHasContainerType = cssNoComments.includes('container-type: inline-size')
    const queryRenamed = cssNoComments.includes('@container ijipu-score (max-width: 400px)')
    check('adj724b 工具条自身不得再挂 container-type（会把浮层宽度算成 0）',
      toolbarBlocks.length > 0 && !toolbarHasContainerType && outerHasContainer && outerHasContainerType && queryRenamed,
      `工具条块数=${toolbarBlocks.length} 工具条含container-type=${toolbarHasContainerType} 外层容器=${outerHasContainer}/${outerHasContainerType} 查询已改名=${queryRenamed}`)
  }
  check('adj724b 工具条浮层背景带主题变量兜底（否则无该变量的环境里看不清边界）',
    /\.ijipu-score-toolbar\s*\{[^}]*background:\s*var\(--background-secondary,/.test(cssToolbar))
  check('adj724b 工具条悬停显示/离开收起 + 键盘可唤醒',
    /addEventListener\('pointermove', onPointerMove\)/.test(scorePaneSrc) &&
      /addEventListener\('pointerleave', onPointerLeave\)/.test(scorePaneSrc) &&
      /addEventListener\('keydown', onKeyDown\)/.test(scorePaneSrc) &&
      /toggleClass\('is-revealed', on\)/.test(scorePaneSrc))
}

/**
 * ---- adj725：` ```jps ` 预览的三条用户口径 ----
 *
 * 用户 2026-10 原话：
 *  ① 「默认 ```jps 以无空白方式显示，即只显示有墨迹的部分，建议谱面周围保留 2px 的留白」
 *  ② 「切源码方式是在预览的笔记源码间切换，源码如图，不要再单独的 textarea」
 *  ③ 「浮动工具条显示在预览区外侧左上角，不要显示在预览区内部」+「编辑切换如图的右上角方式」
 *
 * 三条都直接对着"用户看到的界面"，所以断言钉的是**界面契约**（位置/留白/显隐/去哪儿编辑），
 * 真实几何与裁剪由 `ijipu/scripts/verify-score-crop.mjs` 在 Chrome 里量（含 Obsidian 的 app.css）。
 */
console.log('\n[adj725] ```jps preview: 2px 留白 / 工具条在块外侧 / 源码切回笔记')
{
  const s725 = (p: string): string => readFileSync(p, 'utf8')
  const css725 = s725('styles.css')
  const pane725 = s725('src/scorePane.ts')
  const main725 = s725('src/main.ts')
  const embed725 = s725('src/embed.ts')
  const settings730 = s725('src/settings.ts')
  // ⚠ 老规矩：先剥注释 —— "解释为什么不能用 X"的注释里就写着 X（本项目因此误判过多次）
  const css725nc = css725.replace(/\/\*[\s\S]*?\*\//g, '')

  // ① 默认"无空白"：谱面块四周只剩 2px（原来是 0.4em ≈ 6.4px 的灰底内边距）
  check('adj725 谱面块四周只留 2px 留白（默认"只显示有墨迹的部分"）',
    /\.ijipu-score\s*\{[^}]*padding:\s*2px/.test(css725nc) && !/\.ijipu-score\s*\{[^}]*padding:\s*0\.4em/.test(css725nc))
  check('adj725 默认显示模式仍是「谱面」（裁到墨迹）', /let paneMode: ViewMode = 'score'/.test(pane725))

  // ② 工具条浮到**块外侧**正上方、左缘对齐（不再压在谱面上）
  check('adj725 工具条浮在块外侧正上方（bottom: calc(100% + 2px) / left: 0）',
    /\.ijipu-score-toolbar\s*\{[^}]*position:\s*absolute/.test(css725nc) &&
      /\.ijipu-score-toolbar\s*\{[^}]*bottom:\s*calc\(100%\s*\+\s*2px\)/.test(css725nc) &&
      /\.ijipu-score-toolbar\s*\{[^}]*left:\s*0/.test(css725nc) &&
      // 旧写法（块内左上角）必须消失，否则会退回"压住谱面"
      !/\.ijipu-score-toolbar\s*\{[^}]*top:\s*4px/.test(css725nc))
  /**
   * ②b **实时预览的裁剪必须放开**（这条不做的话，②在真实宿主里等于没做）：
   * Obsidian 的 app.css 有 `.cm-embed-block:hover { overflow: hidden }`，
   * 而工具条**正是悬停才显示、且落在块外** ⇒ 会被整条裁掉。
   */
  check('adj725 实时预览 widget 容器悬停时的裁剪被放开（.ijipu-cm-host）',
    /\.cm-embed-block\.ijipu-cm-host:hover\s*\{[^}]*overflow:\s*visible/.test(css725nc) &&
      pane725.includes('closest(CM_EMBED_BLOCK)') &&
      pane725.includes("addClass('ijipu-cm-host')") &&
      pane725.includes("removeClass('ijipu-cm-host')"))

  /**
   * adj773（用户要求 2/3）：**块右上角那枚 `</>` 已整块移除** —— 编辑入口统一成工具条最后那枚「编辑」
   * （带笔图标、桌面与手机端都在、代码块 ⇒ 切该块源码）。
   *
   * 这三条原来是钉 `</>` 的（位置/悬停/div 形态/让位逻辑），随功能删除一并改成**反向判据**：
   * 一旦有人把 `</>` 加回来（同一处又出现两个"编辑"入口），这里立刻红灯。
   * ⚠ 负向判据先剥注释 —— 源码里留了一句"这里原本创建 `</>`，已删除"的说明。
   */
  {
    const paneCode = pane725.replace(/\/\*[\s\S]*?\*\//g, '')
    check('adj773 `</>` 已移除：三处预览只有工具条那一枚编辑入口（`ijipu-edit-btn`）',
      !/ijipu-edit-source-btn/.test(paneCode) &&
        !/editSourceBtn/.test(paneCode) &&
        /ijipu-edit-btn/.test(paneCode) &&
        // 统一后的编辑按钮对代码块这一支就是"切该块源码"
        /host\.onEditSource\(\)/.test(paneCode))
    /**
     * 负对照：把 `</>` 的创建语句"放回去"，那条"不存在"判据就**不再成立**（说明它真的在判）。
     * 写法：断言**篡改样本里能搜到**该构造 —— 即"不存在"谓词在篡改样本上为假。
     */
    check('adj773 负对照：把 `</>` 创建语句放回去，"不存在"判据即为假',
      /ijipu-edit-source-btn/.test(`${paneCode}\nconst btn = container.createDiv({ cls: 'ijipu-edit-source-btn' })`))
  }

  /**
   * ③c adj737：**宿主块上的 `ijipu-cm-host` 类必须能重打**（实时预览里 CM6 会换掉那个块容器）。
   * 类一丢 ⇒ 宿主 `.cm-embed-block:hover{overflow:hidden}` 会把浮在块外的工具条整条裁掉
   * （`</>` 同时退回主题色）—— 用户看到的就是"编辑模式下什么都没有"。
   */
  check('adj737/761/769 落位判定时确认宿主块的 `ijipu-cm-host` 类（CM6 换容器后类会丢）',
    /const decidePlacement = \(el: HTMLElement\): void => \{[\s\S]{0,600}?markHostWidget\(\)/.test(pane725) &&
      /if \(!widget\.hasClass\('ijipu-cm-host'\)\) widget\.addClass\('ijipu-cm-host'\)/.test(pane725) &&
      /hostWidgetEl\?\.removeClass\('ijipu-cm-host'\)/.test(pane725))

  /**
   * adj740（用户第二次报「编辑视图下工具条还是不可见」）：**裁剪不止一层**。
   *
   * 实时预览里我们的面板外面还有 `.cm-editor > .cm-scroller > .cm-content > .cm-line …` 一整套，
   * 任何一层 `overflow: hidden/clip` 都能把浮在块外的工具条整条裁掉。修法必须**逐层放开**，
   * 但**滚动容器绝不放开**（放开它编辑器就滚不动了）。同时把实测快照记进设置页诊断 ——
   * 这样"到底哪一层在挡"能靠一张截图定位，而不是继续猜。
   */
  {
    // 逐条算出布尔值再断言（失败时 detail 直接点名哪一条不成立，省一轮排查）
    const c743 = {
      从container起: /let el: HTMLElement \| null = container$/m.test(pane725),
      滚动判据: /const scrollByDesign = \/auto\|scroll\/\.test\(cs\.overflowY\) \|\| \/auto\|scroll\/\.test\(cs\.overflowX\)/.test(pane725),
      只放开cm层: /const isCmLayer = el\.hasClass\('cm-editor'\) \|\| el\.className\.includes\('cm-'\)/.test(pane725),
      宿主骨架不动: pane725.includes('是宿主骨架'),
      加类: /el\.addClass\('ijipu-cm-noclip'\)/.test(pane725),
      记类: /noClipEls\.add\(el\)/.test(pane725),
      // adj745：销毁时两类都摘（裁剪类 + contain 类），一个都不留
      摘类: /el\.removeClass\('ijipu-cm-noclip'\)/.test(pane725) && /el\.removeClass\('ijipu-cm-nocontain'\)/.test(pane725),
      css规则: css725nc.includes('.ijipu-cm-noclip {'),
    }
    check('adj740/742/743 逐层放开"会裁剪的祖先"，且**绝不放开滚动容器 / 宿主骨架**',
      /const exemptClippingAncestors = \(\): string\[\] => \{/.test(pane725) &&
        /\/hidden\|clip\/\.test\(cs\.overflowY\)/.test(pane725) &&
        Object.values(c743).every(Boolean),
      JSON.stringify(c743))
  }
  check('adj742/743 诊断行含"命中测试/视口内/内容(子元素+innerText)/contain 等"（回答"样式正常为何看不见"）',
    // 宿主选择器不再只认 `.cm-embed-block`（代码块常用 `.cm-preview-code-block`）
    /const CM_EMBED_BLOCK = '\.cm-embed-block, \.cm-preview-code-block'/.test(pane725) &&
      /document\.elementFromPoint\(cx, cy\)/.test(pane725) &&
      /视口内=\$\{inViewport/.test(pane725) &&
      /extra\.push\(`contain=\$\{cs\.contain\}`\)/.test(pane725) &&
      // adj743：工具条**肚子里的东西**也要量（空盒子 ⇒ 容器查询/主题把内容隐了）
      /const kids = Array\.from\(toolbarEl\.children\) as HTMLElement\[\]/.test(pane725) &&
      /子元素 0 个/.test(pane725) &&
      /innerText=\$\{text\.length > 0/.test(pane725) &&
      /bg=\$\{cs\.backgroundColor\}/.test(pane725) &&
      // CSS：宿主类规则不挑容器类名 + 显示态兜底（整条工具条与其中的按钮/图标/文字都强制可见）
      /\.ijipu-cm-host\.ijipu-cm-host:hover \{/.test(css725nc) &&
      /\.ijipu-score-toolbar\.is-revealed \.ijipu-btn-label/.test(css725nc))
  {
    const fv744 = String(readFileSync('src/fileView.ts', 'utf8'))
    const pane749 = String(readFileSync('src/scorePane.ts', 'utf8'))
    check('adj744/749 手机端「编辑」用 Obsidian 自己的编辑器（源码模式），并保留 textarea 回退',
      /toggleSource\(\): void \{[\s\S]{0,160}?if \(Platform\.isMobile\) \{[\s\S]{0,80}?this\.openInObsidianEditor\(\)/.test(fv744) &&
        /setViewState\(\{ type: 'markdown', state: \{ file: file\.path, mode: 'source', source: true \}, active: true \}\)/.test(fv744) &&
        // 回退判据：一帧后 leaf 里装的仍是本视图 ⇒ 宿主拒开 ⇒ 用内联 textarea
        //（adj749 修：不再用"按钮还在不在 DOM 里"判断——浮动工具条上的按钮会随面板重建，会误判）
        /window\.requestAnimationFrame\(\(\) => \{\s*if \(this\.leaf\.view !== this\) return\s*this\.editing = true/.test(fv744) &&
        // 手机端回退框给高度下限（免得回退路径又是"框太矮"）
        /\.is-mobile \.ijipu-file-view\.ijipu-file-editing \.ijipu-source-editor \{/.test(css725nc) &&
        /min-height: 50vh/.test(css725nc),
      `toggleSource=${/toggleSource/.test(fv744)} fallback=${/this\.leaf\.view !== this/.test(fv744)}`)
    /**
     * adj749b（用户要求）：「源码」按钮**统一叫「编辑」**；并且预览态的「编辑 / 格式化」
     * 放在**谱面浮动工具条**上（手机端它常显），文件栏预览态只留文件名 ⇒ 两者不再互相遮挡。
     */
    check('adj749/adj773 预览态「编辑」在浮动工具条上（文件栏预览态只留文件名），三处按钮名统一为「编辑」且用带笔图标',
      /host\.onToggleSource/.test(pane749) &&
        // adj773：编辑按钮统一成一枚（`ijipu-edit-btn`，位置在"视图"之后，带笔图标）
        /const eb = toolbar\.createEl\('button', \{ cls: 'ijipu-play ijipu-edit-btn' \}\)/.test(pane749) &&
        /eb\.appendChild\(editIcon\(15\)\)/.test(pane749) &&
        /eb\.createSpan\(\{ cls: 'ijipu-btn-label', text: '编辑' \}\)/.test(pane749) &&
        // 右上角那枚 `</>` **已整块删除**（不是"建好再撤"）——见上面 `adj773 </> 已移除` 那条
        !/ijipu-edit-source-btn/.test(pane749.replace(/\/\*[\s\S]*?\*\//g, '')) &&
        !/ijipu-btn-label', text: '源码' \}/.test(pane749) &&
        /if \(this\.editing\) \{/.test(fv744) &&
        /const toggle = bar\.createEl\('button', \{ cls: 'ijipu-btn', text: '📖 看谱' \}\)/.test(fv744) &&
        // 文件栏在**编辑态**才给按钮（预览态无按钮 ⇒ 与浮动工具条不重叠）
        !/text: '✎ 源码'/.test(fv744))
  }

  {
    const fv744b = String(readFileSync('src/fileView.ts', 'utf8'))
    check('adj744b 借宿主编辑器时把该页签标记为"纯文本源码"（中和 Markdown 着色），返回时摘掉',
      /leafEl\?\.addClass\('ijipu-plain-source'\)/.test(fv744b) &&
        /closest\('\.workspace-leaf'\)\?\.removeClass\('ijipu-plain-source'\)/.test(fv744b) &&
        /\.workspace-leaf\.ijipu-plain-source \.cm-content \.cm-line span/.test(css725nc) &&
        /\.workspace-leaf\.ijipu-plain-source \.cm-content \.cm-line a/.test(css725nc) &&
        /color: var\(--text-normal\)/.test(css725nc) &&
        // 不许用 !important 压（本项目有 ≤5 条硬上限）
        !/ijipu-plain-source[\s\S]{0,400}?!important/.test(css725nc))
  }

  /**
   * adj745（用户诊断的决定性一击）：`![[xxx.jps]]` 的 `.internal-embed` 带 **`contain: paint`**
   * ⇒ 浮在嵌入框**外侧**的工具条每次都被它裁掉，而 `contain` **不体现在 `overflow` 上**
   * （前几轮改 `overflow` 全打偏）。修法：对我们**自己的**元素把 `contain` 降级为 `layout style`。
   */
  check('adj745 把我们自己元素上的 `contain: paint/strict/content` 降级为 `layout style`（宿主骨架不动）',
    /const isOurs = el\.hasClass\('ijipu-embed'\) \|\| el\.hasClass\('ijipu-score'\) \|\| el\.hasClass\('block-language-jps'\)/.test(pane725) &&
      /const canTouch = isCmLayer \|\| isOurs/.test(pane725) &&
      /if \(canTouch && \/paint\|strict\|content\/\.test\(cs\.contain\)\)/.test(pane725) &&
      /el\.addClass\('ijipu-cm-nocontain'\)/.test(pane725) &&
      /contain=\$\{cs\.contain\}→改为 layout style/.test(pane725) &&
      /\.ijipu-cm-nocontain\.ijipu-cm-nocontain \{/.test(css725nc) &&
      /contain: layout style/.test(css725nc))

  /**
   * adj746（用户要求：「源码如果能够按我们应用的规范格式化就更好了」）：
   * 插件**直接用引擎里那份应用自己的格式化器** `formatJps`（规则实现自 JPS 规范，
   * 应用编辑器输入时用的就是同一个 `formatLine`）——不另写一套，"规范"只有一处定义。
   *
   * 断言分两层：
   *  ① 结构：三处入口都真的接了它（文件视图按钮 + 命令面板 + 代码块工具条），且都走引擎；
   *  ② 口径：**应用自带示例谱在该格式化器下是不动点**（`formatJps(sample) === sample`）——
   *     这正是"应用规范"的可执行定义。拿不到应用仓库时跳过（插件 CI 只有本仓库）。
   */
  {
    const fv746 = String(readFileSync('src/fileView.ts', 'utf8'))
    const main746 = String(readFileSync('src/main.ts', 'utf8'))
    check('adj746 格式化入口接的是**引擎**的 formatJps（文件视图 / 命令面板 / 代码块工具条）',
      /import \{ formatJps \} from '@ijipu\/engine'/.test(fv746) &&
        /const next = formatJps\(this\.data\)/.test(fv746) &&
        /if \(next === this\.data\)/.test(fv746) &&
        /id: 'format-jps'/.test(main746) &&
        /getActiveViewOfType\(IJipuFileView\)/.test(main746) &&
        /import \{[^}]*formatJps[^}]*\} from '@ijipu\/engine'/.test(String(readFileSync('src/scorePane.ts', 'utf8'))) &&
        /const next = formatJps\(before\)/.test(String(readFileSync('src/scorePane.ts', 'utf8'))))

    // 幂等：格式化两次等于一次
    const messy = 'V:1.0\nB:  测试\nQ:1 2  3 4|5\nC:  词 {tp 1  2| 3}\n'
    const once = formatJps(messy)
    check('adj746 格式化幂等（第二次不再改动）', formatJps(once) === once, JSON.stringify(once))

    const samplesDir = '../ijipu/public/samples'
    if (existsSync(samplesDir)) {
      const files = readdirSync(samplesDir).filter((f) => f.endsWith('.jps'))
      const changed = files.filter((f) => {
        const src = String(readFileSync(`${samplesDir}/${f}`, 'utf8'))
        return formatJps(src) !== src
      })
      check(`adj746 应用自带示例谱（${files.length} 份）在格式化下是**不动点** ⇒ 这就是"应用规范"`,
        files.length > 0 && changed.length === 0, `被改动：${changed.join(',')}`)
    }
  }

  /**
   * adj748（用户报：「jps 文件的源码模式切回**阅读模式**，还是源码，只是显示方式不同，
   * 而不是我们所希望的**预览视图**」）：
   *
   * 期望的心智模型 = **源码模式 → 宿主编辑器；阅读模式 → 我们的谱面预览**。
   * 由于 `adj744` 把页签换成了宿主的 markdown 视图（源码模式），用户再切阅读模式时
   * 宿主的 markdown 阅读视图仍会渲染同一个文件（所以"还是源码"）。
   * 修法：监听布局变化，把"躺在 markdown **阅读模式**里的 `.jps`"重新按扩展名打开
   * （`.jps` 注册给本插件的文件视图 ⇒ 自动换回谱面预览）；**源码模式一律不动**（那是用户要的编辑态）。
   */
  {
    const main748 = String(readFileSync('src/main.ts', 'utf8'))
    check('adj748 阅读模式里的 `.jps` 自动换回谱面预览（源码模式不动；三处判据齐备）',
      /private restoreJpsPreview\(\): void \{/.test(main748) &&
        /getLeavesOfType\('markdown'\)/.test(main748) &&
        /file\.extension !== JPS_EXTENSION/.test(main748) &&
        /view\.getMode\(\) !== 'preview'/.test(main748) &&
        /void leaf\.openFile\(file\)/.test(main748) &&
        // 三个工作区事件都要挂（模式切换在不同 Obsidian 版本里触发的事件名不完全一样），并做一帧合并
        /on\('layout-change', schedulePreviewRestore\)/.test(main748) &&
        /on\('active-leaf-change', schedulePreviewRestore\)/.test(main748) &&
        /on\('file-open', schedulePreviewRestore\)/.test(main748) &&
        /this\.previewRestorePending = true/.test(main748),
      `restore=${/restoreJpsPreview/.test(main748)} guard=${/getMode\(\) !== 'preview'/.test(main748)}`)
  }

  /**
   * adj751（用户第三轮报「很顽固呀，工具条还是没有显示」）：
   * 诊断里 **命中测试命中的是 `div.cm-line`** ⇒ "浮到块外侧"在这个宿主（`.jps` 嵌入 + CM6 实时预览）
   * 被某层裁剪，而 `overflow`/`contain` 都不是（前者没报裁剪层、后者已降级）。
   * 宿主的裁剪机制不可能穷举 ⇒ 改为**自愈**：命中失败就把工具条**贴回块内**（祖先的裁剪框
   * 至少包含块本身 ⇒ 块内一定不会被裁），并在诊断里记下"兜底 + 复测结果"。
   */
  check('adj751/755 工具条命中失败时自愈（先放宽上游、再贴回块内），且**每个面板只判定一次**（不再每次显示重判 ⇒ 不闪动）',
    /const hitSelf = hit !== null && toolbarEl\.contains\(hit\)/.test(pane725) &&
      /if \(!hitSelf && inViewport && !wasInside\) \{/.test(pane725) &&
      /toolbarEl\.addClass\('ijipu-toolbar-inside'\)/.test(pane725) &&
      /放宽上游/.test(pane725) &&
      /\.ijipu-score-toolbar\.is-revealed\.ijipu-toolbar-inside \{/.test(css725nc) &&
      /top: 2px;/.test(css725nc))

  /**
   * adj749c（用户要求，手机端）：
   *  a) 格式化按钮**不再借用"排版"图标**（用户报"图标与排版重复"）⇒ 用新加的 `formatIcon`；
   *  b) **预览态不放格式化按钮**（"应该是源码状态才需要格式化，而不是预览，位置不对"）——
   *     `.jps` 文件视图的格式化在**源码态文件栏**上（`adj749`），预览态工具条只剩「编辑」；
   *  c) **自动格式化**：与应用同款"光标离开本行时格式化该行"，走 Obsidian 公开 `Editor` API
   *     （不引入 `@codemirror/*` 依赖），且只对带 `ijipu-plain-source` 标记的 `.jps` 页签生效。
   */
  check('adj749c 格式化按钮用专属图标；预览态（有「编辑」）不再放格式化按钮',
    /export function formatIcon\(size = 15\): SVGSVGElement \{/.test(String(readFileSync('src/icons.ts', 'utf8'))) &&
      /fmtBtn\.appendChild\(formatIcon\(15\)\)/.test(pane725) &&
      /if \(host\.onFormat && !host\.onToggleSource\) \{/.test(pane725) &&
      !/fmtBtn\.appendChild\(layoutIcon\(15\)\)/.test(pane725))
  {
    const main751 = String(readFileSync('src/main.ts', 'utf8'))
    check('adj749d 自动格式化：光标离开本行时按应用规范格式化该行（仅 .jps 页签，公开 Editor API）',
      /registerDomEvent\(document, 'selectionchange', \(\) => this\.autoFormatLeavingLine\(\)\)/.test(main751) &&
        /private autoFormatLeavingLine\(\): void \{/.test(main751) &&
        /const after = formatLine\(before\)/.test(main751) &&
        /editor\.setLine\(prevLine, after\)/.test(main751) &&
        /file\.extension !== JPS_EXTENSION/.test(main751) &&
        /hasClass\('ijipu-plain-source'\)/.test(main751) &&
        /import \{ formatLine \} from '@ijipu\/engine'/.test(main751),
      `auto=${/autoFormatLeavingLine/.test(main751)} setLine=${/setLine\(/.test(main751)}`)
  }

  /**
   * adj752（用户要求）：「给手机端的源码使用**应用里的源码高亮方案**，而不是 Markdown 的高亮方案」。
   *
   * 做法：着色**规则**抽到引擎（`tokenizeJpsLine` 等），应用渲染 HTML、插件渲染 CM6 decoration；
   * 插件的颜色用应用 `--jp-hl-*` 的两套原值。
   * 断言分两层：① 插件确实只"接线"（不自己实现规则）且只对 `.jps` 页签生效；
   * ② **分词器行为**（在插件侧跑一遍证据：各类别命中 + token 覆盖整行、偏移不错位）。
   */
  {
    const hlSrc = String(readFileSync('src/jpsHighlight.ts', 'utf8'))
    check('adj752/762 插件用 CM6 扩展给 `.jps` 源码上应用那套高亮（规则与**模型**都来自引擎，只碰带标记的页签）',
      /import \{[^}]*highlightLineModel[^}]*\} from '@ijipu\/engine'/.test(hlSrc) &&
        // 插件**不再自带**分词规则（规则在引擎；插件只做"模型 → decoration"映射）
        // ⚠ 负对照要**去注释**再判（插件文件头会写到 `tokenizeJpsLine` 这个来源名）
        !/tokenizeJps(Line|Music|Lyric)/.test(hlSrc.replace(/\/\*[\s\S]*?\*\//g, '')) &&
        /const model = highlightLineModel\(line\.text, line\.number/.test(hlSrc) &&
        /ViewPlugin\.fromClass/.test(hlSrc) &&
        /Decoration\.mark\(\{ class: name \}\)/.test(hlSrc) &&
        /closest\('\.workspace-leaf\.ijipu-plain-source'\)/.test(hlSrc) &&
        /registerEditorExtension\(jpsHighlightExtension\)/.test(String(readFileSync('src/main.ts', 'utf8'))) &&
        // 依赖显式声明（运行期仍由 Obsidian 提供，构建时 external ⇒ 不增产物）
        /"@codemirror\/state"/.test(String(readFileSync('package.json', 'utf8'))) &&
        /"@codemirror\/view"/.test(String(readFileSync('package.json', 'utf8'))))
    /**
     * adj763（清单 B5）：`.ijipu-jps-*` 的色值必须与**引擎色板**一致 ——
     * Obsidian 侧只能是静态 CSS，所以这里用**断言**把 CSS 与引擎常量钉在一起：
     * 应用那边改配色时本仓库立刻红灯（此前靠人手抄，抄漏了没人知道）。
     */
    {
      const missingDark = Object.values(JPS_HIGHLIGHT_COLORS.dark).filter((v) => !css725nc.includes(`color: ${v}`))
      const missingLight = Object.values(JPS_HIGHLIGHT_COLORS.light).filter((v) => !css725nc.includes(`color: ${v}`))
      check('adj752/763 高亮配色取自引擎色板的两套值（深/浅主题各一套，逐色核对）',
        css725nc.includes('.ijipu-jps-note') &&
          missingDark.length === 0 &&
          missingLight.length === 0 &&
          css725nc.includes('.theme-light .workspace-leaf.ijipu-plain-source') &&
          /\.ijipu-jps-pagebreak/.test(css725nc),
        `缺深色=${missingDark.join(',')} 缺浅色=${missingLight.join(',')}`)
      check('adj763 错误/告警配色与引擎一致（行底 / 块底 / 外框线色）',
        css725nc.includes(JPS_PROBLEM_COLORS.error.lineBg) &&
          css725nc.includes(JPS_PROBLEM_COLORS.warning.lineBg) &&
          css725nc.includes(JPS_PROBLEM_COLORS.error.blockBg) &&
          css725nc.includes(JPS_PROBLEM_COLORS.warning.blockBg) &&
          css725nc.includes(JPS_PROBLEM_COLORS.error.outlineVar) &&
          css725nc.includes(JPS_PROBLEM_COLORS.warning.outlineVar))
    }

    /**
     * adj767（清单 B 的收口闸门）：
     * ① **结构闸门**：每个源文件的"文件名出现在头部注释里"至多一次 —— 本轮我两次用临时脚本改大文件时
     *    把整段"文件头 + import"复制成了两份（`scorePane.ts` 一度多出 781 行），类型检查**不会**报错，
     *    事后靠肉眼才发现。这条断言就是那道闸门。
     * ② **去重闸门**：B1–B8 要求"删除各自的重复实现"，这里逐项核对插件侧不再自带实现、而是消费引擎。
     *    断言按"代码"判（先剥块注释：注释里提到函数名是正常的）。
     */
    {
      const srcFiles = readdirSync('src').filter((f) => f.endsWith('.ts'))
      const dupes = srcFiles.filter((f) => {
        const s = String(readFileSync(`src/${f}`, 'utf8'))
        const needle = `* ${f} `
        let n = 0
        let i = -1
        while ((i = s.indexOf(needle, i + 1)) >= 0) n++
        return n > 1
      })
      check('adj767 结构闸门：源文件头块没有被复制成两份（文件名在头注释里至多一次）',
        dupes.length === 0, `可疑文件：${dupes.join(', ')}`)
      // 负对照：把某文件的头块人为复制一份，指标必须变成 2（证明这道闸门真的抓得住）
      {
        const probe = String(readFileSync('src/scorePane.ts', 'utf8'))
        const doubled = probe + '\n' + probe
        let n = 0
        let i = -1
        while ((i = doubled.indexOf('* scorePane.ts ', i + 1)) >= 0) n++
        check('adj767 结构闸门负对照：复制一份头块后指标确实 >1', n > 1, `计数=${n}`)
      }

      const code = (p: string) => String(readFileSync(p, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
      const pane = code('src/scorePane.ts')
      const bank = code('src/soundbank.ts')
      const hl = code('src/jpsHighlight.ts')
      const nf = code('src/newFile.ts')
      const defs = code('src/defs.ts')
      const rnd = code('src/render.ts')
      check('adj767 插件不再自带色块/问题/音源/模板/分层判定的实现（B1/B2/B3/B7/B8）——全部消费引擎',
        !/const PLAYHEAD_COLORS/.test(pane) && !/function trackKeysOf/.test(pane) &&
          !/function playheadPosIn/.test(pane) && !/function blockSpanAt/.test(hl) &&
          !/const HQ_LIBRARIES/.test(bank) && !/function splitParseIssues/.test(rnd) &&
          /export const NEW_JPS_TEMPLATE = DEFAULT_NEW_JPS_TEMPLATE/.test(nf) &&
          /export const sameConfigValue = configValuesEqual/.test(defs) &&
          /isDefaultConfigValue\(getDefault\(def\), value\)/.test(defs))
      check('adj767 插件的时间轴/模型/时钟都来自引擎（B4/B6）',
        /createPlaybackClock\(\{/.test(pane) && /highlightLineModel\(line\.text, line\.number/.test(hl) &&
          /groupBlocksByLine\(jpsBlockMarks\(doc, errors\)\)/.test(hl))

      /**
       * adj770（清单 B 的收口闸门之二）：**vendor/engine 与应用引擎逐字节一致** ——
       * 这条等价关系此前只靠我每次手动比对哈希（`Compare-Object` 一堆 PowerShell），
       * 一旦忘了比，插件就会"用着旧引擎、看起来一切正常"（`E-2026-374` 的同类风险）。
       *
       * 跨仓：本地两个仓库并排时真比；插件 CI 只 checkout 插件仓库 ⇒ **跳过**（打印提示），
       * 与会话既有的"示例谱不动点"跨仓断言同一套路。
       */
      {
        const appEngine = '../ijipu/packages/ijipu-engine/src/engine'
        const walk = (dir: string): string[] =>
          readdirSync(dir).flatMap((n) => {
            const p = `${dir}/${n}`
            return statSync(p).isDirectory() ? walk(p) : [p]
          })
        const rel = (dir: string, files: string[]) =>
          files.map((p) => p.slice(dir.length + 1).replace(/\\/g, '/')).sort()
        if (!existsSync(appEngine)) {
          console.log('[adj770] 未找到应用引擎目录（CI 场景）⇒ 跳过 vendor 一致性比对')
          check('adj770 vendor/engine 与应用引擎逐字节一致（跨仓；此环境跳过）', true, 'skipped')
        } else {
          const vendorDir = 'vendor/engine'
          const vFiles = rel(vendorDir, walk(vendorDir).filter((p) => p.endsWith('.ts')))
          const aFiles = rel(appEngine, walk(appEngine).filter((p) => p.endsWith('.ts')))
          const onlyVendor = vFiles.filter((f) => !aFiles.includes(f))
          const onlyApp = aFiles.filter((f) => !vFiles.includes(f))
          const diff = vFiles.filter(
            (f) =>
              aFiles.includes(f) &&
              createHash('sha256').update(readFileSync(`${vendorDir}/${f}`)).digest('hex') !==
                createHash('sha256').update(readFileSync(`${appEngine}/${f}`)).digest('hex'),
          )
          check('adj770 vendor/engine 与应用引擎逐字节一致（文件集 + 逐文件哈希）',
            vFiles.length > 20 && onlyVendor.length === 0 && onlyApp.length === 0 && diff.length === 0,
            `vendor=${vFiles.length} 应用=${aFiles.length} 仅插件有=${onlyVendor.join(',')} 仅应用有=${onlyApp.join(',')} 内容不同=${diff.join(',')}`)
          // 负对照：故意拿两个不同文件的哈希去比，必须判"不同"（证明比对真的在比内容）
          const fakeDiff =
            createHash('sha256').update(readFileSync(`${vendorDir}/index.ts`)).digest('hex') !==
            createHash('sha256').update(readFileSync(`${vendorDir}/playback/clock.ts`)).digest('hex')
          check('adj770 vendor 一致性闸门负对照：不同文件确实判为不同', fakeDiff)
        }
      }
    }

    // ② 分词器行为：类别命中 + **覆盖整行**（CM6 的偏移靠它，漏一个字符就会错位）
    const line = 'Q: 1 2 3 | 4 - 5 C: 词 {tp 1 | 2} &hx <'
    const toks = tokenizeJpsLine(line)
    check('adj752 分词覆盖整行（拼接结果 === 原行 ⇒ decoration 偏移不会错位）',
      toks.map((t) => t.text).join('') === line, toks.map((t) => `${t.cls}:${t.text}`).join('|').slice(0, 120))
    const clsOf = (s: string): string[] => tokenizeJpsLine(s).map((t) => t.cls)
    check('adj752 行头 / 音符 / 小节线 / 歌词 / 装饰 / 注释 / 分页 都能认出（与应用同口径）',
      clsOf('Q: 1 2 3 |')[0] === 'line-header' &&
        clsOf('Q: 1 2 3 |').includes('note') &&
        clsOf('Q: 1 2 3 |').includes('barline') &&
        clsOf('C: 词 {tp 1 | 2}').includes('lyric') &&
        clsOf('Q: 1&hx 2').includes('decoration') &&
        clsOf('# 注释')[0] === 'comment' &&
        clsOf('[fenye]')[0] === 'pagebreak')
  }

  /**
   * adj753（用户第四轮「工具条还是没有显示」，而诊断显示 `命中自身 ✓ / opacity=1 / 视口内=是`）：
   * 真因是**交互**：工具条浮在块**外侧上方**，而显示由"指针在谱面容器内移动"触发 ⇒
   * 用户把指针往上移去点它时就离开了容器 ⇒ 120ms 后自动收起 ⇒ 观感"根本没出现 / 抓不住"。
   * 修法三件：收起前看 `toolbar.matches(':hover')`、收起**延迟 240ms 并复查**、
   * 工具条自身 `pointerenter` 保持显示（`pointerleave` 再走同一套判定）。
   */
  check('adj753/761/769 工具条"抓不住/闪动/不显示"的三条修法：悬停不收、离开延迟复查、先显示再落位（活元素）',
    /if \(hoveringToolbar\(\)\) return/.test(pane725) &&
      /hideTimer = window\.setTimeout\(\(\) => \{/.test(pane725) &&
      /\}, 240\)/.test(pane725) &&
      // adj769：显示必须**先**发生（落位判定不得挡住可见性），且用活元素 + try/catch
      /const revealToolbar = \(on: boolean\): void => \{[\s\S]{0,300}?const el = liveToolbar\(\)[\s\S]{0,120}?el\.toggleClass\('is-revealed', on\)/.test(pane725) &&
      /const liveToolbar = \(\): HTMLElement => container\.querySelector<HTMLElement>\('\.ijipu-score-toolbar'\) \?\? toolbar/.test(pane725) &&
      /落位判定异常（已跳过，工具条照常显示）/.test(pane725) &&
      /if \(liveToolbar\(\)\.hasClass\('is-revealed'\)\) return/.test(pane725))

  /**
   * adj754（用户两点）：
   * ① 「`#====xx====` 还是显示为 Markdown 的高亮黄色背景」——`==xx==` 是宿主的**高亮语法**，
   *    给 `.cm-highlight` 挂了 `background: var(--text-highlight-bg)`；`adj744b` 只中和了
   *    颜色/字重/字形/下划线，**漏了背景** ⇒ 现在补上（且选择器更具体、不用 `!important`）。
   * ② 「如果源码有 jps 语法错误，源码是否有错误显示机制？」—— 现在有了：接引擎 `parseJps().errors`
   *    做**行级**误差底色（错误淡红 / 告警淡橙）＋ **悬停提示**（message + 正确写法），
   *    文案与应用的错误提示同源；整篇解析故**防抖 250ms**，并包裹 try/catch（标注绝不弄坏编辑器）。
   */
  {
    const hl754 = String(readFileSync('src/jpsHighlight.ts', 'utf8'))
    check('adj754 中和宿主的 `==高亮==` 背景（不中和会变成 Markdown 黄底）',
      /\.workspace-leaf\.ijipu-plain-source \.cm-content \.cm-line \.cm-highlight/.test(css725nc) &&
        /\.cm-content \.cm-line mark,/.test(css725nc) &&
        /background-color: transparent/.test(css725nc))
    check('adj754/762/adj774 源码有错误/告警显示：行级底色（模型给级别）+ 悬停提示（接引擎 parseJps）；范围由 `scopeOf` 决定（`.jps` 页签整篇 / ```jps 块只标正文）',
      /import \{[^}]*parseJps[^}]*\} from '@ijipu\/engine'/.test(hl754) &&
        /Decoration\.line\(\{ class: 'ijipu-jps-error-line' \}\)/.test(hl754) &&
        /Decoration\.line\(\{ class: 'ijipu-jps-warn-line' \}\)/.test(hl754) &&
        // 行级级别来自引擎模型（不再由插件自己判 severity）
        /if \(model\.level === 'error'\)/.test(hl754) &&
        /else if \(model\.level === 'warning'\)/.test(hl754) &&
        /hoverTooltip\(/.test(hl754) &&
        // adj774：与"错误提示"同一份文案（重构后提示由 `addHint` 统一拼装，字面量也随之变化）
        /正确写法：\$\{h\}/.test(hl754) &&
        /\}, 250\)/.test(hl754) &&
        /catch \{/.test(hl754) &&
        // adj774：范围判定从"只认 .jps 页签"升级为 scopeOf（整篇 / 围栏块正文）
        /scopeOf\(view\)/.test(hl754) &&
        css725nc.includes('.ijipu-jps-error-line') &&
        css725nc.includes('rgba(255, 93, 108, 0.13)') &&
        css725nc.includes('.ijipu-jps-problem-hint'))
  }

  /**
   * adj755（用户要求：「PC 端预览区，**阅读视图**下工具条在预览区外部左上角，**编辑模式**下在内部左上角，
   * 这个要规范为**都在外部左上角**」）：
   * 原因是 `adj751` 的"贴回块内"兜底**粘住不摘** ⇒ 某面板历史失败过一次就永远在里面。
   * 现在：**每次显示都重新判定** —— 命中自身就**移除**贴内类（回到规范的"外部左上角"）；
   * 未命中则先**放宽上游 `contain`** 再复测，仍不行才临时贴回块内。
   */
  check('adj761 工具条落位：**只判定一次**（外侧优先 → 放宽上游复测 → 不行才固定内侧）',
    /if \(hitSelf && wasInside\) \{/.test(pane725) &&
      /toolbarEl\.removeClass\('ijipu-toolbar-inside'\)/.test(pane725) &&
      /const relaxed = relaxUpstreamClipping\(\)/.test(pane725) &&
      /const relaxUpstreamClipping = \(\): string\[\] => \{/.test(pane725) &&
      /const isLeafContent = el\.hasClass\('workspace-leaf-content'\)/.test(pane725) &&
      /放宽上游裁剪\*\*后命中自身/.test(pane725) &&
      /临时贴回块内/.test(pane725))

  /**
   * adj756（用户要求）：「手机端源码，对于**错误的音符块**能否重点突出，如加**红外框**呀、红色背景什么的」。
   *
   * 应用编辑器早就有这个能力（`hl-err-block` / `hl-warn-block`：把错误的 `col` 归到**空格分隔的那个音符块**，
   * 加单线外框）；插件侧此前只做了"整行淡红底" ⇒ 现在补上**块级**外框，口径与应用一致：
   *  · `col` 与引擎同口径（相对行头之后的内容），换算成绝对偏移；
   *  · 块 = 空格/制表符分隔的一段（与应用 `highlightCodeWrapped` 的定位方式一致）；
   *  · ⚠ 外框会与音符着色**重叠** ⇒ 用 `Decoration.set(ranges, true)`（`RangeSetBuilder` 不允许重叠）。
   */
  {
    const hl756 = String(readFileSync('src/jpsHighlight.ts', 'utf8'))
    /** 只看 **import 语句**（注释里会写到 `RangeSetBuilder` 这个反面教材，不能拿全文判） */
    const importHasBuilder = hl756
      .split('\n')
      .some((l) => l.trimStart().startsWith('import ') && l.includes('RangeSetBuilder'))
    check('adj756/757/762 错误/告警按**音符块**加外框，且"col → 块"换算与"逐行模型"**都在引擎里**（插件只消费）',
      /Decoration\.mark\(\{ class: 'ijipu-jps-err-block' \}\)/.test(hl756) &&
        /Decoration\.mark\(\{ class: 'ijipu-jps-warn-block' \}\)/.test(hl756) &&
        // 插件侧：块区间来自引擎（模型），不再自己实现
        /import \{[^}]*groupBlocksByLine[^}]*\} from '@ijipu\/engine'/.test(hl756) &&
        /for \(const b of model\.blocks\)/.test(hl756) &&
        /groupBlocksByLine\(jpsBlockMarks\(doc, errors\)\)/.test(hl756) &&
        !/function blockSpanAt/.test(hl756) &&
        // 重叠安全：外框与音符着色会重叠，必须用 `Decoration.set(ranges, true)`
        /return Decoration\.set\(ranges, true\)/.test(hl756) &&
        !importHasBuilder &&
        css725nc.includes('.ijipu-jps-err-block') &&
        css725nc.includes('outline: 1px solid var(--text-error') &&
        css725nc.includes('.ijipu-jps-warn-block'),
      `builder=${importHasBuilder} css=${css725nc.includes('.ijipu-jps-err-block')}`)
  }

  check('adj740 工具条诊断行记录"宿主/显示类/最终样式/坐标/祖先链"（设置页可读）',
    /lastToolbarInfo/.test(String(readFileSync('src/main.ts', 'utf8'))) &&
      /plugin\.lastToolbarInfo =/.test(pane725) &&
      /宿主=\$\{container\.closest\(CM_EMBED_BLOCK\)/.test(pane725) &&
      /显示类=\$\{toolbarEl\.hasClass\('is-revealed'\)/.test(pane725) &&
      /opacity=\$\{cs\.opacity\} visibility=\$\{cs\.visibility\} position=\$\{cs\.position\}/.test(pane725) &&
      /｜祖先链：/.test(pane725) &&
      settings730.includes('预览工具条（诊断信息，无需操作）') &&
      settings730.includes('lastToolbarInfo'))
  // ③c **不再往预览里塞 textarea**（用户明确要求）
  check('adj725 不再往预览里塞 textarea（用户口径：不要再单独的 textarea）',
    !pane725.includes('ijipu-block-source-editor') &&
      !/createEl\('textarea'/.test(pane725) &&
      !css725nc.includes('.ijipu-block-source-editor') &&
      !css725nc.includes('.ijipu-source-stack'))

  /**
   * ④ 点 `</>` 之后的动作：**切回笔记源码**（不是就地编辑）——
   *   · 阅读视图 → 实时预览（`mode:'source', source:false`）；
   *   · 光标落到块内首行（`lineStart + 1`）并滚进视野、聚焦；
   *   ⇒ 实时预览**原生**就会把该块显示成源码（语法高亮、撤销栈、与别的代码块一致）。
   */
  check('adj725 点 `</>` 切回笔记源码（阅读视图先切实时预览 + 光标落到块内首行）',
    main725.includes('onEditSource: () => void this.revealSource()') &&
      main725.includes("getMode() === 'preview'") &&
      main725.includes("setState({ mode: 'source', source: false }, { history: false })") &&
      main725.includes('ed.setCursor({ line, ch: 0 })') &&
      main725.includes('ed.scrollIntoView(') &&
      main725.includes('ed.focus()'))
  // ④b 找不到承载这份笔记的页签时要**说清楚**，不能静默什么都不发生
  check('adj725 找不到笔记页签/定位不到代码块时给出可见提示（不静默）',
    /if \(!info\)[\s\S]{0,200}?new Notice\(/.test(main725) &&
      /if \(!view\)[\s\S]{0,200}?new Notice\(/.test(main725))

  /**
   * ⑤ adj725b：**量不到内容包围盒时必须补量** —— 这才是"谱面模式还留一大片空白"的**真正根因**。
   *
   * 用户 2026-10 二次截图复现（谱面模式的纸张仍是整页形状、墨迹缩在顶部）。查证：
   * Obsidian 的代码块/widget **先把 DOM 建好、再挂进文档**（实时预览 `initDOM` 建的是游离节点），
   * 于是我们挂载那一刻元素**不在渲染树里** ⇒ `getBBox()` 全 0 ⇒ 量不到内容盒 ⇒ 退回"按边距裁"。
   * 本仓库的浏览器验证页此前把面板挂在**已连接**的容器里，所以一直没复现（现在加了那一支）。
   *
   * 两条补量路径都要在：`ResizeObserver`（尺寸 0→真实那一刻，准）+ 定时重试（没有 RO 时的兜底）；
   * 且**只在"没量到"时挂** —— "量到的盒几乎等于整页"是真量到了，重试没有意义。
   */
  check('adj725b 量不到内容盒时补量（游离时不量 + ResizeObserver + 定时重试）',
    /const box = svgEl\.isConnected \? measureContentBox\(svgEl\) : null/.test(pane725) &&
      /if \(!box\) \{[\s\S]{0,240}?observeUntilMeasured\(svgEl, c\)[\s\S]{0,80}?scheduleCropRetry\(svgEl, c\)/.test(pane725) &&
      /new ResizeObserver\(/.test(pane725) &&
      /const delays = \[0, 60, 300\]/.test(pane725) &&
      /if \(!svgEl\.isConnected\) return/.test(pane725))
  check('adj725b 补量用的观察器在重画与 destroy 时都断开（不留悬空监听）',
    /for \(const ro of cropObservers\) ro\.disconnect\(\)/.test(pane725) &&
      /cropObservers\.clear\(\)/.test(pane725))

  /**
   * ⑥ adj725c（用户报「鼠标移上去也看不见 `</>`」）：**底色与字色不得跟主题走**。
   *
   * 这个按钮压在**恒为白色**的谱面纸张上，而深色主题的 `--text-normal` / `--embed-action-color`
   * 是浅灰（#dadada）⇒ 白纸上的对比度 ≈1.1:1，等于看不见。
   * 现固定为「半透明深底 + 白字」（≈4.8:1，悬停更深）。真实对比度由
   * `verify-score-crop.mjs` 在浏览器里按"底色合成到白纸"实算并断言 ≥3:1。
   */
  /**
   * adj725c → **adj773 反向判据**：`</>`（块右上角那枚"编辑源码"）连同它的"半透明深底 + 白字"配色
   * 已随功能删除（用户要求统一成工具条最右那枚「编辑」）。
   *
   * 原断言守的是"这枚按钮压在**恒为白**的谱面纸张上不能跟主题取色，否则看不见"这个真实教训 ——
   * 现在的载体换成了工具条：它自带 `--background-secondary` 底色，所以这里保留两条：
   * ① 旧按钮的样式必须**不存在**（防止有人把它捡回来）；② 工具条自身仍需有底色。
   */
  check('adj773 `</>` 的样式已随功能删除；工具条自身仍有底色（谱面纸张恒白）',
    !/ijipu-edit-source-btn/.test(css725nc) &&
      /\.ijipu-score-toolbar\s*\{[^}]*background:\s*var\(--background-secondary/.test(css725nc))

  /**
   * ⑦ adj725d（用户报「小节序号数字偏上，未在方框正中」）：**不能再让宿主的 sanitizeHTMLToDom 处理 SVG**。
   *
   * 查实过程（写进注释，免得后人"顺手改回去"）：Obsidian 的 `sanitizeHTMLToDom` = DOMPurify
   * （`app.js`: `function cC(e){return document.importNode(aC.sanitize(e,lC),!0)}`），
   * 它的 **SVG 属性白名单不含 `dominant-baseline`**（白名单里有 `alignment-baseline` / `baseline-shift` /
   * `text-anchor` / `writing-mode`…；全文只有 HTML→SVG 的**属性名映射表**里出现过它）
   * ⇒ 属性被剥掉 ⇒ 小节序号/增时线/段层括号这些"字符中心对齐"的文本一律退回字母基线（数字整体偏上）。
   * 应用侧不经 DOMPurify，所以**只有插件**有这个问题。
   *
   * 真实几何由 `verify-score-crop.mjs` 在 Chrome 里量（验证页的 sanitizeHTMLToDom 替身
   * **故意仿照 DOMPurify 剥掉该属性**，所以"改回去"会立刻红灯）。
   */
  check('adj725d 不再把 SVG 交给 sanitizeHTMLToDom（DOMPurify 会剥 dominant-baseline）',
    /function svgToDom\(svg: string, plugin: IJipuPlugin\): DocumentFragment/.test(pane725) &&
      /new DOMParser\(\)\.parseFromString\(svg, 'image\/svg\+xml'\)/.test(pane725) &&
      !/wrap\.appendChild\(sanitizeHTMLToDom/.test(pane725) &&
      /lastSvgParse/.test(pane725))

  /**
   * ⑧ adj725e（用户第二轮截图：「深色主题下 `</>` 一片白、看不见」）：**用户实际看到的是宿主那枚**。
   *
   * 实时预览里 Obsidian 会给代码块挂它自己的「编辑此块」（`.embed-actions > .edit-block-button`），
   * 插件检测到就把自己那枚撤掉（不重复挂）⇒ 屏幕上那枚是**宿主的**，而它只跟主题取色：
   * `.markdown-source-view.mod-cm6 .embed-action { color: var(--embed-action-color) }` ——
   * 深色主题下是浅灰，压在恒为白的谱面纸张上对比度 ≈1.4:1（用户截图正是"看不见"）。
   *
   * 修法：给**本插件的块里**那枚宿主按钮补上与本插件那枚相同的"半透明深底 + 白字"
   * （选择器带 `.ijipu-cm-host`，只影响我们的块）。真实对比度与负对照由
   * `verify-score-crop.mjs` 在真实 Chrome 里实算（保留类 4.76:1 / 摘掉类 1.4:1）。
   */
  check('adj725e 宿主那枚 `</>` 在本插件的块里也补上"深底 + 白字"（只影响 .ijipu-cm-host 的块）',
    /\.cm-embed-block\.ijipu-cm-host\s+\.embed-actions\s+\.edit-block-button[\s\S]{0,200}?\{[^}]*background:\s*rgb\(0 0 0 \/ \d+%\)/.test(css725nc) &&
      /\.cm-embed-block\.ijipu-cm-host\s+\.embed-actions\s+\.embed-action[\s\S]{0,300}?color:\s*#ffffff/.test(css725nc) &&
      /\.cm-embed-block\.ijipu-cm-host\s+\.embed-actions\s+\.edit-block-button:hover/.test(css725nc))

  /**
   * ⑨ adj726（用户要求）：「插件预览区的工具栏当有了编辑按钮后，就不再需要"打开谱面文件"的链接」。
   *
   * 两者都是"离开预览去处理这份谱"的入口，而「编辑」直接进完整编辑器、是更强的那个；
   * 链接那枚（打开 `.jps` 文件视图）就成了重复入口，还占着工具栏右端（窄容器里更挤）。
   * 三条一起断言：① 有「编辑」时不建链接；② 没有「编辑」时链接**照旧**（别顺手把链接彻底删掉）；
   * ③ 两处共用同一个判据 `hasEditEntry`（避免以后只改一处）。真实按钮组合由
   * `verify-score-crop.mjs` 在浏览器里按"给/不给 onEdit"两支对照实测。
   */
  check('adj726 有「编辑」按钮时不再出现「打开谱面文件」链接（没有编辑时仍保留）',
    /const hasEditEntry = !!\(host\.onEdit && host\.filePath\)/.test(pane725) &&
      /const keepEmbedLink = !hasEditEntry \|\| host\.editLeavesObsidian === true/.test(pane725) &&
      /if \(host\.embedded && host\.embedTitle && keepEmbedLink\)/.test(pane725))

  /**
   * ⑩ adj727（用户要求）：「**仅当打开方式 = 默认应用时保留链接**」。
   *
   * 判据抽成**纯函数** `embedEditLeavesObsidian`（`src/embed/openPlan.ts`）：
   *  · 右栏 / 新页签 / 当前页签 ⇒ 仍在 Obsidian 内 ⇒ 有「编辑」时链接是重复入口，收掉；
   *  · **默认应用** ⇒ 文件交给系统里的 iJipu 桌面版、**离开 Obsidian** ⇒
   *    那枚链接是"在站内打开 `.jps` 视图"的唯一入口，必须保留。
   * `main.ts` 的 `openIjipuFile` 与 `embed.ts` 给工具栏的标志**共用这一个判据**
   * （不在两处各写一遍 `mode === 'defaultApp'`，改一处漏一处）。
   */
  check('adj727 embedEditLeavesObsidian 只在「默认应用」时返回 true（四种方式全覆盖）',
    embedEditLeavesObsidian('defaultApp') === true &&
      embedEditLeavesObsidian('right') === false &&
      embedEditLeavesObsidian('tab') === false &&
      embedEditLeavesObsidian('current') === false)
  check('adj727 判据只写一处：main.ts 与 embed.ts 都改用纯函数',
    /if \(embedEditLeavesObsidian\(mode\)\)/.test(main725) &&
      /import \{ embedEditLeavesObsidian, planEmbedTarget \} from '\.\/embed\/openPlan'/.test(main725) &&
      /editLeavesObsidian: embedEditLeavesObsidian\(this\.plugin\.settings\.embedOpenMode \?\? DEFAULT_EMBED_OPEN_MODE\)/.test(embed725) &&
      /import \{ embedEditLeavesObsidian \} from '\.\/embed\/openPlan'/.test(embed725))

  /**
   * ⑪ adj730（用户报「插件里『支持』里的微信赞赏码不见了」）：**赞赏入口必须在，且码要看得见**。
   *
   * 查证：这条入口在 `6934155` 加过（设置页一个 `支持作者 ❤` 外链），
   * `ebb0e5c`（adj724b"设置整并"）把它删了 —— 本轮补回。
   *
   * 用户随后要求：「good.png 已经缩到 320 宽，请放宽 gitignore 的限制，并加入内联」
   * ⇒ 图片入库（`vendor/icons/good.png`，与应用同图、逐字节相同）并**内联显示**。
   *
   * adj734（用户要求）：文案收成一句、并**去掉「在浏览器打开」按钮**（码就在正下方，
   * 再给外链是多余入口，也把说明拖长）⇒ 连带去掉 `DONATE_URL` 常量。
   *
   * ⚠ 这条断言里最关键的是**最后一条**：`.gitignore` **不得**再忽略 `good.png`。
   *   被忽略的文件进不了仓库，而 CI 从干净检出构建 main.js ⇒ 解析不到该 import ⇒ **发版直接失败**。
   *   （这正是我第一次做内联时踩的坑：本地构建通过、CI 会挂。判据必须钉在仓库状态上。）
   */
  check('adj730/734 说明页「支持作者 ❤」内联显示赞赏码（一句话说明、无外链按钮）',
    settings730.includes('支持作者 ❤') &&
      settings730.includes('如果这个插件帮到了你，欢迎扫码下方的微信赞赏码支持一下。') &&
      /import donateQrPng from '\.\.\/vendor\/icons\/good\.png'/.test(settings730) &&
      /attr: \{ src: donateQrPng/.test(settings730) &&
      !/src:\s*'https?:\/\//.test(settings730) &&
      // adj734：按钮与那个常量都该从**代码**里消失
      // （负对照一律去掉注释再判：注释里会写到"在浏览器打开""DONATE_URL"这些词，
      //   直接对全文判会自己把自己判红——我第一版就栽在这）
      !settings730.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').includes('在浏览器打开') &&
      !settings730.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').includes('DONATE_URL') &&
      css725nc.includes('.ijipu-donate-qr') &&
      // 图片真的在仓库里（内联的前提）：320×320 的 PNG
      existsSync('vendor/icons/good.png') &&
      readFileSync('vendor/icons/good.png').byteLength > 10_000)
  {
    const png = readFileSync('vendor/icons/good.png')
    const isPng = png[0] === 0x89 && png.subarray(1, 4).toString('latin1') === 'PNG'
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    check('adj730 赞赏码是 320×320 的 PNG（用户已缩过；再放大就别内联了）',
      isPng && width === 320 && height === 320, `${width}×${height}`)
  }
  check('adj730 ⚠ .gitignore 不得再忽略 good.png（被忽略 ⇒ CI 从干净检出构建直接失败）',
    !readFileSync('.gitignore', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .includes('good.png'))

  /**
   * ⑫ adj739（用户要求）：「设置-说明 的前面标题和构建，应该显示如图2 和版本信息如
   * `v0.31.1 (2026-10-09 @6ac8b3eb)` 的内容才对呀」——照抄应用「关于」页的品牌头 +
   * 应用的 `APP_VERSION_FULL` 格式（`v{版本} ({日期} @{提交})`）。
   *
   * 三件事必须成对：① 图标是**与应用同一枚** `Jianpu.png`（内联、不联网）；
   * ② 版本串格式与 `BUILD_DATE` 的引入；③ 再并排显示**嵌入版应用的版本**
   * （`WEBAPP_META.appVersion` —— 正是 0.31.1 那次"插件版本 / 嵌入版版本"看错的地方）。
   *
   * ⚠ 与 good.png 同一个坑：`.gitignore` **不得**再忽略 `Jianpu.png`（被忽略 ⇒ CI 构建失败）。
   */
  check('adj739 设置页头部 = 品牌头（应用同款图标 + 名称 + 标语）+ 应用格式的版本串',
    settings730.includes('ijipu-settings-brand') &&
      settings730.includes('爱记谱（iJipu）') &&
      settings730.includes('码即成，谱自现') &&
      /import jianpuLogoPng from '\.\.\/vendor\/icons\/Jianpu\.png'/.test(settings730) &&
      /attr: \{ src: jianpuLogoPng/.test(settings730) &&
      // 与应用 APP_VERSION_FULL 逐字对齐：`v${版本} (${日期} @${提交})`
      /text: `v\$\{this\.plugin\.manifest\.version\} \(\$\{BUILD_DATE\} @\$\{GIT_COMMIT\}\)`/.test(settings730) &&
      /BUILD_DATE/.test(settings730) &&
      // 嵌入版应用的版本并排显示
      /嵌入版 iJipu：v\$\{WEBAPP_META\.appVersion\}/.test(settings730) &&
      // 图标真的在仓库里（内联的前提），且是 PNG
      existsSync('vendor/icons/Jianpu.png') &&
      readFileSync('vendor/icons/Jianpu.png').subarray(1, 4).toString('latin1') === 'PNG' &&
      // 生成脚本要真的产出 BUILD_DATE（否则上面的版本串类型就编译不过）
      /export const BUILD_DATE = '/.test(readFileSync('scripts/gen-build-info.mjs', 'utf8')) &&
      // CSS 有对应样式（否则品牌头会挤成一行裸文字）
      css725nc.includes('.ijipu-settings-brand') &&
      css725nc.includes('.ijipu-settings-logo') &&
      css725nc.includes('.ijipu-settings-brand-tagline'),
    `brand=${settings730.includes('ijipu-settings-brand')} logo=${existsSync('vendor/icons/Jianpu.png')}`)
  check('adj739 ⚠ .gitignore 不得再忽略 Jianpu.png（与应用图标同坑：被忽略 ⇒ CI 构建失败）',
    !readFileSync('.gitignore', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .includes('Jianpu.png'))
  // 图标与应用**逐字节相同**（能拿到应用仓库时核对；插件 CI 只有本仓库 ⇒ 跳过）
  if (existsSync('../ijipu/public/icons/Jianpu.png')) {
    check('adj739 品牌图标与应用 `public/icons/Jianpu.png` 逐字节相同',
      readFileSync('../ijipu/public/icons/Jianpu.png').equals(readFileSync('vendor/icons/Jianpu.png')))
  }
}

/**
 * ---- adj727b：嵌入版本地服务必须能交出 **SpessaSynth worklet** ----
 *
 * 用户报：「插件方式导入音色库……试听对话框里无法加载」。查证的链路：
 * 嵌入版应用按 `./spessasynth/spessasynth_processor.min.js` 取 worklet
 * （`vite.config.embed.mjs` 的 `base: './'`），而该文件**不在**嵌入版资产白名单里
 * （`ijipu/scripts/embed-assets.mjs` 只带图标与示例谱）⇒ 服务对未知路径回 **204**
 * ⇒ `audioWorklet.addModule` 拿到空模块必然失败 ⇒ 试听"音源加载失败，本次试听无声"。
 * （导入只写 IndexedDB ⇒ **导入看着是成功的**，这正对上用户那句"能看到导入、但试听加载不了"。）
 *
 * 这一节**真起服务、真取一次**（不是读源码判断）：起服务 → 取 worklet → 取图标作对照 →
 * 再起一个"没传 worklet"的服务确认它是**响亮地 500**、而不是又静默 204。
 */
console.log('\n[adj727b] 嵌入版本地服务：SpessaSynth worklet 必须能取到')
{
  const sv = (p: string): string => readFileSync(p, 'utf8')
  const serverSrc = sv('src/embed/server.ts')
  const mainSrc = sv('src/main.ts')
  check('adj727b 服务声明 worklet 路径常量，且 main.ts 把**已内联**的那份传给它（不额外增体积）',
    serverSrc.includes("export const EMBED_WORKLET_PATH = 'spessasynth/spessasynth_processor.min.js'") &&
      serverSrc.includes('if (rest === EMBED_WORKLET_PATH)') &&
      // adj729 之后这里还多传了 readSoundfont ⇒ 用宽松窗口匹配"确实传了 workletCode"
      /startEmbedServer\(\{[\s\S]{0,160}?workletCode[\s\S]{0,160}?\}/.test(mainSrc) &&
      /import workletCode from '\.\.\/spessasynth_processor\.min\.js'/.test(mainSrc))

  // —— 行为验证：真起服务 ——
  const { startEmbedServer } = await import('../src/embed/server')
  const workletCode = sv('spessasynth_processor.min.js')
  const server = await startEmbedServer({ workletCode })
  try {
    const wl = await fetch(`${server.url}${'spessasynth/spessasynth_processor.min.js'}`)
    const body = await wl.text()
    check('adj727b 真机取 worklet：200 + JS 类型 + 与插件内联的那份一致',
      wl.status === 200 &&
        /javascript/i.test(wl.headers.get('content-type') ?? '') &&
        body.length > 1000 &&
        body === workletCode,
      `status=${wl.status} type=${wl.headers.get('content-type')} bytes=${body.length}`)
    // 对照：白名单资产（图标）照旧 200，别把资产表弄坏
    const icon = await fetch(`${server.url}icons/${encodeURIComponent('菜单')}.png`)
    check('adj727b 白名单图标仍 200（没有把资产表改坏）', icon.status === 200, `status=${icon.status}`)
    /**
     * adj731（用户报「插件里『支持』里的微信赞赏码不见了」+ 破图截图）：**嵌入版必须能取到赞赏码**。
     *
     * 根因在应用侧（`DonateDialog` 用根绝对路径 `/icons/good.png`，少了 token 段 ⇒ 这里 404），
     * 已在应用侧修（改走 `BASE_URL`）。插件这一侧要钉的是**另一半**：
     *  `icons/good.png` 确实在嵌入版资产白名单里、且真能按路径取到（PNG 魔数校验）。
     */
    const donate = await fetch(`${server.url}icons/good.png`)
    const donateBuf = Buffer.from(await donate.arrayBuffer())
    check('adj731 嵌入版能按路径取到赞赏码 icons/good.png（200 + PNG 魔数）',
      donate.status === 200 &&
        donateBuf.length > 1000 &&
        donateBuf[0] === 0x89 &&
        donateBuf.subarray(1, 4).toString('latin1') === 'PNG',
      `status=${donate.status} bytes=${donateBuf.length}`)

    /**
     * ---- adj733：**嵌入版产物必须与应用同版**（生成顺序的机器闸门）----
     *
     * 用户实测报的坑：「插件是 0.31.0，但嵌入版 iJipu 还是 0.49.0，而应用已经是 0.50.0」
     * —— 更严重的后果不是版本号显示，而是**嵌入版里的引擎是旧的**：
     * 本轮"色块右界按墨迹夹紧"（引擎 `adj732`）是在**生成嵌入产物之后**才做的 ⇒
     * 插件自己的 ` ```jps ` 预览（走 `vendor/engine`）已修，而**嵌入版（走旧 bundle）没修**，
     * 于是用户看到"应用正常、插件还有覆盖"。
     *
     * 正确的顺序（写进 `ijipu/AGENTS.md` 与「版本发布」技能）：
     *   **应用版本号/引擎定稿 → `npm run build:embed && node scripts/embed-emit.mjs` → 再构建/发布插件**。
     * 这条断言就是那个顺序的闸门：嵌入产物里记的 `WEBAPP_META.appVersion`
     * （由 `embed-emit.mjs` 写自应用 `package.json`）必须等于应用当前的 `APP_VERSION`。
     * ⚠ 插件 CI 只 checkout 本仓库、拿不到应用仓库 ⇒ 跨仓核对**在本地跑**（发布前必跑 `npm run smoke`）；
     *    CI 里退化为"记录来源版本"的弱断言。
     */
    const embedMetaVersion = /appVersion:\s*"([^"]+)"/.exec(readFileSync('src/gen/webappAssets.ts', 'utf8'))?.[1]
    const appVersionFile = '../ijipu/src/brand/version.ts'
    if (existsSync(appVersionFile)) {
      const appVersion = /APP_VERSION = '([^']+)'/.exec(readFileSync(appVersionFile, 'utf8'))?.[1]
      check('adj733 嵌入版产物版本 == 应用 APP_VERSION（顺序：先升版本 → 再 build:embed + emit）',
        embedMetaVersion !== undefined && embedMetaVersion === appVersion,
        `嵌入版=${String(embedMetaVersion)} 应用=${String(appVersion)}（不等 ⇒ 回应用仓库重跑 npm run build:embed && node scripts/embed-emit.mjs）`)
    } else {
      check('adj733 嵌入版产物记录了来源版本（CI 无应用仓库，跨仓核对在本地跑）',
        typeof embedMetaVersion === 'string' && /^\d+\.\d+\.\d+/.test(embedMetaVersion),
        `嵌入版=${String(embedMetaVersion)}`)
    }
  } finally {
    await server.dispose()
  }
  const bare = await startEmbedServer()
  try {
    /**
     * adj773：**环境跳过**（沿用本仓库"跨仓拿不到就跳过"的既有先例，不是放宽行为断言）。
     *
     * 由来：受限环境里"再开第二个本地服务"会连不上（`fetch failed`，实测同一台机器上
     * 先起的那个服务一切正常、单独探针也正常——是环境限制，不是被测代码的问题）。
     * 判据只影响"能不能跑到这条断言"，一旦请求通得过就照旧按 500 判。
     */
    let miss: Response | null = null
    try {
      miss = await fetch(`${bare.url}spessasynth/spessasynth_processor.min.js`)
    } catch (e) {
      console.log(`[smoke] 本地服务不可用（${e instanceof Error ? e.message : String(e)}）⇒ 跳过 adj727b 的 500 断言`)
    }
    if (miss === null) {
      check('adj727b 未传 worklet 时**响亮地** 500（不静默 204，否则又回到用户那个现象）', true, 'skipped：环境不允许再开本地服务')
    } else {
      check('adj727b 未传 worklet 时**响亮地** 500（不静默 204，否则又回到用户那个现象）',
        miss.status === 500, `status=${miss.status}`)
    }
  } finally {
    await bare.dispose()
  }
}

/**
 * ---- adj729：音色库**落到插件目录**（随文库一起走）+ 嵌入版按 URL 取用 + 由插件导入 ----
 *
 * 用户口径：「音色库下载或导入后，建议放在插件目录中，以便能随文库一起走」。
 * 此前音源只存在 IndexedDB（插件预览一个 origin、嵌入版应用另一个 origin），
 * 换机器/换库/清站点数据就没了，也**不随文库同步**。
 *
 * 这一节覆盖四件事（真实取字节那条起真服务）：
 *  ① 落点：`<配置目录>/plugins/<插件 id>/soundfonts/<库 id>.sf2`（走 `vault.adapter`，不是 `vault.*`）；
 *  ② 取用顺序：插件目录文件 → IndexedDB → 内置 → 下载；**下载/导入后写回插件目录**；
 *  ③ 嵌入版服务把它按 `soundbanks/<id>.sf2` 交给应用（`welcome.bankUrls`）；
 *  ④ 嵌入版「导入音色文件」由**插件**弹选择器并写盘（32 MB 不跨窗口搬）。
 */
console.log('\n[adj729] 音色库落插件目录（随文库一起走）')
{
  const s9 = (p: string): string => readFileSync(p, 'utf8')
  const bankFileSrc = s9('src/bankFile.ts')
  const soundbankSrc = s9('src/soundbank.ts')
  const serverSrc729 = s9('src/embed/server.ts')
  const bridgeSrc729 = s9('src/embed/bridge.ts')
  const mainSrc729 = s9('src/main.ts')
  const renderSrc729 = s9('src/render.ts')
  const cssSrc729 = s9('styles.css')

  check('adj729/adj772 音色库文件落在插件目录（soundfonts/<id>.sf2，走 vault.adapter；兜底路径按 vault.configDir）',
    bankFileSrc.includes("const SOUNDFONT_DIR = 'soundfonts'") &&
      bankFileSrc.includes('createBankFileStore(app: App, manifestDir: string)') &&
      bankFileSrc.includes('app.vault.adapter.writeBinary(') &&
      bankFileSrc.includes('app.vault.adapter.readBinary(') &&
      !/app\.vault\.(createBinary|readBinary)\b/.test(bankFileSrc) &&
      /this\.bankFiles = createBankFileStore\([\s\S]{0,120}?this\.manifest\.dir/.test(mainSrc729) &&
      // adj772（社区审核）：兜底路径**不得硬编码 `.obsidian`**，按 `vault.configDir` 拼
      /this\.manifest\.dir \?\? `\$\{this\.app\.vault\.configDir\}\/plugins\/\$\{this\.manifest\.id\}`/.test(mainSrc729) &&
      !/'\.obsidian\/plugins\//.test(mainSrc729))
  check('adj729/760/adj772 取用顺序由引擎 `planHqBankLoad` 决定（用户文件 → IndexedDB → 下载）；下载后写回插件目录',
    /const plan = planHqBankLoad\(\{ userFile: !!fromFile && fromFile\.byteLength > 0, cache: !!hit \}\)/.test(soundbankSrc) &&
      /if \(plan === 'userFile' && fromFile\) return fromFile/.test(soundbankSrc) &&
      /export \{ HQ_LIBRARIES, getHqLibrary, hqBankFailureText \} from '@ijipu\/engine'/.test(soundbankSrc) &&
      // adj773：下载这一步是 `fetch`（`requestUrl` 那版会让用例真联网 ⇒ 已回退，见 soundbank.ts 的注释）
      /const bank = await res\.arrayBuffer\(\)[\s\S]{0,200}?cache\.save\(lib\.id, bank\)[\s\S]{0,220}?files\.write\(lib\.id, bank\)/.test(
        soundbankSrc,
      ) &&
      // 存量 IndexedDB 缓存也要**补写**成插件目录文件（迁移：老用户第一次试听就落盘）
      /await cache\.load\(lib\.id\)[\s\S]{0,400}?files\.write\(lib\.id, hit\)/.test(soundbankSrc))
  check('adj729 插件预览把存储层交给 playScore（否则等于没接）',
    /bankFiles: plugin\.getBankFiles\(\)/.test(s9('src/scorePane.ts')) &&
      /bankFiles\?: BankFileStore \| null/.test(renderSrc729) &&
      /loadHqBank\(getHqLibrary\(\), new HqCache\(\), opts\?\.bankFiles \?\? null\)/.test(renderSrc729))
  check('adj729 嵌入版服务按 soundbanks/<id>.sf2 交音源，且 welcome 里给出地址',
    serverSrc729.includes("export const SOUNDFONT_URL_PREFIX = 'soundbanks/'") &&
      /rest\.startsWith\(SOUNDFONT_URL_PREFIX\)/.test(serverSrc729) &&
      /readSoundfont: \(id\) => this\.readSoundfont\(id\)/.test(mainSrc729) &&
      /bankUrls: \(\) => this\.bankUrls\(\)/.test(mainSrc729) &&
      /bankUrls: this\.host\.bankUrls\?\.\(\) \?\? \{\}/.test(bridgeSrc729))
  check('adj729 嵌入版「导入音色文件」由插件弹选择器并写盘（32 MB 不跨窗口搬）',
    /op === 'importSoundbank'/.test(bridgeSrc729) &&
      /importSoundbank: \(id\) => this\.importSoundfont\(id\)/.test(mainSrc729) &&
      bankFileSrc.includes('importFromPicker') &&
      // 隐藏文件框走 CSS 类（社区审核：不得直接写 style.*）
      bankFileSrc.includes("cls: 'ijipu-file-input-hidden'") &&
      !/\.setCssStyles?\(/.test(bankFileSrc) &&
      cssSrc729.includes('.ijipu-file-input-hidden'))

  // —— 行为验证：真起服务，按路径取音源 ——
  const { startEmbedServer, SOUNDFONT_URL_PREFIX: PREFIX } = await import('../src/embed/server')
  const fake = Buffer.from('SF2-FAKE-BYTES-0123456789')
  const server = await startEmbedServer({
    workletCode: '/* w */',
    readSoundfont: async (id) => (id === 'generaluser_gs' ? fake : null),
  })
  try {
    const okRes = await fetch(`${server.url}${PREFIX}generaluser_gs.sf2`)
    const okBody = Buffer.from(await okRes.arrayBuffer())
    check('adj729 真机：插件目录里有音源 ⇒ 200 + 字节一致',
      okRes.status === 200 && okBody.equals(fake),
      `status=${okRes.status} bytes=${okBody.length}`)
    const missRes = await fetch(`${server.url}${PREFIX}nope.sf2`)
    check('adj729 真机：插件目录里没有 ⇒ 404（应用据此退回自己的缓存/下载）',
      missRes.status === 404, `status=${missRes.status}`)
    const badRes = await fetch(`${server.url}${PREFIX}..%2F..%2Fsecret.sf2`)
    check('adj729 真机：非法库 id ⇒ 400（不接受路径穿越）',
      badRes.status === 400, `status=${badRes.status}`)
  } finally {
    await server.dispose()
  }
}

/**
 * ---- adj741：手机端 P0「一版多端」----
 *
 * 用户决定：不做两个插件，改为**一个插件 + 平台能力分级**（`isDesktopOnly: false`）。
 * 关键事实：真正的桌面专属**只有一处** —— `src/embed/server.ts` 的 `node:http` / `node:crypto`
 * （给"嵌入版 iJipu" iframe 用的本地服务）。它原来是**静态导入**的 ⇒ 手机端光加载插件就会解析失败
 * ⇒ 连"手机端最需要的"普通预览都没了。所以改法是"按需加载 + 平台门控"，本节的断言就是这条底线。
 *
 * 另一件用户明确交代的事：**音源默认走插件目录里的文件**（不要默认联网下载）——见最后一条。
 */
console.log('\n[adj741] 手机端 P0：桌面专属能力按需加载 + 平台门控')
{
  const mainSrc741 = String(readFileSync('src/main.ts', 'utf8'))
  const fvSrc741 = String(readFileSync('src/fileView.ts', 'utf8'))
  const bankSrc741 = String(readFileSync('src/soundbank.ts', 'utf8'))
  const manifest741 = JSON.parse(String(readFileSync('manifest.json', 'utf8'))) as { isDesktopOnly?: boolean }

  check('adj741 manifest 允许手机端（`isDesktopOnly: false`）',
    manifest741.isDesktopOnly === false, String(manifest741.isDesktopOnly))

  // ⚠ 这条是本节的核心：`node:http` 所在模块只能"类型导入 + 动态导入"，绝不能静态导入
  check('adj741 `./embed/server` 不得被**静态导入**（否则手机端加载插件即失败）',
    /import type \{[^}]*\} from '\.\/embed\/server'/.test(mainSrc741) &&
      !/^import \{[^}]*\} from '\.\/embed\/server'/m.test(mainSrc741) &&
      /this\.embedServerModule = await import\('\.\/embed\/server'\)/.test(mainSrc741))

  // 动态导入必须受平台门控，且调用点先 await 到模块再启动服务
  check('adj741 按需加载受平台门控（仅桌面端），调用点也先取模块',
    /loadEmbedServer\(\): Promise<typeof import\('\.\/embed\/server'\) \| null> \{[\s\S]{0,140}?if \(!Platform\.isDesktopApp\) return null/.test(mainSrc741) &&
      /const mod = await this\.loadEmbedServer\(\)[\s\S]{0,80}?if \(!mod\) return null/.test(mainSrc741) &&
      /mod\s*\.\s*startEmbedServer\(/.test(mainSrc741))

  check('adj741 手机端不注册嵌入版编辑器视图，打开时给明确提示；`</>` 仅桌面端下发',
    /if \(Platform\.isDesktopApp\) this\.registerView\(VIEW_TYPE_IJIPU_APP/.test(mainSrc741) &&
      /仅桌面端可用；手机端请直接看谱面预览与试听/.test(mainSrc741) &&
      /\.\.\.\(Platform\.isDesktopApp \? \{ onEditSource/.test(mainSrc741))

  /**
   * adj773（用户要求 4）：各端各模式（手机/PC、阅读/编辑）都能**点击预览区显/隐工具条** ——
   * 原来显隐只由 hover 驱动（`pointermove`/`pointerleave`），手机端没有 hover ⇒ 用户报"手机端编辑视图没有工具条"。
   */
  {
    const pane773 = String(readFileSync('src/scorePane.ts', 'utf8'))
    const css773 = String(readFileSync('styles.css', 'utf8'))
    check('adj773 点击预览区显/隐工具条（不依赖 hover；三处预览一致）',
      /const onContainerClick = \(e: MouseEvent\): void => \{/.test(pane773) &&
        /container\.addEventListener\('click', onContainerClick\)/.test(pane773) &&
        // 点到工具条自身不切换；点到有自身动作的元素（音符/小节线/链接/按钮）只显示不收起
        /if \(target\?\.closest\('\.ijipu-score-toolbar'\)\) return/.test(pane773) &&
        /target\?\.closest\('\[data-cipos\], \[data-notepos\], a, button'\)/.test(pane773) &&
        // 触摸端补一次（部分 WebView 不给非可点击元素派发 click）
        /container\.addEventListener\('pointerup'/.test(pane773) &&
        // 用户主动收起要能压过"移动端常显"（不用 !important，靠特异性）
        /el\.removeClass\('is-user-hidden'\)/.test(pane773) &&
        /liveToolbar\(\)\.addClass\('is-user-hidden'\)/.test(pane773) &&
        /\.is-mobile \.ijipu-score-toolbar\.is-user-hidden \{/.test(css773) &&
        // ⚠ 负向判据剥注释：规则上方的说明里写了"不使用 !important"这几个字，直接搜会被自己的注释绊倒
        !/is-user-hidden[\s\S]{0,80}!important/.test(css773.replace(/\/\*[\s\S]*?\*\//g, '')),
      '')
    // 负对照：把"点工具条自身不切换"这一句去掉后，判据必须为假（证明闸门真的在判）
    {
      const broken = pane773.replace("if (target?.closest('.ijipu-score-toolbar')) return", '')
      check('adj773 负对照：去掉"点工具条自身不切换"后判据为假',
        !/if \(target\?\.closest\('\.ijipu-score-toolbar'\)\) return/.test(broken))
    }
  }

  check('adj741/adj773 `.jps` 文件视图**两端一致：一律先给原生预览**（不再在桌面端默认塞嵌入版 iframe）',
    // adj773：桌面端"直接渲染嵌入版"那条分支已删除；手机端/桌面端走同一套原生预览
    // ⚠ 负向判据剥注释（文件里保留了一句"已删除"的说明）
    !/renderEmbedPlaceholder/.test(fvSrc741.replace(/\/\*[\s\S]*?\*\//g, '')) &&
      !/if \(!Platform\.isMobile && !embedded && !this\.editing && this\.plugin\.embedEnabled/.test(fvSrc741) &&
      // 要用嵌入版编辑 ⇒ 只有「编辑」这一条路（`onEdit` ⇒ 交给插件路由；每次点都生效）
      /onEdit: this\.file/.test(fvSrc741) &&
      /this\.embedRoutedFor = null/.test(fvSrc741))

  /**
   * 用户明确交代：「注意音源默认走的是插件目录里的文件」。
   * `loadHqBank` 的顺序必须是 **插件目录文件 → IndexedDB 缓存 → 联网下载**，
   * 这样手机端（以及桌面端）默认都不联网；只有两处都没有时才去 fetch。
   */
  const bankFn = bankSrc741.slice(bankSrc741.indexOf('export async function loadHqBank'))
  const iFile = bankFn.indexOf('files.read(')
  const iCache = bankFn.indexOf('cache.load(')
  // adj773：下载这一步**回退成 `fetch(`**（`requestUrl` 那版会让用例真联网，见 smoke 顶部的离线闸门与 soundbank 注释）
  const iFetch = bankFn.indexOf('await fetch(')
  check('adj741 音源默认先读**插件目录里的文件**（顺序：文件 → 缓存 → 下载；手机端同样不联网）',
    iFile >= 0 && iCache > iFile && iFetch > iCache,
    `文件=${iFile} 缓存=${iCache} 下载=${iFetch}`)
}

/**
 * ---- adj774：```jps **代码块**也要有「自动格式化 + 脚本着色 + 错误提示」（与手机端 `.jps` 源码编辑一致）----
 *
 * 三项能力共用同一个问题："这一行在不在 ```jps 围栏里？" —— 由纯函数 `jpsBlockRanges` 回答。
 * 这里做**行为测试**（不只是搜源码）：围栏识别、未闭合、缩进边界、`~` 围栏、正文行判定。
 */
{
  const { jpsBlockRanges, isJpsBodyLine } = await import('../src/jpsBlocks')
  const md = ['# 笔记', '', '```jps', '5 5 6 6 | 3 3 4 4', '1 1 2 2 | 5 5 6 6', '```', '', '结尾'].join('\n')
  const r = jpsBlockRanges(md)
  check('adj774 围栏扫描：` ```jps ` 块的行号与正文',
    r.length === 1 &&
      r[0].fenceStart === 3 &&
      r[0].fenceEnd === 6 &&
      r[0].bodyStart === 4 &&
      r[0].bodyEnd === 5 &&
      r[0].body === '5 5 6 6 | 3 3 4 4\n1 1 2 2 | 5 5 6 6',
    JSON.stringify(r[0] ?? null))
  check('adj774 围栏扫描：正文行判定（围栏行不算正文 ⇒ 不会被自动格式化）',
    isJpsBodyLine(r, 4) && isJpsBodyLine(r, 5) && !isJpsBodyLine(r, 3) && !isJpsBodyLine(r, 6) && !isJpsBodyLine(r, 1))
  // 未闭合 ⇒ 延伸到文末（用户刚敲 ` ```jps ` 还没写收尾时，着色/错误提示就该生效）
  const open = jpsBlockRanges('```jps\n5 5 6 6\n1 1 2 2')
  check('adj774 围栏扫描：未闭合块延伸到文末',
    open.length === 1 && open[0].fenceEnd === null && open[0].bodyStart === 2 && open[0].bodyEnd === 3)
  // 负对照：4 空格缩进是"缩进代码块"不是围栏；其它语言不算；`~~~jps` 与带附加词的 info 串算
  check('adj774 围栏扫描负对照：4 空格缩进不算围栏；其它语言不算；`~~~jps` 与带附加词 info 串算',
    jpsBlockRanges('    ```jps\n5 5 6 6\n    ```').length === 0 &&
      jpsBlockRanges('```js\n1 1 2 2\n```').length === 0 &&
      jpsBlockRanges('~~~jps\n1 1 2 2\n~~~').length === 1 &&
      jpsBlockRanges('```jps title=示例\n1 1 2 2\n```').length === 1)
  // 源码接线：三处共用同一份口径；且**只在正文行**上标注/格式化
  const hl = String(readFileSync('src/jpsHighlight.ts', 'utf8'))
  const main774 = String(readFileSync('src/main.ts', 'utf8'))
  const hlBodyClause = 'scope.blocks.some((b) => line.number >= b.bodyStart && line.number <= b.bodyEnd)'
  check('adj774/adj774b 着色与错误提示接到代码块：范围判定用 scopeOf（带按内容缓存的围栏扫描），且只标正文行、行号偏移回文档行号',
    /function scopeOf\(view: EditorView, doc\?: string\): JpsScope \| null \{/.test(hl) &&
      // adj774b：围栏扫描按**文档内容**缓存（长笔记里不该每次重建 decoration 都全篇转字符串 + 扫描）
      /const blockCache = new WeakMap<EditorView, \{ doc: string; blocks: JpsBlockRange\[\] \}>\(\)/.test(hl) &&
      /const blocks = jpsBlockRanges\(doc\)/.test(hl) &&
      /const blocks = blocksOf\(view, text\)/.test(hl) &&
      // 已算好的文档文本要传下去，避免第二次 toString()
      /const scope = scopeOf\(view, doc\)/.test(hl) &&
      hl.includes(hlBodyClause) &&
      /const off = b\.bodyStart - 1/.test(hl) &&
      /problems\.byLine\.get\(line\.number\)/.test(hl) &&
      // 悬停提示同样按 scope 判定（不再只认 .jps 页签）
      /hoverTooltip\(\(view, pos\) => \{[\s\S]{0,80}?if \(scopeOf\(view\) === null\) return null/.test(hl) &&
      // 负对照：把"只标正文行"那一句摘掉后，判据必须为假（证明它真的在挡 markdown 文本）
      !hl.replace(hlBodyClause, '').includes(hlBodyClause))
  check('adj774/adj774e 自动格式化覆盖代码块：只对**已闭合**块的正文行触发，其它 markdown 文本不碰',
    /const isMarkdown = !isOurJpsFile && file\.extension === 'md'/.test(main774) &&
      /const blocks = jpsBlockRanges\(editor\.getValue\(\)\)/.test(main774) &&
      /**
       * adj774e（发布前自审发现的**数据安全**问题）：自动格式化只认**已闭合**的块。
       * 围栏扫描的口径是"未闭合的围栏延伸到文末"（为让着色/错误提示即时生效），若把这条口径
       * 直接用到"真去改文件"上，用户忘写收尾围栏时**普通正文**也会被 `formatLine` 悄悄规范化。
       * 装饰照旧覆盖未闭合块（那反而是"你还没收尾"的有用提示），但改文件必须保守。
       */
      /const closedBlock = blocks\.some\(\(b\) => b\.fenceEnd !== null && line >= b\.bodyStart && line <= b\.bodyEnd\)/.test(main774) &&
      /if \(!closedBlock\) return/.test(main774) &&
      // 旧判据（"只要在正文行里"）不得再用于自动格式化 —— 它没排除未闭合块
      !/if \(!isJpsBodyLine\(blocks, prevLine \+ 1\)\) return/.test(main774) &&
      // 大文档不猜（宁可少格式化，也不能让打字变卡）
      /editor\.getValue\(\)\.length > 200_000/.test(main774) &&
      // 负对照：去掉"必须是已闭合块"这一句 ⇒ 判据为假
      !main774.replace(/if \(!closedBlock\) return/, '').includes('if (!closedBlock) return'))

  /**
   * adj774 **端到端行为测试**：把"最有风险的那一步"——**行号偏移**——用真实数据验一遍。
   *
   * 风险点：块正文是独立交给引擎解析的（行号从 1 数起），而编辑器里用户看到的是**文档行号**。
   * 偏移算错一位，错误提示就会标到别的行上（比"不提示"更糟）。所以这里不复述实现，
   * 而是**按实现的口径**（`off = bodyStart - 1`）跑一遍真实数据，验证落点确实是文档行号。
   */
  {
    const { jpsBlockRanges } = await import('../src/jpsBlocks')
    const doc = [
      '# 我的笔记', // 1
      '', // 2
      '一些说明文字', // 3
      '', // 4
      '```jps', // 5
      '5 5 6 6 | 3 3 4 4', // 6 ← 正确行
      '1 1 2 2 | 5 5 6 6', // 7
      '3 3 4 4 | 1 1 2 x', // 8 ← 故意写错（x 不是音符）
      '```', // 9
      '', // 10
      '结尾', // 11
    ].join('\n')
    const blocks = jpsBlockRanges(doc)
    const b = blocks[0]
    const errors = parseJps(b.body).errors ?? []
    const docLines = errors.map((e) => e.line + (b.bodyStart - 1))
    check('adj774 端到端：块内错误的行号偏移回**文档行号**（第 8 行那条 `x`）',
      blocks.length === 1 &&
        b.bodyStart === 6 &&
        errors.length > 0 &&
        docLines.includes(8) &&
        // 负对照：不偏移就是"块内第 3 行"，与文档第 8 行不是一回事（证明偏移真的在起作用）
        errors.some((e) => e.line === 3) &&
        !errors.some((e) => e.line === 8),
      `块内行=${errors.map((e) => e.line).join(',')} 文档行=${docLines.join(',')}`)
    /**
     * 着色：块正文行确实能被引擎分出 token，且**token 长度之和 == 整行长度**。
     *
     * 后者才是高亮器真正依赖的不变量：`buildDecorations` 用"逐 token 累加长度"算 CM6 的偏移量
     * （见 `jpsHighlight.ts` 顶部说明）——一旦不相等，后面的 token 会整体错位、颜色串行。
     * （教训：我先按想象写成"一定含 barline 类 / level==='none'"，实跑是 `cls=plain level=null`
     * —— 那行没有声部头，引擎判它是普通行。断言要先跑一遍再定稿。）
     */
    const first = b.body.split('\n')[0]
    const model = highlightLineModel(first, 6, [])
    const toks = tokenizeJpsLine(first)
    check('adj774 端到端：块正文行能分出 token，且 token 长度之和 == 整行长度（偏移不错位）',
      model.tokens.length > 0 &&
        toks.length > 0 &&
        toks.reduce((n, t) => n + t.text.length, 0) === first.length &&
        // 负对照：把 token 文本截短一个字符，"长度之和 == 整行"立刻不成立（证明这条不变量真在判）
        toks.reduce((n, t) => n + t.text.length, 0) - 1 !== first.length,
      `tokens=${model.tokens.length} cls=${model.tokens.map((t) => t.cls).join(',')} 行内 token 数=${toks.length}`)
    /**
     * 自动格式化：拿**真实示例谱**里的一行来验 —— 先把它"弄乱"（多个空格、`|` 两侧不留空格），
     * 再过 `formatLine`，必须回到规范写法。
     *
     * 为什么不用我随手编的行：引擎对"没有声部头"的普通行**本来就不做规范化**
     * （实跑 `formatLine('5  5   6 6|3 3 4 4')` 原样返回 —— 我先前断言它会被改，是我想当然了）。
     * 示例谱那一行是真实语法，才有可比性。跨仓拿不到示例谱时**明确跳过**（沿用本套件既有先例）。
     */
    const sampleDir = '../ijipu/public/samples'
    // ⚠ 不要写死文件名（示例谱是中文名，写死一个就等着跳过）—— 取目录里第一个 `.jps`
    const sampleFile =
      existsSync(sampleDir)
        ? (readdirSync(sampleDir).find((f) => f.endsWith('.jps')) ?? null)
        : null
    if (!sampleFile) {
      console.log('[smoke] 拿不到应用示例谱 ⇒ 跳过 adj774 的 formatLine 端到端断言')
      check('adj774 端到端：块内"乱空格"的行经 `formatLine` 变成规范写法', true, 'skipped：跨仓缺少示例谱')
    } else {
      const lines = String(readFileSync(`${sampleDir}/${sampleFile}`, 'utf8')).split('\n')
      // 挑一条"含小节线且已有音符"的实质行
      const good = lines.find((l) => /\|/.test(l) && /\d/.test(l) && !l.trim().startsWith('#')) ?? ''
      const messy = good.replace(/\s+/g, '  ').replace(/\s*\|\s*/g, '|')
      check('adj774 端到端：块内"乱空格"的行经 `formatLine` 变成规范写法',
        good !== '' && messy !== good && formatLine(messy) === good,
        `原文=${JSON.stringify(good)} 弄乱=${JSON.stringify(messy)} 格式化=${JSON.stringify(formatLine(messy))}`)
    }

    /**
     * adj774 **真实示例谱走一遍代码块管线**：围栏扫描 → 只解析正文 → 逐行着色模型。
     *
     * 为什么值得单列：前面几条用的是我编的 3 行小样；真实谱有描述头、多声部、歌词、注释、
     * 空行与 `# jps-config`，**行数多** ⇒ 一旦偏移/范围判定有 off-by-one，真实谱最容易暴露。
     */
    if (sampleFile) {
      const sample = String(readFileSync(`${sampleDir}/${sampleFile}`, 'utf8'))
      const wrapped = ['# 笔记开头', '', '```jps', ...sample.split('\n'), '```', '', '结尾'].join('\n')
      const wb = jpsBlockRanges(wrapped)
      const body = wb[0]?.body ?? ''
      const bodyLines = body.split('\n')
      // ① 围栏扫描：正文就是原始谱的每一行（一行不多、一行不少）
      check('adj774 真实示例谱：围栏扫描出的正文 == 原谱全文（逐行一致）',
        wb.length === 1 &&
          bodyLines.length === sample.split('\n').length &&
          bodyLines.every((l, i) => l === sample.split('\n')[i]),
        `块内 ${bodyLines.length} 行 vs 原谱 ${sample.split('\n').length} 行`)
      // ② 着色：正文里"有实质内容"的行，绝大多数都能分出 token（空行/纯注释允许没有）
      const substantial = bodyLines.filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
      const colored = substantial.filter((l) => highlightLineModel(l, 1, []).tokens.length > 0)
      check('adj774 真实示例谱：正文的实质行都能分出 token（代码块里真会上色）',
        substantial.length > 0 && colored.length === substantial.length,
        `${colored.length}/${substantial.length}`)
      // ③ 错误行号：真实谱若有错，偏移后必须落在"笔记的文档行号"区间内（不能越界/为 0）
      const errs = parseJps(body).errors ?? []
      const offset = (wb[0]?.bodyStart ?? 1) - 1
      check('adj774 真实示例谱：错误行号偏移后落在文档行号区间内（不越界）',
        errs.every((e) => e.line >= 1 && e.line <= bodyLines.length) &&
          errs.every((e) => e.line + offset >= wb[0].bodyStart && e.line + offset <= wb[0].bodyEnd),
        `错误 ${errs.length} 条，偏移 ${offset}`)
    }

    /**
     * adj774 边界：**CRLF（Windows 库）**、**一篇笔记里两个 jps 块**、**列表/引用里缩进的围栏**。
     * Windows 用户的 `.md` 常见 `\r\n` —— 扫描必须先规范化，否则"块的正文"会多出 `\r`，
     * 交给引擎解析就可能把好行判错。
     */
    const crlf = ['前', '```jps', '5 5 6 6 | 3 3 4 4', '```', '后'].join('\r\n')
    const two = ['```jps', '5 5 6 6 | 3 3 4 4', '```', '中间文字', '```jps', '1 1 2 2 | 5 5 6 6', '```'].join('\n')
    const quoted = ['> ```jps', '> 5 5 6 6 | 3 3 4 4', '> ```'].join('\n')
    const rCrlf = jpsBlockRanges(crlf)
    const rTwo = jpsBlockRanges(two)
    check('adj774 边界：CRLF 文档能识别（正文不含 `\\r`）',
      rCrlf.length === 1 &&
        rCrlf[0].fenceStart === 2 &&
        !rCrlf[0].body.includes('\r') &&
        rCrlf[0].body === '5 5 6 6 | 3 3 4 4',
      JSON.stringify(rCrlf[0]?.body ?? null))
    check('adj774 边界：一篇笔记里两个 jps 块各自成块、行号正确',
      rTwo.length === 2 &&
        rTwo[0].fenceStart === 1 &&
        rTwo[0].bodyStart === 2 &&
        rTwo[0].bodyEnd === 2 &&
        rTwo[1].fenceStart === 5 &&
        rTwo[1].bodyStart === 6 &&
        rTwo[1].bodyEnd === 6,
      JSON.stringify(rTwo.map((b) => [b.fenceStart, b.bodyStart, b.bodyEnd])))
    // 负对照：引用块里的 `> ```jps ` 不是围栏（我们只认"≤3 空格缩进"的开栏行）——
    // 这类内容交给宿主自己渲染，插件不去着色，避免把引用里的文字当 jps 源码改坏。
    check('adj774 边界负对照：引用块里的 `> ``` ` 不被当成 jps 围栏',
      quoted.split('\n').some((l) => l.startsWith('>')) && jpsBlockRanges(quoted).length === 0)
  }
}

/**
 * ---- adj775：用户报「PC 端 jps 文件预览的工具条点击编辑**有打开右侧栏/页签，但没有嵌入版 iJipu 显示出来**」----
 *
 * 根因（按代码链路定位）：`embed/appView.ts` 的 `onOpen()` 直接 `await plugin.getEmbedUrl()`，
 * 一旦取 URL 抛错（本机服务启动失败 / 端口被上一次实例占着 / 动态导入失败…），`onOpen` 就**中途中断**
 * ⇒ 页签开出来却**一片空白**，用户完全不知道发生了什么；而且 `main.ts` 里 `embedServerStarting`
 * 会留下一个**永远 rejected 的 promise** ⇒ 此后每次打开都抛同一个错，**没有任何补救手段**。
 *
 * 三条修复各配一条断言（都带负对照）：失败也要画可读提示 + 能重试；失败要清回 null 以便重试；失败原因要留在设置页诊断里。
 */
{
  const appView775 = String(readFileSync('src/embed/appView.ts', 'utf8'))
  const main775 = String(readFileSync('src/main.ts', 'utf8'))
  const settings775 = String(readFileSync('src/settings.ts', 'utf8'))
  check('adj775 嵌入版视图：取 URL 抛错也必须画出可读提示 + 「重试」按钮（绝不空白）',
    /try \{[\s\S]{0,120}?url = await this\.plugin\.getEmbedUrl\(\)/.test(appView775) &&
      /catch \(e\) \{[\s\S]{0,120}?failure = e instanceof Error \? e\.message : String\(e\)/.test(appView775) &&
      /嵌入版启动失败：\$\{failure\}/.test(appView775) &&
      /createEl\('button', \{ cls: 'ijipu-btn', text: '重试' \}\)/.test(appView775) &&
      // 重试 = 重新跑一遍 onOpen（不必让用户去翻设置或重载 Obsidian）
      /retry\.addEventListener\('click', \(\) => \{[\s\S]{0,120}?void this\.onOpen\(\)/.test(appView775) &&
      // 负对照：把 try/catch 摘掉后，"取 URL 被包住"这条判据必须为假
      !/try \{[\s\S]{0,120}?url = await this\.plugin\.getEmbedUrl\(\)/.test(
        appView775.replace(/try \{/, '').replace(/catch \(e\) \{/, ''),
      ))
  check('adj775 失败可重试：`embedServerStarting` 必须清回 null，且记下原因、返回 null（不再留一个永远 rejected 的 promise）',
    /\.catch\(\(e: unknown\) => \{/.test(main775) &&
      /this\.lastEmbedError = msg/.test(main775) &&
      /this\.embedServerStarting = null/.test(main775) &&
      /this\.embedServer = null/.test(main775) &&
      /return null\s*\}\)/.test(main775) &&
      /private embedServerStarting: Promise<EmbedServer \| null> \| null = null/.test(main775) &&
      /return s \? s\.url : null/.test(main775) &&
      // 负对照：去掉"清回 null"那一句 ⇒ 判据为假（说明它真的在防"永久失败"）
      // ⚠ 用**全局**替换：`String.replace(字符串)` 只换第一处，会把"字段声明里那个 `= null`"留下
      //   ⇒ 负对照自己变成假阴性（本轮踩到过）
      !/this\.embedServerStarting = null/.test(main775.replace(/this\.embedServerStarting = null/g, '')))
  check('adj775 失败原因可在「设置 → iJipu → 说明」里看到（用户能直接贴回来定位）',
    /lastEmbedError/.test(settings775) && /嵌入版本地服务（诊断信息，无需操作）/.test(settings775))

  /**
   * adj773/adj775 **文案与行为一致**：改了"点 `.jps` 先给预览、编辑才进嵌入版"之后，
   * 设置里那句"在库里打开 `.jps` 会用这个完整编辑器打开"就**不再成立** ⇒ 必须一起改掉。
   * （改行为不改文案是"用户按文案操作却得不到那个结果"的经典来源。）
   */
  const readme775 = String(readFileSync('README.md', 'utf8'))
  check('adj775 文案跟行为一致：设置与 README 都写"先给预览、点「编辑」进完整编辑器"',
    /点库里打开 `\.jps` \*\*一律先给谱面预览\*\*/.test(settings775) &&
      /点预览工具条最右的「编辑」即可/.test(settings775) &&
      /点开先看\*\*谱面预览\*\*，点工具条最右的「编辑」用完整编辑器/.test(readme775) &&
      // 负对照：那句过时文案不得再出现（它会让人以为"点文件就直接进编辑器"）。
      // ⚠ 必须先剥注释：我在这段设置文案旁边留了"原来写的是…"的说明，那句话里就有旧文案（第三次踩到）
      !/在库里打开 `\.jps` 会用这个完整编辑器打开/.test(codeOf(settings775)))
}

/**
 * ---- adj774c：CSS **结构闸门**（本轮教训：断言全是字符串匹配 ⇒ "CSS 结构已坏"抓不到 ⇒ 套件绿而样式死）----
 *
 * 由来：我修"代码块不上色"时，用脚本把新选择器**插进了声明块内部**（`X {` 换行 `Y {`），
 * 整块规则因此作废、颜色全失效，而 `npm run smoke` 依然 **360 passed** ✗ —— 这是"断言绿、功能死"的盲区。
 * 现在把它变成机器闸门：去注释后校验 ① 大括号平衡、② 嵌套不超过 `@media` 允许的一层、
 * ③ **同一层里不得出现"选择器紧跟选择器"**（就是本轮那种坏法）。配负对照。
 */
{
  const css774c = String(readFileSync('styles.css', 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
  /** 返回 { balance, maxDepth, badSelectors } */
  const inspectCss = (css: string): { balance: number; maxDepth: number; badSelectors: number } => {
    const lines = css.split('\n')
    let depth = 0
    let maxDepth = 0
    let badSelectors = 0
    /** 每层"刚刚开了一条规则（不是 at-rule）"的标记 */
    const opened: boolean[] = []
    for (const raw of lines) {
      const t = raw.trim()
      if (t.endsWith('{')) {
        const isAt = t.startsWith('@')
        if (!isAt && opened[depth] === true) badSelectors++
        depth++
        if (depth > maxDepth) maxDepth = depth
        opened[depth] = !isAt
      } else if (t === '}') {
        opened[depth] = false
        depth--
      }
    }
    return { balance: depth, maxDepth, badSelectors }
  }
  const real = inspectCss(css774c)
  check('adj774c CSS 结构闸门：大括号平衡、嵌套不超 @media 一层、同层不出现"选择器紧跟选择器"',
    real.balance === 0 && real.maxDepth <= 2 && real.badSelectors === 0,
    `balance=${real.balance} maxDepth=${real.maxDepth} badSelectors=${real.badSelectors}`)
  /**
   * 负对照：本轮真实踩过的坏法（选择器插进声明块）必须被判出来。
   * ⚠ 注意它**括号是平衡的**（2 开 2 闭）—— 危害在"同层出现第二条规则"，不在括号数
   * （我一开始把期望写成 `balance !== 0`，跑出来 balance=0 才发现这层想错了）。
   */
  const broken = '.a {\n.b {\n  color: red;\n}\n}'
  const b = inspectCss(broken)
  check('adj774c 负对照：把选择器插进声明块（本轮踩过的坏法）会被判出',
    b.badSelectors > 0,
    `balance=${b.balance} badSelectors=${b.badSelectors}`)
  /**
   * adj774c 还钉住这次修法的结果：token 颜色必须**同时**对"借宿主打开的 .jps 页签"和
   * "含 ```jps 块的 markdown 笔记"生效（后者原来完全没有颜色 ⇒ 代码块看着没上色）。
   */
  check('adj774c token 颜色两种作用域并列生效（markdown 笔记里的 ```jps 也会上色）',
    /\.workspace-leaf\.ijipu-plain-source \.cm-content \.cm-line \.ijipu-jps-note,\n\.ijipu-has-jps-block \.cm-content \.cm-line \.ijipu-jps-note \{/.test(
      css774c,
    ) &&
      /classList\.toggle\('ijipu-has-jps-block'/.test(String(readFileSync('src/jpsHighlight.ts', 'utf8'))) &&
      // 中和 Markdown 着色那几条**不得**扩到容器作用域（否则会影响整篇笔记的文字颜色）
      !/\.ijipu-has-jps-block \.cm-content \.cm-line \{/.test(css774c))
}

/**
 * ---- adj774d：**类名 ↔ CSS 覆盖闸门**（adj774c 那个教训的推广）----
 *
 * adj774c 暴露的盲区是："代码里把类挂上了、CSS 里那条规则却**不适用于这个场景**" ⇒ 断言全绿、样式是死的。
 * 光校验 CSS 结构不够，还要校验**语义覆盖**：代码里发出的每个 jps 类，CSS 里都得有规则；
 * 而需要"两套作用域"的那批（token 颜色 / 行级底色 / 错误块外框），**页签作用域与含 jps 块的笔记**两边都要有。
 * 这样下次再写出"只在 .jps 页签生效"的样式，套件会直接红，而不是等用户报"代码块没颜色"。
 */
{
  const hl774d = String(readFileSync('src/jpsHighlight.ts', 'utf8'))
  const css774d = String(readFileSync('styles.css', 'utf8'))
  const classes = new Set<string>()
  for (const m of hl774d.matchAll(/'(ijipu-jps-[a-z-]+)'/g)) classes.add(m[1])
  const all = [...classes].sort()
  const missing = all.filter((c) => !css774d.includes(`.${c}`))
  check('adj774d 代码里发出的每个 jps 类，CSS 里都有对应规则',
    all.length >= 8 && missing.length === 0,
    `类=${all.length} 缺=${missing.join(',') || '（无）'}`)
  // 悬停提示那批渲染在 CM 的 tooltip 容器里（不在 .cm-line 下）⇒ 本就该是"无作用域"规则
  const needBoth = all.filter((c) => !c.includes('problem'))
  const lacks = needBoth.filter(
    (c) => !new RegExp(`ijipu-plain-source[^\\n]*${c}`).test(css774d) || !new RegExp(`ijipu-has-jps-block[^\\n]*${c}`).test(css774d),
  )
  check('adj774d 需要两套作用域的类（token 颜色/行级底色/错误块外框）在"页签"与"含 jps 块的笔记"下都有规则',
    needBoth.length >= 8 && lacks.length === 0,
    `需两套=${needBoth.length} 缺=${lacks.join(',') || '（无）'}`)
  /** 负对照：把"容器作用域"那批规则整段删掉，第二条判据必须能判出缺失（证明它真的在判覆盖） */
  const stripped = css774d.replace(/[^\n]*ijipu-has-jps-block[^\n]*\{/g, '')
  const lacksAfter = needBoth.filter((c) => !new RegExp(`ijipu-has-jps-block[^\\n]*${c}`).test(stripped))
  check('adj774d 负对照：删掉容器作用域规则后，覆盖判据能判出缺失',
    lacksAfter.length === needBoth.length && needBoth.length > 0,
    `判出 ${lacksAfter.length}/${needBoth.length}`)
}

/**
 * ---- adj776：用户实测「PC 端点击工具条的编辑时，还是无法打开嵌入版 ijipu，提示嵌入版未启用」----
 *
 * 根因（不是"服务起不来"，而是**开关关着**）：`getEmbedUrl()` 的第一条提前返回是
 * `if (!this.embedEnabled && this.embedServer === null) return null` ⇒ 设置里
 * 「使用嵌入版 iJipu（完整应用）」关掉时它**直接返回 null**（不抛错）⇒ 视图走的是"未启用"提示分支
 * （所以我上一轮加的"启动失败：<原因>"没机会显示，用户看到的正是"未启用"）。
 *
 * 真正的缺口：**「编辑」按钮此前不看这个开关**，照样打开嵌入版视图 ⇒ 用户得到一个"死页签"，
 * 而他的意图（编辑）完全没被满足。修法：开关关着 ⇒ 退回**源码编辑**（手机端那条路径）+ 说明去哪儿开开关；
 * 视图侧那条提示也补上**确切开关名**与一键「打开设置」。
 */
{
  const fv776 = String(readFileSync('src/fileView.ts', 'utf8'))
  const av776 = String(readFileSync('src/embed/appView.ts', 'utf8'))
  const main776 = String(readFileSync('src/main.ts', 'utf8'))
  const guard = 'if (!this.plugin.embedEnabled) {'
  check('adj776 嵌入版开关关着时，「编辑」退回源码编辑（不再打开一个写着"未启用"的死页签）',
    fv776.includes(guard) &&
      /「使用嵌入版 iJipu（完整应用）」当前是关闭的 ⇒ 已改用 Obsidian 编辑器编辑源码/.test(fv776) &&
      /this\.toggleSource\(\)/.test(fv776) &&
      // 打开（开关开着）时仍是原来的"每次点都生效"的路由
      /this\.embedRoutedFor = null[\s\S]{0,80}?this\.routeToIjipu\(f\)/.test(fv776) &&
      // 负对照：把这条守卫摘掉 ⇒ 判据为假（证明它真的在挡"死页签"）
      !fv776.replace(guard, '').includes(guard))
  check('adj776 视图侧提示给出确切开关名，并提供一键「打开设置」',
    /请在「设置 → iJipu → 嵌入版」打开「使用嵌入版 iJipu（完整应用）」/.test(av776) &&
      /createEl\('button', \{ cls: 'ijipu-btn', text: '打开设置' \}\)/.test(av776) &&
      /openSettingsTab\('嵌入版'\)/.test(av776) &&
      // 根因路径也要钉住：开关关着 ⇒ getEmbedUrl 提前返回 null（不抛错）⇒ 所以文案必须是"未启用"而不是"启动失败"
      /if \(!this\.embedEnabled && this\.embedServer === null\) return null/.test(main776))
  /**
   * adj776b：**同类缺口一次清干净** —— 不只是文件视图的「编辑」，任何路径都不该在开关关着时开出"死页签"。
   *  · `openEmbedLeaf`（下层唯一出口）⇒ 未启用只给提示、不建视图；
   *  · `openEmbedSoundbank`（"试听失败 → 打开音色库设置"按钮）⇒ 未启用就直接送到设置「说明」页
   *    （那里有音色库入口，正是用户要的落点）。
   */
  const leafGuard = 'if (!this.embedEnabled) {\n      new Notice('
  check('adj776b 开关关着时任何入口都不开"死页签"：下层出口兜住 + 音色库入口改送设置「说明」页',
    main776.includes(leafGuard) &&
      /要使用完整编辑器：设置 → iJipu → 嵌入版 → 打开该开关/.test(main776) &&
      /已打开设置里的「说明」页（含音色库入口）/.test(main776) &&
      /if \(!this\.embedEnabled\) \{\n      this\.openSettingsTab\('说明'\)/.test(main776) &&
      // 负对照：把下层出口那条守卫摘掉 ⇒ 判据为假（证明它真的在挡"死页签"）
      !main776.replace(leafGuard, 'if (false) {').includes(leafGuard))
}

// ⚠ 这一行**不能删**：它是套件唯一的"总结 + 计数"输出（缺了它，失败数就看不到了）。
//   实测踩过：一次编辑顺手把它删掉，套件仍以退出码报错，但输出里再也看不到 `N passed, M failed`。
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
