/**
 * newFile.ts — 新建 `.jps` 的两条入口（用户要求）
 *
 * ① **文件列表里文件夹右键菜单** → 「新建 JPS 文件」：在该文件夹内建一份默认模板的 `.jps` 并打开；
 * ② **点击指向不存在的 `.jps` 的内部链接**（`[[谱名.jps]]`）→ 在**链接所在笔记的同级目录**建同名文件
 *    （用户口径："如果文件不存在，应能正确创建 jps 文件，建议默认创建在与链接文件同级的目录下"）。
 *
 * 模板为什么内嵌在这里、而不是读应用仓库的 `ijipu/src/samples/未命名.jps`：
 * 两个仓库各自独立打包（插件产物是单文件 `main.js`），构建期拿不到对方源码。
 * 所以这里留一份**同口径副本**——改模板时两处都要动（应用那份是「新建」模板的唯一出处，
 * 见应用 `src/AGENTS.md` 的 adj481 约定）。
 */
import { Notice, TFolder, type App, type TFile } from 'obsidian'

/** 新建 .jps 的默认模板内容（与应用「新建」模板 `src/samples/未命名.jps` **逐字一致**，含结尾换行） */
export const NEW_JPS_TEMPLATE = `#===========描述头定义===========
V: 1.0
B: 未命名
Z: 佚名 词曲
D: C
P: 4/4
S: 本乐谱使用「爱记谱」编制
#==========以下为简谱主体==========
Q: 1 2 3 4 |
C: 这是歌词




#===以下为页面设置，请勿手动修改===
# jps-config:{}
`

/** 新建文件的默认基名（与应用的「未命名」同口径） */
export const NEW_JPS_BASE = '未命名'
/** 新建文件的扩展名（与 `fileView.ts` 的 `JPS_EXTENSION` 一致） */
export const NEW_JPS_EXT = '.jps'

/**
 * 在同目录**已存在的文件名**里挑一个不冲突的 `未命名[ n].jps`（纯函数，供冒烟断言）。
 *
 * 命名与 Obsidian 自带「新建笔记」同款（`未命名.md` → `未命名 1.md` → `未命名 2.md`）：
 * 取**第一个空位**，而不是"已有数量 + 1"——删掉中间某个之后不会又撞上已占用的名字。
 * 比较按**小写**：Windows / macOS 上 `未命名.JPS` 与 `未命名.jps` 是同一个文件。
 */
export function nextJpsFileName(existing: readonly string[], base = NEW_JPS_BASE): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()))
  const first = `${base}${NEW_JPS_EXT}`
  if (!taken.has(first.toLowerCase())) return first
  for (let i = 1; i < 10000; i++) {
    const name = `${base} ${i}${NEW_JPS_EXT}`
    if (!taken.has(name.toLowerCase())) return name
  }
  // 一万个同名前缀都占满了（实际不可能）：退化成时间戳，绝不覆盖已有文件
  return `${base} ${Date.now()}${NEW_JPS_EXT}`
}

/**
 * `[[…]]` 链接文本 → `.jps` 目标（纯函数）。
 *
 * 处理三种书写：`[[谱名.jps]]`、`[[谱名.jps|别名]]`、`[[谱名.jps#子标题]]`；
 * 不是 `.jps` 结尾（或空）返回 `null` —— 其它扩展名的未解析链接仍归 Obsidian 自己管（会建 `.md`），
 * 插件**不插手**。
 */
export function jpsLinkTarget(href: string): string | null {
  const raw = href.split('|')[0].split('#')[0].trim()
  if (raw === '') return null
  return raw.toLowerCase().endsWith(NEW_JPS_EXT) ? raw : null
}

/**
 * 链接目标 → **库内路径**（纯函数）。
 *
 * - 以 `/` 开头 = 从**库根**起算（`[[/谱库/我的谱.jps]]`）；
 * - 其余 = **相对链接所在笔记的目录**（用户口径："默认创建在与链接文件同级的目录下"）；
 * - `..` 一律拒绝（宁可不建，也不往库外/上级乱写），空路径同样返回 `null`。
 */
export function resolveJpsLinkPath(target: string, sourcePath: string): string | null {
  const clean = target.replace(/\\/g, '/').replace(/^\/+/, '')
  const segs = clean.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.length === 0 || segs.includes('..')) return null
  const rel = segs.join('/')
  if (/^\/+/.test(target.replace(/\\/g, '/'))) return rel
  const src = sourcePath.replace(/\\/g, '/')
  const dir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
  return dir ? `${dir}/${rel}` : rel
}

/**
 * 这次「点击未解析链接」要不要插件接管、要建到哪个路径（**纯函数**，`exists` 由调用方注入）。
 *
 * 返回 `null` = 不接管（不是 `.jps` / 路径不合法 / 文件其实已存在），交给 Obsidian 原本的处理。
 * 之所以要纯函数：点击那一刻必须**同步**判断（先 `preventDefault` 再异步建文件，
 * 否则事件会先冒泡到 Obsidian 的处理器）。
 */
