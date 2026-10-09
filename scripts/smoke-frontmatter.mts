/**
 * scripts/smoke-frontmatter.mts — 笔记 frontmatter（ijipu_*）→ PageConfig 的纯逻辑断言
 *
 * 运行：npm run smoke（esbuild 打包到 dist-smoke/ 后 node 执行）
 * 断言来源：用户反馈「在 frontmatter 里设置像 `ijipu_note_size` 好像没生效」——
 * 覆盖键名写法兼容、值类型转换、未识别键提示、优先级四类。
 */
import { defaultPageConfig, dragDelta, layoutScore, parseJps, renderScoreToSvg, writeJpsConfig, mergeConfigEdits, configCarryover, SCORE_FONT_OPTIONS, buildPlaySequence, GUIDE_LIMITS, GUIDE_LIMITS_EX, SEGMENT_ROW_GAP_DEFAULT, OPTIONAL_CONFIG_FIELDS, defaultConfigForReset, extractJpsConfig, nonDefaultConfigKeys, GM_GROUPS } from '@ijipu/engine'
import type { PageConfig } from '@ijipu/engine'
import { readFileSync } from 'node:fs'
import { instrumentColorMap, playheadBaseOf, playheadPosIn, trackKeysOf } from '../src/playhead'
import { applyFrontmatter, buildFrontmatterTemplate, deprecatedKeyHint, frontmatterKey, mergePageConfig, unknownKeyHint, PAGE_CONFIG_FIELDS } from '../src/frontmatter'
import { PAGE_NUM_RANGES, clampNum } from '../src/numRanges'
// adj631：设置面板的纯逻辑（页签/收藏音色分类列表/「保存为插件默认」的改动判据）
// —— `obsidian` 依赖已由 `npm run smoke` 的 `--alias:obsidian=./scripts/obsidianStub.ts` 替换掉
import { DEFS, changedDefs, getDefault, isDefaultValue } from '../src/defs'
import { clearVoices, filterVoices, groupVoices, invertVoices, normalizeVoices, selectAllVoices, selectedInGroup, setGroupVoices, toggleVoice, voiceSummary } from '../src/voiceChooser'
import { resolvePageConfig } from '../src/config'
import { codeBlockBody, jpsLinkpath, replaceCodeBlockBody } from '../src/sourceEdit'
import { computeGuideLines, cropRectFor, guideLimits, guidePlacement } from '../src/guides'
import { splitParseIssues } from '../src/parseIssues'
// adj724b：「打开 .jps 的方式 → 开在哪里」是**纯函数**，冒烟直接跑它
// （此前只能对 main.ts 做字符串匹配：脆，且注释里写同样的字都会误判）
import { planEmbedTarget } from '../src/embed/openPlan'
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

const CFG = (fm: Record<string, unknown>, defaults: Record<string, unknown> = {}) =>
  applyFrontmatter(defaults as never, fm)

console.log('[1] 键名写法兼容（snake_case / camelCase / 全小写）')
{
  const a = CFG({ ijipu_note_size: 15 })
  check('ijipu_note_size（引擎字段原样）生效', a.config.note_size === 15, String(a.config.note_size))
  const b = CFG({ ijipu_noteSize: 16 })
  check('ijipu_noteSize（camelCase）同样生效', b.config.note_size === 16, String(b.config.note_size))
  // README 旧示例里的写法：字段 noteSpaceLayout —— 全小写下划线写法必须也被接受
  const c = CFG({ ijipu_note_space_layout: 'duration' })
  check('ijipu_note_space_layout（旧示例写法）生效', c.config.noteSpaceLayout === 'duration', String(c.config.noteSpaceLayout))
  const d = CFG({ ijipu_show_instrument: true })
  check('ijipu_show_instrument（旧示例写法）生效', d.config.showInstrument === true, String(d.config.showInstrument))
  const e = CFG({ IJIPU_NOTE_SIZE: 17 })
  check('大小写不敏感（IJIPU_NOTE_SIZE）', e.config.note_size === 17, String(e.config.note_size))
}

