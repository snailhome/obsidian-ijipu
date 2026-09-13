/**
 * scripts/release-body.mjs — 生成 GitHub Release 正文（**只含指定版本/当前版本**的更新内容）
 *
 * 背景：`docs/RELEASE-NOTES.md` 是**累积**文件（每发一版在最上面加一节，保留历史便于查阅），
 * 历史版本已陆续移到 `docs/RELEASE-NOTES-ARCHIVE.md`。此前工作流直接 `body_path: docs/RELEASE-NOTES.md`，
 * 于是每次 Release 正文都带上之前所有版本的记录（用户反馈"每个版本都包含它之前更新的所有内容"）。
 *
 * 现在：按版本号从两份笔记里截取**该版本那一节**（从含版本号的 H1 到下一个 H1 之前，去掉尾部分隔线 `---`），
 * 写入 `release-body.md` 供工作流当作 `body_path`。
 * 找不到对应小节时退化为"取第一节"并在日志里明确警告（不让 CI 因格式笔误直接失败）。
 *
 * 用法：
 *   node scripts/release-body.mjs            # 取 manifest.json 的当前版本
 *   node scripts/release-body.mjs 0.3.7      # 取指定版本（补历史 Release 正文用）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'))
const version = String(process.argv[2] ?? manifest.version ?? '').trim()
if (!version) {
  console.error('[release-body] manifest.json 缺少 version，且未在命令行给出版本号')
  process.exit(1)
}

const SOURCES = ['docs/RELEASE-NOTES.md', 'docs/RELEASE-NOTES-ARCHIVE.md'].filter((f) => existsSync(f))
const OUT = 'release-body.md'
const isH1 = (l) => /^#\s+/.test(l)
// 版本号用"边界匹配"而不是 includes：否则版本 0.4.10 会先命中标题里的 0.4.1
const versionRe = new RegExp(`(^|[^0-9.])${version.replace(/\./g, '\\.')}([^0-9.]|$)`)

let src = ''
let from = -1
let lines = []
for (const file of SOURCES) {
  const ls = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
  const start = ls.findIndex((l) => isH1(l) && versionRe.test(l))
  if (start >= 0) {
    src = file
    lines = ls
    from = start
    break
  }
}
if (from < 0) {
  src = SOURCES[0]
  lines = readFileSync(src, 'utf8').replace(/\r\n/g, '\n').split('\n')
  from = lines.findIndex(isH1)
  console.warn(
    `[release-body] ⚠ 未在 ${SOURCES.join(' / ')} 找到版本 ${version} 的小节（应形如 "# 爱记谱 iJipu ${version}"）` +
      `——退化为取第一节（${lines[from] ?? '（空文件）'}）`,
  )
} else {
  console.log(`[release-body] 命中版本小节：${lines[from]}（来源 ${src}）`)
}

const nextH1 = lines.findIndex((l, i) => i > from && isH1(l))
const body = lines
  .slice(from, nextH1 < 0 ? lines.length : nextH1)
  .join('\n')
  .trim()
  .replace(/\n---\s*$/, '') // 归档文件里各节之间用 --- 分隔，正文不需要

writeFileSync(OUT, `${body}\n`, 'utf8')
console.log(`[release-body] 已写 ${OUT}：${body.split('\n').length} 行（来源 ${src}，只取该版本）`)
