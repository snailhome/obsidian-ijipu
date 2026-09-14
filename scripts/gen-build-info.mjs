/**
 * scripts/gen-build-info.mjs — 生成插件构建信息（src/gen/buildInfo.ts，已 gitignore）
 *
 * 为什么需要（adj407，用户要求）：插件此前只显示 manifest 里的版本号，而**同一版本号会有多个本地构建**
 * （反复修同一个问题时尤其明显），用户无法判断手机上装的到底是哪一份、也让我无法确认真机复测的对象。
 * 现在设置页显示「版本 vX.Y.Z · 构建 日期 时间 @commit」，一目了然。
 *
 * 与 ijipu 应用同款做法：读 .git/HEAD 与 refs 文件（**不 spawn 子进程**，沙箱兼容）；
 * 由 npm run build / smoke 前置执行（见 package.json 的 gen:info）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

let commit = 'dev'
try {
  const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim()
  if (head.startsWith('ref:')) {
    const ref = head.split(' ')[1].trim()
    commit = readFileSync(join(root, '.git', ref), 'utf8').trim().slice(0, 8)
  } else {
    commit = head.slice(0, 8)
  }
} catch {
  /* 无 git 环境回退 dev */
}

const out = `// 由 scripts/gen-build-info.mjs 自动生成（勿手改）
export const BUILD_STAMP = '${stamp}'
export const GIT_COMMIT = '${commit}'
`
mkdirSync(join(root, 'src', 'gen'), { recursive: true })
writeFileSync(join(root, 'src', 'gen', 'buildInfo.ts'), out)
console.log(`build info: ${stamp} @${commit}`)