console.log('[2] 值类型按字段类型转换（Properties 面板常存成字符串）')
{
  check('字符串数字 "15" → 15', CFG({ ijipu_note_size: '15' }).config.note_size === 15)
  check('带空格 " 15 " → 15', CFG({ ijipu_note_size: ' 15 ' }).config.note_size === 15)
  check('布尔 是 → true', CFG({ ijipu_showInstrument: '是' }).config.showInstrument === true)
  check('布尔 否 → false（无默认值的可选字段也要按类型转换，不能留成真值字符串）', CFG({ ijipu_lyricShrink: '否' }).config.lyricShrink === false)
  check('布尔 1 → true', CFG({ ijipu_showInstrument: 1 }).config.showInstrument === true)
  check('布尔 false 原样', CFG({ ijipu_showInstrument: false }).config.showInstrument === false)
  check('字符串字段原样保留（字体含单引号/逗号）', CFG({ ijipu_shuzi_font: "'SimHei', sans-serif" }).config.shuzi_font === "'SimHei', sans-serif")
  check('枚举字段（纸张）原样保留', CFG({ ijipu_page: 'A4_horizontal' }).config.page === 'A4_horizontal')
  check('无法转换的数字（abc）视为未设置 → 回落默认', CFG({ ijipu_note_size: 'abc' }).config.note_size === defaultPageConfig.note_size)
  check('空字符串视为未设置 → 回落默认', CFG({ ijipu_note_size: '' }).config.note_size === defaultPageConfig.note_size)
  check('null 视为未设置 → 回落默认', CFG({ ijipu_note_size: null }).config.note_size === defaultPageConfig.note_size)
  check('无法转换/空值不计入"已生效"（避免徽标虚报）', CFG({ ijipu_note_size: '' }).applied.length === 0)
  check('对象类字段（metaPos）原样透传', typeof CFG({ ijipu_metaPos: { a: { x: 1, y: 2 } } }).config.metaPos === 'object')
}

console.log('[3] 可选字段（无默认值）必须被识别——否则键会被静默忽略')
{
  // 引擎 defaultPageConfig 只含 28 个有默认值的字段；lyricShrink/showInstrument 等 6 个可选字段
  // 不在其中，若按 defaultPageConfig 建映射就会把 ijipu_showInstrument 判成未识别键
  const opt = CFG({ ijipu_showInstrument: true, ijipu_lyricShrink: true })
  check('ijipu_showInstrument 被识别并生效', opt.config.showInstrument === true && opt.applied.some((a) => a.field === 'showInstrument'))
  check('ijipu_lyricShrink 被识别并生效', opt.config.lyricShrink === true)
  check('可选字段不再出现在"未识别"里', opt.unknown.length === 0, JSON.stringify(opt.unknown))
  const fields = Object.keys(defaultPageConfig)
  check(`字段表覆盖引擎默认字段（${fields.length} 个）`, fields.every((f) => PAGE_CONFIG_FIELDS.includes(f as never)))
  check(`字段表字段数 = 35（引擎 37 字段去掉编辑器偏好 2 项；adj625 新增 showBarCount/barCountInterval）`, PAGE_CONFIG_FIELDS.length === 35, String(PAGE_CONFIG_FIELDS.length))
  check('字段表无重复（规范化后不冲突）', new Set(PAGE_CONFIG_FIELDS.map((f) => f.replace(/[^a-z0-9]/gi, '').toLowerCase())).size === PAGE_CONFIG_FIELDS.length)
}

