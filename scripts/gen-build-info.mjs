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
 *
 * adj772（社区审核的 Build verification **仍然报不一致** ⇒ 实测抓到真因）：
 * 上面那步只解决"同机器可复现"，**跨时区仍不可复现** —— 原来用 `getHours()/getDate()` 等**本地时区**取值，
 * 于是同一提交在 CST 构建得 `13:34`、在 CI（UTC）构建得 `05:34` ⇒ 字节不同（本轮逐字节比对确认：
 * 两个产物**只差这一个字符串**，长度完全一样）。现改为**一律按 UTC**格式化 ⇒ 任何时区构建结果相同。
 * （同一改动同步到应用侧 `ijipu/scripts/gen-build-info.mjs`，否则嵌入产物里的 `BUILD_DATE` 同样会跨时区漂移。）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
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
 *
 * adj772（第二次抓因）：**CI 里读不到松散对象**（`actions/checkout` 是打包克隆 ⇒ 对象在 packfile 里），
 * 于是旧写法回退到 `new Date()` = **构建时刻** ⇒ 同提交在 CI 与本地必然不同（实测戳 `05:58` vs `05:57`）。
 * 现在补一条**兜底路径**：读不到松散对象时，用 `git log -1 --format=%cI HEAD` 取**同一个提交时间**
 * （CI 里 git 可用；本地沙箱若禁用子进程则自然走上面那条），两条路径给出**同一个值** ⇒ 真正可复现。
 * 两条都失败时**不写时间**（返回 null ⇒ 上层用"无时间戳"形态），绝不回退到"当前时间"。
 */
function commitTime(sha) {
  if (!sha) return null
  try {
    const objPath = join(root, '.git', 'objects', sha.slice(0, 2), sha.slice(2))
    if (existsSync(objPath)) {
      const raw = inflateSync(readFileSync(objPath)).toString('utf8')
      const m = /^committer .*? (\d+) [+-]\d{4}$/m.exec(raw)
      if (m) return new Date(Number(m[1]) * 1000)
    }
  } catch {
    /* 落到下面的 git 兜底 */
  }
  try {
    // 打包克隆（CI）场景：用 git 自己解包取同一个提交时间（结果与上面一致）
    const out = execFileSync('git', ['log', '-1', '--format=%ct', sha], { cwd: root, encoding: 'utf8' }).trim()
    const ts = Number(out)
    if (Number.isFinite(ts) && ts > 0) return new Date(ts * 1000)
  } catch {
    /* 两条都失败 ⇒ 不写时间 */
  }
  return null
}

const sha = readCommitSha()
/** adj772：提交时间取不到时**不写时间**（确定性优先）——绝不回退"构建时刻"，否则审核方重建必然对不上 */
const when = commitTime(sha)
/** adj772：一律 **UTC** 取值 —— 跨时区可复现构建（此前本地时区导致 CI 与本地产物不一致） */
const date = when ? `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}` : '未知日期'
const stamp = when ? `${date} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}` : `${date}（提交时间不可读）`
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
