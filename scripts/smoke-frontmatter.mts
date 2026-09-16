/**
 * scripts/smoke-frontmatter.mts — 笔记 frontmatter（ijipu_*）→ PageConfig 的纯逻辑断言
 *
 * 运行：npm run smoke（esbuild 打包到 dist-smoke/ 后 node 执行）
 * 断言来源：用户反馈「在 frontmatter 里设置像 `ijipu_note_size` 好像没生效」——
 * 覆盖键名写法兼容、值类型转换、未识别键提示、优先级四类。
 */
import { defaultPageConfig, dragDelta, layoutScore, parseJps, writeJpsConfig, SCORE_FONT_OPTIONS, buildPlaySequence } from '@ijipu/engine'
import { readFileSync } from 'node:fs'
import { instrumentColorMap, playheadBaseOf, playheadPosIn, trackKeysOf } from '../src/playhead'
import { applyFrontmatter, deprecatedKeyHint, frontmatterKey, mergePageConfig, unknownKeyHint, PAGE_CONFIG_FIELDS } from '../src/frontmatter'
import { resolvePageConfig } from '../src/config'
import { codeBlockBody, jpsLinkpath, replaceCodeBlockBody } from '../src/sourceEdit'
import { computeGuideLines, cropRectFor, guideLimits, guidePlacement } from '../src/guides'
import { splitParseIssues } from '../src/parseIssues'

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
  check(`字段表字段数 = 33（引擎 35 字段去掉编辑器偏好 2 项；adj428 新增 segmentRowGap）`, PAGE_CONFIG_FIELDS.length === 33, String(PAGE_CONFIG_FIELDS.length))
  check('字段表无重复（规范化后不冲突）', new Set(PAGE_CONFIG_FIELDS.map((f) => f.replace(/[^a-z0-9]/gi, '').toLowerCase())).size === PAGE_CONFIG_FIELDS.length)
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
    crossLine.warnings.every((w) => !!w.hint && w.hint.includes('同一行')),
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
  check('adj404 必要时解除 .app-container 上限并还原（不留副作用）', view.includes("style.maxHeight = 'none'") && view.includes('teardownHeightFit') && view.includes('Platform.isMobile'))
  // adj407：设置页显示「构建 日期 时间 @commit」——同一版本号会有多个本地构建，没有指纹就无法判断
  // 手机上装的到底是哪一份（复测时反复踩过）。这条断言防的是"以后有人把指纹去掉"。
  const settingsSrc = readFileSync('src/settings.ts', 'utf8')
  const pkgJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
  check('adj407 设置页显示构建指纹（日期 时间 + commit）', settingsSrc.includes('BUILD_STAMP') && settingsSrc.includes('GIT_COMMIT') && settingsSrc.includes('构建 '))
  check('adj407 build/smoke 前置生成构建信息（gen:info → src/gen/buildInfo.ts，已 gitignore）', (pkgJson.scripts?.build ?? '').includes('gen:info') && (pkgJson.scripts?.smoke ?? '').includes('gen:info') && readFileSync('.gitignore', 'utf8').includes('src/gen/'))
  // adj408/adj409：真机上"源码框少一个键盘高"的两条真凶（都在宿主的样式里，且都用 inline+important 反制）——
  // ① 宿主 textarea 的 height/min-height/max-height；② `.view-content` 的 padding-bottom = 键盘高。
  // 这两条最容易被人"顺手简化"掉，而回归只在真机上暴露，故用断言钉住。
  check('adj408 反制宿主 textarea 的 height/min/max-height', view.includes("setProperty('max-height', 'none', 'important')") && view.includes("setProperty('min-height', '0', 'important')") && readFileSync('styles.css', 'utf8').includes('max-height: none'))
  check('adj409 反制宿主的键盘 padding-bottom（真凶）', view.includes("setProperty('padding-bottom', '8px', 'important')"))
  check('adj409 源码框高度按实测位置算（不再用 offsetHeight 估算）', view.includes("ta.getBoundingClientRect().top") && view.includes("setProperty('height', 'auto', 'important')"))
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
  // ④ 默认值 = 自动（settings.hqVoice 未设置 → null → 声部路由），且设置项说明覆盖关系
  check('adj450 默认音色未设置时为「自动」（render 传 null）', renderSrc.includes('opts?.hqVoice ?? null'))
  check('adj450 设置项说明写明「选具体音色会覆盖谱面 Y:」',
    settingsSrcSb.includes('覆盖谱面里的 Y:'))
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
    const keyMain = gD.find(([k]) => k.endsWith('|main'))
    const keySecond = gD.find(([k]) => k.endsWith('|second'))
    check('adj452 dsb 同一曲行上下两层各成一组（playVoice 进键；段外主旋律另算一组）',
      keyMain !== undefined && keySecond !== undefined,
      `键=${gD.map(([k]) => k).join(' / ')}`)
    if (keyMain && keySecond) {
      const ns = layoutD.config.note_size
      // dsb 段从第 3 拍起（前面是 `3 4`），故用各层首个拍段的时刻查询
      const a = playheadPosIn(keyMain[1], keyMain[1][0].atMs + 1, 0, ns)
      const b = playheadPosIn(keySecond[1], keySecond[1][0].atMs + 1, 0, ns)
      check('adj452 dsb 上（主声部）下（第二声部）色块纵向不重叠、各用各自定界',
        a !== null && b !== null && (a.yBottom <= b.yTop + 0.01 || b.yBottom <= a.yTop + 0.01),
        a && b ? `[${a.yTop},${a.yBottom}] vs [${b.yTop},${b.yBottom}]` : 'null')
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