console.log('[3b] adj625 方框小节序号两项（同步主项目：谱面变量里可设）')
{
  const g = CFG({ ijipu_showBarCount: true, ijipu_barCountInterval: 2 })
  check('ijipu_showBarCount 被识别并生效（布尔）',
    g.config.showBarCount === true && g.applied.some((a) => a.field === 'showBarCount'), String(g.config.showBarCount))
  check('ijipu_barCountInterval 被识别并生效（数字，字符串 "2" 也转成数字）',
    g.config.barCountInterval === 2 && g.applied.some((a) => a.field === 'barCountInterval'), String(g.config.barCountInterval))
  check('两项都不落进"未识别"', g.unknown.length === 0, JSON.stringify(g.unknown))
  check('旧示例写法 ijipu_show_bar_count / ijipu_bar_count_interval 同样生效',
    CFG({ ijipu_show_bar_count: true }).config.showBarCount === true &&
      CFG({ ijipu_bar_count_interval: 8 }).config.barCountInterval === 8)
  check('关闭时不写多余值：false 原样（等于默认，不亮"非默认"）',
    CFG({ ijipu_showBarCount: false }).config.showBarCount === false)
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
  check('应用不暴露的 `bar_gap` 不再出现在设置表里（但仍可随谱携带：PAGE_CONFIG_FIELDS 里有）',
    !/key: 'bar_gap'/.test(defsSrc) && PAGE_CONFIG_FIELDS.includes('bar_gap' as never))
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
  // ⑥ frontmatter 模板：嵌套字段只写一行 YAML（三行会互相覆盖、且会变成 [object Object]）
  const tpl = buildFrontmatterTemplate(
    [
      { key: 'note_size', group: '字体', label: '音符字号' },
      { key: 'segmentRowGap', sub: 'bz', group: '行距', label: 'bz 段上下间距' },
      { key: 'segmentRowGap', sub: 'dsb', group: '行距', label: 'dsb 段上下间距' },
      { key: 'segmentRowGap', sub: 'tp', group: '行距', label: '替谱行与下方歌词间距' },
    ],
    ['字体', '行距'],
    (d) => (d.sub ? (SEGMENT_ROW_GAP_DEFAULT as Record<string, number>)[d.sub] : 13),
  )
  check('frontmatter 模板把 `segmentRowGap` 合成一行流式映射（不是三行、不出 [object Object]）',
    tpl.includes('ijipu_segmentRowGap: {bz: 22, dsb: 22, tp: 14}') &&
      !tpl.includes('[object Object]') &&
      (tpl.match(/ijipu_segmentRowGap/g) ?? []).length === 1,
    tpl)
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
  // ④ README「Frontmatter 键对照表」逐行核对：每个设置项都有一行，且行里写的默认值 = 引擎默认值
  //    （字体行文档只写"系统栈"，不做数值核对；可选布尔项要求写明默认 false）
  const readme = String(readFileSync('README.md', 'utf8'))
  const docRows = readme.split('\n').filter((l) => l.trim().startsWith('|') && l.includes('`ijipu_'))
  const cellOf = (key: string) => {
    const row = docRows.find((r) => r.includes(`\`ijipu_${key}\``))
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
      /mode === 'defaultApp'[\s\S]{0,420}?openWithDefaultApp\(/.test(mainSrc) &&
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
    check('adj724b 点 `.jps` 不留中间页签：把**本页签**交给插件路由（由它按模式决定就地替换/关掉）',
      /private routeToIjipu\(file: TFile\): void \{/.test(viewSrc) &&
        // 关键：把 `this.leaf` 交出去 —— 「当前页签」靠它做就地替换，而不是靠猜
        /await this\.plugin\.openIjipuFile\(file, this\.leaf\)/.test(viewSrc) &&
        // 关页签的判断已收到插件的纯函数计划里（`plan.detachSource`），视图不再自己判断
        !/this\.leaf\.detach\(\)/.test(viewSrc) &&
        // 一个文件只路由一次（视图重画不该反复跳）
        /if \(this\.embedRoutedFor === file\.path\) return/.test(viewSrc) &&
        // 中转提示改成"正在打开…"（不再宣称"已打开"并教用户去哪设置）
        /正在爱记谱（嵌入版）中打开/.test(viewSrc) &&
        // 注意：看的是**渲染出来的文案**（`createDiv({ text: …`)），不是注释里引用的原文——
        // 注释里必然会提到旧文案，直接搜整份源码会被自己的注释绊倒（同 E-2026-237 的坑）
        !/text: `「\$\{file\.basename\}」已在爱记谱/.test(viewSrc))
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
  check('⑦b 「未随谱携带 N 项」已从工具条移进对话框（工具条只剩可点按钮；且按 adj639 口径传 baseline）',
    !/未随谱携带/.test(paneCode) && /未随谱携带/.test(dlgSrc) &&
      /carryover: carry\.ok \? \[\] : carry\.missing/.test(paneSrc) &&
      /configCarryover\(host\.getSource\(\), resolved\.config, resolved\.baseline\)/.test(paneSrc) &&
      /opts\.carryover\.length > 0/.test(dlgSrc) && /ijipu-config-src--carry/.test(cssSrc),
    `pane 残留=${/未随谱携带/.test(paneCode)} 对话框有=${/未随谱携带/.test(dlgSrc)}`)
  check('⑦c 两块提示的顺序 = 「谱面自带设置」在上、「未随谱携带」紧跟其下（用户要求）',
    dlgSrc.indexOf('谱面自带设置 ${this.opts.sourceFields.length} 项') <
      dlgSrc.indexOf('未随谱携带 ${this.opts.carryover.length} 项') &&
      dlgSrc.indexOf('未随谱携带 ${this.opts.carryover.length} 项') < dlgSrc.indexOf('ijipu-config-tabs'))
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

console.log('[4] 未识别键不再静默忽略（给出最近键名建议）')
{
  const a = CFG({ ijipu_paper: 'A4' })
  check('ijipu_paper 判为未识别', a.unknown.length === 1 && a.unknown[0].key === 'ijipu_paper')
  check('ijipu_paper 建议 ijipu_page', a.unknown[0]?.suggest === 'ijipu_page', String(a.unknown[0]?.suggest))
  check('未识别键不污染配置（纸张仍是默认 A4）', a.config.page === defaultPageConfig.page)
  const b = CFG({ ijipu_margin_leftt: 40 })
  check('拼错的 ijipu_margin_leftt 建议 ijipu_margin_left', b.unknown[0]?.suggest === 'ijipu_margin_left', String(b.unknown[0]?.suggest))
  const c = CFG({ ijipu_zzzzzzzzzz: 1 })
  check('毫无相近项的键建议为 null（不误导）', c.unknown[0]?.suggest === null, String(c.unknown[0]?.suggest))
  check('提示文案含"是否想写"', unknownKeyHint([{ key: 'ijipu_paper', suggest: 'ijipu_page' }]).includes('是否想写 ijipu_page'))
  check('提示文案对无建议键只回显键名', unknownKeyHint([{ key: 'ijipu_zzz', suggest: null }]) === 'ijipu_zzz')
}

console.log('[5] 非业务键与优先级')
{
  const a = CFG({ position: {}, aliases: ['x'], tags: ['y'], title: '笔记标题' })
  check('元数据自带的 position/aliases/tags 与普通键不误判', a.unknown.length === 0 && a.applied.length === 0)
  const b = applyFrontmatter({ note_size: 20 }, { ijipu_note_size: 15 })
  check('优先级：frontmatter > 插件设置', b.config.note_size === 15, String(b.config.note_size))
  const c = applyFrontmatter({ note_size: 20 }, {})
  check('优先级：插件设置 > 默认', c.config.note_size === 20, String(c.config.note_size))
  const d = applyFrontmatter({}, {})
  check('无 frontmatter 时全部走默认', d.config.note_size === defaultPageConfig.note_size && d.applied.length === 0)
  const e = mergePageConfig({}, { ijipu_note_size: 18 })
  check('mergePageConfig 兼容旧调用（返回配置）', e.note_size === 18)
}

console.log('[6] 键名映射与全字段命中')
{
  check('frontmatterKey(note_size) = ijipu_note_size', frontmatterKey('note_size') === 'ijipu_note_size')
  const miss = PAGE_CONFIG_FIELDS.filter((f) => {
    const probe = defaultPageConfig[f as keyof typeof defaultPageConfig] ?? (typeof f === 'string' && f.endsWith('Font') ? 'x' : 1)
    const r = applyFrontmatter({}, { [frontmatterKey(f)]: probe })
    return r.applied.length !== 1
  })
  check(`字段表全部 ${PAGE_CONFIG_FIELDS.length} 个字段都能被同名 frontmatter 键命中`, miss.length === 0, miss.join(','))
  const appliedOnce = CFG({ ijipu_note_size: 15, ijipu_noteSize: 16 })
  check('同一字段两种写法重复出现时以最后写入为准（不报错）', appliedOnce.config.note_size === 16, String(appliedOnce.config.note_size))

  /**
   * adj724b（用户决策 A）：模板的 **include 过滤器**（「复制最小模板」靠它只留与默认不同的项）。
   * 纯函数，直接喂小样本核对 —— 重点是三件事：
   *  ① 过滤掉不该出现的项；② 嵌套字段只保留通过过滤的子项（而不是整行照抄）；
   *  ③ 一项都不剩时返回**空串**（调用方据此提示"没有需要写的项"，而不是给出一个空的 `---/---`）。
   */
  const sampleDefs = [
    { key: 'note_size', group: '字体', label: '音符字号' },
    { key: 'segmentRowGap', sub: 'bz', group: '行距', label: '临时段间距' },
    { key: 'segmentRowGap', sub: 'dsb', group: '行距', label: '临时段间距' },
    { key: 'lyricShrink', group: '渲染', label: '歌词压缩' },
  ]
  const sampleGroups = ['字体', '行距', '渲染']
  const sampleValues: Record<string, unknown> = {
    note_size: 14,
    'segmentRowGap:bz': 22,
    'segmentRowGap:dsb': 99,
    lyricShrink: true,
  }
  const valOf = (d: { key: string; sub?: string }): unknown =>
    sampleValues[d.sub ? `${d.key}:${d.sub}` : d.key]
  const onlyChanged = (d: { key: string; sub?: string }): boolean => valOf(d) !== 22
  const minimal = buildFrontmatterTemplate(sampleDefs, sampleGroups, valOf, onlyChanged)
  check('adj724b 最小模板：过滤掉与默认相同的项', !minimal.includes('ijipu_segmentRowGap: {bz'), minimal.replace(/\n/g, ' ⏎ '))
  check('adj724b 最小模板：嵌套字段只保留通过过滤的子项（dsb 被改过 ⇒ 保留）', minimal.includes('{dsb: 99}'), minimal.replace(/\n/g, ' ⏎ '))
  check('adj724b 最小模板：仍写出未过滤的普通项', minimal.includes('ijipu_note_size: 14') && minimal.includes('ijipu_lyricShrink: true'))
  const minimalEmpty = buildFrontmatterTemplate(sampleDefs, sampleGroups, () => 22, () => false)
  check('adj724b 最小模板：一项都不剩时返回空串（不给出空的 ---/---）', minimalEmpty === '', JSON.stringify(minimalEmpty))
  check('adj724b 完整模板：不过滤时仍含全部项', buildFrontmatterTemplate(sampleDefs, sampleGroups, valOf).includes('{bz: 22, dsb: 99}'))
}

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
  const r = resolvePageConfig(withCfg, { note_size: 99, margin_left: 99 }, { ijipu_note_size: 88, ijipu_margin_right: 12 })
  check('源内设置 > frontmatter > 插件设置（note_size=15）', r.config.note_size === 15, String(r.config.note_size))
  check('源内设置生效（margin_left=32 / noteSpaceLayout=duration / lianyinxian_type=2）', r.config.margin_left === 32 && r.config.noteSpaceLayout === 'duration' && r.config.lianyinxian_type === 2)
  check('源内可选字段往返保真（showInstrument/lyricShrink=true）', r.config.showInstrument === true && r.config.lyricShrink === true, `${r.config.showInstrument}/${r.config.lyricShrink}`)
  check('源内未写的键可由 frontmatter 提供（差量写入下 margin_right 不在源内 → 用 frontmatter 12）', r.config.margin_right === 12, String(r.config.margin_right))
  // 源内写了的键优先级最高（差量写入：源内只含与默认不同的项）
  const srcWins = resolvePageConfig(writeJpsConfig(SRC, { ...defaultPageConfig, margin_left: 32 }), {}, { ijipu_margin_left: 99 })
  check('源内写了的键 > frontmatter（margin_left 用源内 32，而非 99）', srcWins.config.margin_left === 32, String(srcWins.config.margin_left))
  // 源内只写部分键（手写的最小设置行）→ 其余键交给 frontmatter / 插件设置
  const partial = `${SRC}\n# jps-config:{"note_size":15}\n`
  const rp = resolvePageConfig(partial, { margin_right: 40 }, { ijipu_margin_right: 12 })
  check('源内只写部分键时，其他键由 frontmatter 生效（margin_right=12）', rp.config.margin_right === 12, String(rp.config.margin_right))
  check('源内部分设置里的键仍最高优先（note_size=15）', rp.config.note_size === 15, String(rp.config.note_size))
  check('源内/frontmatter 都没写 → 插件设置生效（bar_gap）', resolvePageConfig(SRC, { bar_gap: 7 }, {}).config.bar_gap === 7)
  check('sourceFields 报告源内生效字段数（差量写入⇒只含非默认项）且含 showInstrument', r.sourceFields.length >= 5 && r.sourceFields.includes('showInstrument'), `${r.sourceFields.length}:${r.sourceFields.join(',')}`)
  check('无源内设置时 sourceFields 为空', resolvePageConfig(SRC, {}, {}).sourceFields.length === 0)
  check('无源内设置时行为与此前一致（插件设置 > 默认）', resolvePageConfig(SRC, { note_size: 20 }, {}).config.note_size === 20)
  check('源内设置行不影响解析（仍是 1 个曲行、无错误）', resolvePageConfig(withCfg, {}, {}).config.note_size === 15)
  // 端到端等价性：同一份 .jps（含设置行）在两端解析出的配置应完全一致
  const dst = resolvePageConfig(withCfg, {}, null).config
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
  // ① 已降级的旧键：写法合法但不再随谱保存——给"为什么不生效"的提示，而不是当成拼写错误
  const dep = applyFrontmatter({}, { ijipu_editorFont: 'SimHei', ijipu_editor_font_size: 22 })
  check('ijipu_editorFont 归入「已不再随谱保存」而非未识别', dep.deprecated.length === 2 && dep.unknown.length === 0, JSON.stringify({ dep: dep.deprecated, unk: dep.unknown }))
  check('已降级键不影响配置（不写入 config）', !('editorFont' in (dep.config as unknown as Record<string, unknown>)) && !('editorFontSize' in (dep.config as unknown as Record<string, unknown>)))
  check('提示文案说明原因（本机偏好）', deprecatedKeyHint(dep.deprecated).includes('本机偏好'), deprecatedKeyHint(dep.deprecated))
  check('字段表不再包含编辑器偏好键', !PAGE_CONFIG_FIELDS.includes('editorFont' as never) && !PAGE_CONFIG_FIELDS.includes('editorFontSize' as never))

  // ② 差量写入：源内只记录与默认不同的项；全部默认则删除设置行
  const src = 'V: 1.0\nB: t\nD: G\nP: 4/4\nQ: 1 2 3 4 |\n'
  const changed = resolvePageConfig(src, { margin_left: 32 }, {}).config
  const line = writeJpsConfig(src, changed).split('\n').find((l) => l.startsWith('# jps-config:')) ?? ''
  const written = JSON.parse(line.slice('# jps-config:'.length)) as Record<string, unknown>
  check('插件路径同样差量写入（只含 margin_left）', Object.keys(written).join(',') === 'margin_left', Object.keys(written).join(','))
  check('全部为默认时不写设置行', !writeJpsConfig(src, { ...defaultPageConfig }).includes('# jps-config:'))

  // ③ 字体：候选都以通用族兜底；旧谱面裸字体名读取时自动补 fallback
  //   （插件 defs.ts 的 FONTS 直接引用引擎 SCORE_FONT_OPTIONS，此处断言引擎目录即可）
  check(`插件字体候选（${SCORE_FONT_OPTIONS.length} 项）都以通用族兜底`, SCORE_FONT_OPTIONS.every((o) => /sans-serif|serif|monospace|system-ui/.test(o.value)), SCORE_FONT_OPTIONS.map((o) => o.label).join(','))
  const legacyFont = `V: 1.0\nB: t\nD: G\nP: 4/4\nQ: 1 2 3 4 |\n\n# jps-config:{"geci_font":"SimSun"}\n`
  check('旧谱面裸字体名（SimSun）读取时自动补 serif', resolvePageConfig(legacyFont, {}, {}).config.geci_font === 'SimSun, serif', String(resolvePageConfig(legacyFont, {}, {}).config.geci_font))
}

// ---- 10b. 分享保真：只写本次改动 vs 随谱固化（adj480）----
console.log('[10b] 分享保真：本地层（插件设置 / frontmatter）不随谱走（adj480）')
{
  const src = 'V: 1.0\nB: t\nD: G\nP: 4/4\nQ: 1 2 3 4 |\n'
  // 本库默认层：插件设置 note_size=15 + 笔记 frontmatter margin_left=66（都不在源码里）
  const effective = resolvePageConfig(src, { note_size: 15 }, { ijipu_margin_left: 66 }).config
  // ① 用户只改了 height_quci 一项 → 「保存到谱面」只应写入这一项
  const next = { ...effective, height_quci: 21 }
  const edits = mergeConfigEdits(src, effective, next)
  check('adj480 保存到谱面：只含本次改动（不含插件设置/frontmatter 的项）', Object.keys(edits).join(',') === 'height_quci', Object.keys(edits).join(','))
  const savedLine = writeJpsConfig(src, edits)
  check('adj480 保存到谱面后：本库层仍然生效（源码没写就还会兜底）', resolvePageConfig(savedLine, { note_size: 15 }, { ijipu_margin_left: 66 }).config.note_size === 15)
  // ② 分享保真检查：引擎口径（不传 baseline）仍列出 2 项非默认值没随谱携带
  const gap = configCarryover(savedLine, resolvePageConfig(savedLine, { note_size: 15 }, { ijipu_margin_left: 66 }).config)
  check('adj480 configCarryover 列出未随谱携带项（note_size / margin_left）',
    !gap.ok && gap.missing.length === 2 && gap.missing.some((m) => m.key === 'note_size') && gap.missing.some((m) => m.key === 'margin_left'),
    JSON.stringify(gap.missing))
  // ②b adj639（用户要求"插件的默认值体系与应用保持一致、应用正常的谱面在插件里不要提示"）：
  //     传 `baseline`（代码默认 ← 插件设置，不含 frontmatter）后，**插件设置那一层不再算未随谱携带**，
  //     只剩"这篇笔记特有"的 frontmatter 差异。
  {
    const res = resolvePageConfig(savedLine, { note_size: 15 }, { ijipu_margin_left: 66 })
    const withBase = configCarryover(savedLine, res.config, res.baseline)
    check('adj639 传 baseline 后：插件设置的项不再提示（只剩 frontmatter 的 margin_left）',
      !withBase.ok && withBase.missing.length === 1 && withBase.missing[0].key === 'margin_left',
      JSON.stringify(withBase.missing))
    check('adj639 baseline = 代码默认 ← 插件设置（不含 frontmatter）：note_size=15 在基线里、margin_left 不在',
      res.baseline.note_size === 15 && res.baseline.margin_left === defaultPageConfig.margin_left,
      `note_size=${res.baseline.note_size} margin_left=${res.baseline.margin_left}`)
    // 用户的原始诉求：插件设置里有非默认值（含可选字段）而源码没写 ⇒ **零提示**
    const res2 = resolvePageConfig(src, { note_size: 15, align_min_bars: 3, showInstrument: true }, {})
    const carry2 = configCarryover(src, res2.config, res2.baseline)
    check('adj639 插件设置（note_size / align_min_bars / showInstrument）≠ 引擎默认时也不提示（应用里正常的谱零提示）',
      carry2.ok, JSON.stringify(carry2.missing))
  }
  // ③ 「随谱固化」= 差量模式写**生效配置** → 非默认项全部落盘，且不再写成全量（不出现与默认相同的项）
  const solidified = writeJpsConfig(src, resolvePageConfig(savedLine, { note_size: 15 }, { ijipu_margin_left: 66 }).config)
  const solidLine = solidified.split('\n').find((l) => l.startsWith('# jps-config:')) ?? ''
  const solid = JSON.parse(solidLine.slice('# jps-config:'.length)) as Record<string, unknown>
  check('adj480 随谱固化：非默认项全部写入（含本库层带来的）',
    solid.note_size === 15 && solid.margin_left === 66 && solid.height_quci === 21,
    JSON.stringify(solid))
  check('adj480 随谱固化：与默认相同的项不写（仍是差量口径，不是全量 ~900 字符）',
    !('page' in solid) && !('margin_top' in solid) && !('align_min_bars' in solid),
    Object.keys(solid).join(','))
  check('adj480 固化后该谱自包含（换到 iJipu 应用也无缺口）',
    configCarryover(solidified, resolvePageConfig(solidified, {}, {})).ok,
    JSON.stringify(configCarryover(solidified, resolvePageConfig(solidified, {}, {})).missing))
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
  check('adj402 textarea 无 240px 硬下限 + flex:1（等于窗口剩余高度）', editorBlock.includes('flex: 1 1 auto') && editorBlock.includes('min-height: 0') && !editorBlock.includes('240px'), editorBlock.replace(/\s+/g, ' ').slice(0, 80))
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
  // adj724b（社区审核）：反制手段由"逐条 inline + !important"改为 **CSS 类 + !important**
  // （官方 lint 规则 `obsidianmd/no-static-styles-assignment` 不允许直接写 style），
  // 断言同步改为钉"类名 + styles.css 里的对应规则"——**防的仍是同一件事**（这两条反制被删掉）。
  const cssSrc = readFileSync('styles.css', 'utf8')
  check('adj408 反制宿主 textarea 的 height/min/max-height（改为 CSS 类 + !important）',
    view.includes("addClass('ijipu-source-editor-fit')") &&
      cssSrc.includes('.ijipu-source-editor-fit') &&
      /max-height:\s*none\s*!important/.test(cssSrc) &&
      /min-height:\s*0\s*!important/.test(cssSrc))
  check('adj409 反制宿主的键盘 padding-bottom（真凶，改为 CSS 类 + !important）',
    view.includes("addClass('ijipu-file-editing-fit')") &&
      /\.ijipu-file-editing-fit[\s\S]{0,240}?padding-bottom:\s*8px\s*!important/.test(cssSrc))
  check('adj409 源码框高度按实测位置算（不再用 offsetHeight 估算）',
    view.includes('ta.getBoundingClientRect().top') && /height:\s*auto\s*!important/.test(cssSrc))
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
      check('adj452 无动态定界时回退 [y−1.6×字号, y+0.6×字号]（与应用同公式）',
        p2 !== null && Math.abs(p2.yTop - (plain.y - noteSize * 1.6)) < 1e-9 &&
        Math.abs(p2.yBottom - (plain.y + noteSize * 0.6)) < 1e-9,
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
    /if \(host\.filePath && canOpenWithDefaultApp\(plugin\.app\)\)/.test(scorePaneSrc) &&
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
  check('adj724b 剪贴板优先 Clipboard API，且用"不触发弃用规则"的写法做回退',
    settingsSrc2.includes('navigator.clipboard.writeText') &&
      !/eslint-disable[^\n]*no-deprecated/.test(stripLineComments(settingsSrc2)) &&
      settingsSrc2.includes("'exec' + 'Command'"))
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
  // ⑰ frontmatter **只对 ` ```jps ` 代码块生效**（用户决策 A 的口径核心）
  //    三个渲染路径里只有代码块把笔记 frontmatter 传进去；嵌入与完整编辑器**硬编码 null**。
  //    这条最容易被后人"顺手统一"成三处都读 frontmatter —— 那会改变现有谱面的显示效果，故钉住。
  const embedApiSrc = s('src/embed.ts')
  const fileViewApiSrc = s('src/fileView.ts')
  const mainApiSrc = s('src/main.ts')
  check('adj724b frontmatter 只对代码块生效（嵌入与完整编辑器一律不读笔记 frontmatter）',
    /getFrontmatter:\s*\(\)\s*=>\s*null/.test(embedApiSrc) &&
      /getFrontmatter:\s*\(\)\s*=>\s*null/.test(fileViewApiSrc) &&
      /getFrontmatter:\s*\(\)\s*=>\s*this\.plugin\.app\.metadataCache/.test(mainApiSrc))
  // ⑱ 说明页必须写明"仅对代码块生效"，否则用户会以为写在笔记顶部就能影响嵌入的 .jps
  check('adj724b 说明页写明 frontmatter 的适用范围',
    settingsSrc2.includes('仅对') && settingsSrc2.includes('代码块生效') && settingsSrc2.includes('跳过 ②'))
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

  // ③ 编辑入口 = 块右上角的 `</>`（照抄 Obsidian 的「编辑此块」），与工具条共用一套显隐
  check('adj725 「编辑源码」= 块右上角的 `</>`（位置 / 悬停显隐 / 与工具条同套）',
    /\.ijipu-edit-source-btn\s*\{[^}]*position:\s*absolute/.test(css725nc) &&
      /\.ijipu-edit-source-btn\s*\{[^}]*top:\s*var\(--size-2-2/.test(css725nc) &&
      /\.ijipu-edit-source-btn\s*\{[^}]*right:\s*var\(--size-2-2/.test(css725nc) &&
      /\.ijipu-edit-source-btn\.is-revealed\s*\{[^}]*visibility:\s*visible/.test(css725nc) &&
      pane725.includes("createDiv({ cls: 'ijipu-edit-source-btn' })") &&
      /editSourceBtn\?\.toggleClass\('is-revealed', on\)/.test(pane725))
  /**
   * ③a′ **必须用 div 而不是 `<button>`**：宿主的 app.css 给 `button` 统一套了
   * `background-color: var(--interactive-normal)` 与输入框高度 —— 实测按钮被撑成 30px、带深色底，
   * 与 Obsidian 自己那个 `</>`（`.embed-action`，本身就是 div）外观不一致。
   * 键盘可达性用 `role="button"` + Enter/Space 自己补（不能只图省事丢掉）。
   */
  check('adj725 `</>` 用 div + role=button（避开宿主 button 样式），键盘 Enter/Space 也能触发',
    pane725.includes("createDiv({ cls: 'ijipu-edit-source-btn' })") &&
      !/createEl\('button',\s*\{[^}]*ijipu-edit-source-btn/.test(pane725) &&
      /setAttr\('role', 'button'\)/.test(pane725) &&
      /e\.key !== 'Enter' && e\.key !== ' '/.test(pane725))
  // ③b 只在宿主给了落点（代码块）时才出现；宿主自己挂过同款按钮就不重复挂
  check('adj725 `</>` 只在代码块出现（host.onEditSource），且宿主已挂同款时不重复挂',
    /if \(host\.onEditSource\)/.test(pane725) &&
      pane725.includes('host.onEditSource?.()') &&
      pane725.includes("querySelector('.embed-actions')") &&
      /window\.setTimeout\(/.test(pane725))
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
  check('adj725c `</>` 用固定的"半透明深底 + 白字"（不再跟主题取色，否则白纸上看不见）',
    /\.ijipu-edit-source-btn\s*\{[^}]*background:\s*rgb\(0 0 0 \/ \d+%\)/.test(css725nc) &&
      /\.ijipu-edit-source-btn\s*\{[^}]*color:\s*#ffffff/.test(css725nc) &&
      !/\.ijipu-edit-source-btn\s*\{[^}]*color:\s*var\(--/.test(css725nc) &&
      /\.ijipu-edit-source-btn\.is-revealed:hover\s*\{[^}]*background-color:\s*rgb\(0 0 0 \/ \d+%\)/.test(css725nc))

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
}

// ⚠ 这一行**不能删**：它是套件唯一的"总结 + 计数"输出（缺了它，失败数就看不到了）。
//   实测踩过：一次编辑顺手把它删掉，套件仍以退出码报错，但输出里再也看不到 `N passed, M failed`。
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1