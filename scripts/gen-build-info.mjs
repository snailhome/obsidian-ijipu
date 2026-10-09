/**
 * scripts/gen-build-info.mjs — 生成插件构建信息（src/gen/buildInfo.ts，已 gitignore）
 *
 * 为什么需要（adj407，用户要求）：插件此前只显示 manifest 里的版本号，而**同一版本号会有多个本地构建**
 * （反复修同一个问题时尤其明显），用户无法判断手机上装的到底是哪一份、也让我无法确认真机复测的对象。
 * 现在设置页显示「版本 vX.Y.Z · 构建 日期 时间 @commit」，一目了然。
 *
 * 与 ijipu 应用同款做法：读 .git/HEAD 与 refs 文件（**不 spawn 子进程**，沙箱兼容）；
 * 由 npm run build / smoke 前置执行（见 package.json 的 gen:info）。
 *
 * adj724b（社区审核"构建产物与 Release 产物不一致"）：
 * 时间戳改为**取该提交自身的时间**（从 git 对象里解出来），而**不是"打包那一刻"**。
 * 原因：后者让同一份源码在每次构建都产出不同字节 ⇒ 审核方重新构建永远对不上 Release 附件；
 * 前者让构建**可复现**（同 commit ⇒ 同产物），同时仍能区分不同提交的构建。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pad = (n) => String(n).padStart(2, '0')

/** 读 .git/HEAD 得到完整 commit（不 spawn 子进程） */
function readCommitSha() {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) {
      const ref = head.split(' ')[1].trim()
      return readFileSync(join(root, '.git', ref), 'utf8').trim()
    }
    return head
  } catch {
    return null
  }
}

/**
 * 从 git 对象里取出该提交的时间（committer 那行）。
 * 对象是 zlib 压缩的 `<type> <size>\0<content>`，其中 `committer ... <ts> <tz>` 的 ts 是秒级 Unix 时间。
 */
function commitTime(sha) {
  if (!sha) return null
  try {
    const objPath = join(root, '.git', 'objects', sha.slice(0, 2), sha.slice(2))
    if (!existsSync(objPath)) return null // packfile 里（clone 场景）时取不到，退回当前时间
    const raw = inflateSync(readFileSync(objPath)).toString('utf8')
    const m = /^committer .*? (\d+) [+-]\d{4}$/m.exec(raw)
    if (!m) return null
    return new Date(Number(m[1]) * 1000)
  } catch {
    return null
  }
}

const sha = readCommitSha()
const when = commitTime(sha) ?? new Date()
const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
const stamp = `${date} ${pad(when.getHours())}:${pad(when.getMinutes())}`
const commit = sha ? sha.slice(0, 8) : 'dev'

const out = `// 由 scripts/gen-build-info.mjs 自动生成（勿手改）
export const BUILD_STAMP = '${stamp}'
/**
 * 只有日期（adj739）：设置页头部按应用的格式显示 \`vX.Y.Z (日期 @commit)\` ——
 * 与 ijipu 的 \`APP_VERSION_FULL\`（\`v\${APP_VERSION} (\${BUILD_DATE} @\${GIT_COMMIT})\`）逐字对齐，
 * 这样"插件版本"和"应用版本"两条信息看起来是同一套东西。
 */
export const BUILD_DATE = '${date}'
export const GIT_COMMIT = '${commit}'
`
mkdirSync(join(root, 'src', 'gen'), { recursive: true })
writeFileSync(join(root, 'src', 'gen', 'buildInfo.ts'), out)
console.log(`build info: ${stamp} @${commit}${commitTime(sha) ? '（提交时间，可复现）' : '（当前时间，未能读取提交对象）'}`)