export function planJpsLinkCreate(
  href: string,
  sourcePath: string,
  exists: (path: string) => boolean,
): { path: string } | null {
  const target = jpsLinkTarget(href)
  if (target === null) return null
  const path = resolveJpsLinkPath(target, sourcePath)
  if (path === null || exists(path)) return null
  return { path }
}

/** 逐级补齐父目录（库根起算），已存在的层级跳过 */
async function ensureFolders(app: App, filePath: string): Promise<void> {
  const dirs = filePath.split('/').slice(0, -1)
  let cur = ''
  for (const seg of dirs) {
    cur = cur === '' ? seg : `${cur}/${seg}`
    if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur)
  }
}

/**
 * 按给定**库内路径**落一份默认模板的 `.jps`（父目录缺失会自动补齐）。
 *
 * 失败只弹 `Notice`、返回 `null`——调用方是右键菜单/链接点击的回调，抛出去就成未捕获异常了。
 */
export async function materializeJpsFile(app: App, path: string): Promise<TFile | null> {
  try {
    await ensureFolders(app, path)
    return await app.vault.create(path, NEW_JPS_TEMPLATE)
  } catch (err) {
    new Notice(`新建 JPS 文件失败：${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * 在指定文件夹里新建一个 `.jps`（默认模板内容）并打开 —— 文件夹右键菜单用。
 */
export async function createJpsFile(app: App, folder: TFolder): Promise<void> {
  const name = nextJpsFileName(folder.children.map((c) => c.name))
  // 库根目录的 `path` 是 `/`，此时不要再拼一次分隔符
  const path = folder.path === '/' || folder.path === '' ? name : `${folder.path}/${name}`
  const file = await materializeJpsFile(app, path)
  if (file) await app.workspace.getLeaf(false).openFile(file)
}

/** 链接所在笔记的目录（`a/b/笔记.md` → `a/b`；库根笔记 → `''`） */
export function dirOfPath(sourcePath: string): string {
  const src = sourcePath.replace(/\\/g, '/')
  return src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
}

/**
 * 「新建的 `.jps` 放哪个文件夹」——**链接所在笔记的同级目录**（用户口径），
 * 取不到就退回库根（绝不返回 null，Obsidian 的创建器要求给一个 TFolder）。
 */
export function jpsParentFolder(app: App, sourcePath: string): TFolder {
  const dir = dirOfPath(sourcePath)
  const folder = dir === '' ? app.vault.getRoot() : app.vault.getAbstractFileByPath(dir)
  return folder instanceof TFolder ? folder : app.vault.getRoot()
}

/**
 * Obsidian 自己的「未解析链接 → 建新文件」路径（`Workspace.openLinkText` → `fileManager.createNewFile`）
 * 里，**扩展名必须已在 `fileParentCreatorByType` 注册**，否则会**回退成 `md`**
 * ⇒ `[[谱名.jps]]` 被建成 `谱名.jps.md`（用户报的问题）。
 *
 * 所以给 `jps` 注册一个"父目录创建器"：Obsidian 从此把链接建成**真正的 `谱名.jps`**，
 * 且落在我们指定的目录（链接所在笔记的同级目录）。
 *
 * 两点说明：
 * ① `registerFileParentCreator` 是 Obsidian 的**内部 API**（公开 typings 里只有 `getNewFileParent`），
 *    所以先探测、再调用；探测不到也不影响主路径（下面那条"点击接管"会自己建带模板的文件）。
 * ② 这条路径建出来是**空文件**（Obsidian 的 `createNewFile` 不带内容）⇒ 记一个待补标记，
 *    建完由 `vault.on('create')` 补上默认模板（见 `consumeJpsLinkCreate`）。
 */
export function registerJpsFileCreator(app: App): void {
  const fm = app.fileManager as unknown as {
    registerFileParentCreator?: (ext: string, fn: (sourcePath: string) => TFolder) => void
  }
  if (typeof fm.registerFileParentCreator !== 'function') return
  fm.registerFileParentCreator(NEW_JPS_EXT.slice(1), (sourcePath: string) => {
    pendingLinkCreate = true
    return jpsParentFolder(app, sourcePath)
  })
}

/** 卸载时撤销注册（`Plugin.register` 里调） */
export function unregisterJpsFileCreator(app: App): void {
  const fm = app.fileManager as unknown as { unregisterFileCreator?: (ext: string) => void }
  if (typeof fm.unregisterFileCreator === 'function') fm.unregisterFileCreator(NEW_JPS_EXT.slice(1))
}

/**
 * 「Obsidian 刚通过链接建了一个 `.jps`（内容为空）」的待补标记——只对**我们自己注册的创建器**
 * 触发的创建生效，避免把别的途径（同步/外部工具）落进来的空 `.jps` 也改写掉。
 */
let pendingLinkCreate = false

/** 创建器被调用时打标记（`vault.on('create')` 里消费） */
export function markJpsLinkCreate(): void {
  pendingLinkCreate = true
}

/** 消费标记：`true` = 这次创建来自 Obsidian 的「链接 → 新文件」路径，该补模板 */
export function consumeJpsLinkCreate(): boolean {
  const v = pendingLinkCreate
  pendingLinkCreate = false
  return v
}
