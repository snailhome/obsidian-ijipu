/**
 * scripts/release-body.mjs — 生成 GitHub Release 正文（**只含当前版本**的更新内容）
 *
 * 背景：`docs/RELEASE-NOTES.md` 是**累积**文件（每发一版在最上面加一节，保留历史便于查阅）。
 * 此前工作流直接 `body_path: docs/RELEASE-NOTES.md`，于是每次 Release 正文都带上之前所有版本的
 * 记录（用户反馈"每个版本都包含它之前更新的所有内容"）。
 *
 * 现在：按 `manifest.json` 的 version 从 RELEASE-NOTES 中截取**该版本那一节**（从含版本号的 H1
 * 到下一个 H1 之前），写入 `release-body.md` 供工作流当作 `body_path`。
 * 找不到对应小节时退化为"取第一节"并在日志里明确警告（不让 CI 因格式笔误直接失败）。
 *
 * 用法：node scripts/release-body.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'))
const version = String(manifest.version ?? '').trim()
if (!version) {
  console.error('[release-body] manifest.json 缺少 version')
  process.exit(1)
}

const NOTES = 'docs/RELEASE-NOTES.md'
const OUT = 'release-body.md'
const lines = readFileSync(NOTES, 'utf8').replace(/\r\n/g, '\n').split('\n')
const isH1 = (l) => /^#\s+/.test(l)

const start = lines.findIndex((l) => isH1(l) && l.includes(version))
let from = start
if (start < 0) {
  from = lines.findIndex(isH1)
  console.warn(
    `[release-body] ⚠ 未在 ${NOTES} 找到版本 ${version} 的小节（应形如 "# 爱记谱 iJipu ${version}"）` +
      `——退化为取第一节（${lines[from] ?? '（空文件）'}）`,
  )
} else {
  console.log(`[release-body] 命中版本小节：${lines[start]}`)
}

const nextH1 = lines.findIndex((l, i) => i > from && isH1(l))
const body = lines.slice(from, nextH1 < 0 ? lines.length : nextH1).join('\n').trim()

writeFileSync(OUT, `${body}\n`, 'utf8')
const versionLines = body.split('\n').length
console.log(`[release-body] 已写 ${OUT}：${versionLines} 行（整份 ${NOTES} 共 ${lines.length} 行，只取当版）`)
