/**
 * scripts/smoke-frontmatter.mts — 笔记 frontmatter（ijipu_*）→ PageConfig 的纯逻辑断言
 *
 * 运行：npm run smoke（esbuild 打包到 dist-smoke/ 后 node 执行）
 * 断言来源：用户反馈「在 frontmatter 里设置像 `ijipu_note_size` 好像没生效」——
 * 覆盖键名写法兼容、值类型转换、未识别键提示、优先级四类。
 */
import { defaultPageConfig, dragDelta, layoutScore, parseJps, writeJpsConfig, SCORE_FONT_OPTIONS } from '@ijipu/engine'
import { applyFrontmatter, deprecatedKeyHint, frontmatterKey, mergePageConfig, unknownKeyHint, PAGE_CONFIG_FIELDS } from '../src/frontmatter'
import { resolvePageConfig } from '../src/config'
import { codeBlockBody, jpsLinkpath, replaceCodeBlockBody } from '../src/sourceEdit'
import { computeGuideLines, cropRectFor, guideLimits, guidePlacement } from '../src/guides'

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
  check(`字段表字段数 = 32（引擎 34 字段去掉编辑器偏好 2 项）`, PAGE_CONFIG_FIELDS.length === 32, String(PAGE_CONFIG_FIELDS.length))
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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
