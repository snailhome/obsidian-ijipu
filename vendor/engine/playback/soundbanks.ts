/**
 * engine/playback/soundbanks.ts — 高保真音源（SF2/SF3/DLS）的**库清单与取用策略**（纯逻辑，零 DOM）
 *
 * 用户 2026-10 要求：「预览渲染、播放及色块显示、源码格式化、源码高亮、错误信息显示提示等共性的功能
 * 都可以独立到引擎层面」，且「应用端也应同样处理」。音源这块的**共性**是两件事：
 *  ① **库清单**（id/名称/直链/回退链/大小/格式/落地页）—— 应用与插件此前各存一份，加库要改两处；
 *  ② **取用顺序**（内置/插件目录文件 → 本机缓存 → 联网下载）—— 用户明确交代过
 *     「**音源默认走插件目录里的文件**」，两端顺序必须一致，否则同一台机器上两个宿主行为不同。
 *
 * 引擎只表达**策略**（`planHqBankLoad` 返回"该用哪一级"），**IO 留宿主**：
 * 应用是 Tauri 资源 + 浏览器 IndexedDB；插件是 `vault.adapter` 文件 + IndexedDB。
 */
export interface HqSampleLibrary {
  id: string
  name: string
  /** 联网直链（宿主无内置/本地文件时用）；
   *  adj1009：**空串 = 本库没有可靠的直链**（见 `autoDownload`）——`loadHqBank` 会直接给"手动导入"提示，
   *  绝不拿空串去 `fetch`（那会请求当前页面 URL，属于"看起来在下载"的假动作）。 */
  source: string
  /** 本地内置缺失时回退的联网直链（可选） */
  fallbackSource?: string
  sizeBytes: number
  format: 'sf2' | 'sf3' | 'dls'
  /**
   * adj728：**让用户自己去拿这个文件的落地页**（浏览器里打开的那个页面）。
   *
   * 为什么单列"页面"而不只给 `source` 直链：实测（2026-10）默认音源直链（32.3 MB）在部分网络
   * **连不上**，jsDelivr 又因单文件 20 MB 上限直接 403 ⇒ 自动下载必然失败。这时唯一可行的路子是
   * 用户自己下载后再"导入音色文件"——所以界面要给"打开下载页"按钮 + 照做引导。
   */
  downloadPage?: string
  /**
   * adj1009：**按库名（SF2 的 INAM）认领**这个库用的正则源串（大小写不敏感）。
   *
   * 导入 `.sf2` 时先用它比对文件里的库名：命中 ⇒ 归到这个 id（同一库的不同版本也合并），
   * 未命中 ⇒ 生成 `imported_<hash>` 新条目。**不按文件名认**，因为文件名不可信。
   */
  sf2NamePattern?: string
  /**
   * adj1009：**是否允许应用内自动联网下载**（缺省 = 允许）。
   *
   * `false` 的两种真实情况：① 直链根本拿不到字节（如 FluidR3 的 SourceForge 下载页返回 HTML
   * 且无 CORS 头）；② 文件大到"点一下自动下"体验注定很差。这类库只给 `[打开下载页]`，
   * **不给点了必然失败的按钮**。
   */
  autoDownload?: boolean
  /** adj1009：许可（界面如实展示；不同库差别很大，GeneralUser 是自定义许可、FluidR3 是 MIT） */
  license?: string
  /** adj1009：已知库的**实测**预设条数（导入后由 `sf2.ts` 解析真实文件覆盖，这里只用于列表先显示） */
  presetCount?: number
  /**
   * adj1016：**推荐理由**（一句话，用户判断"要不要下它"时真正看的是这一条）。
   * 只有带 `reason` 的库才进「推荐」区；理由必须写**可核实的事实**（体积/音色数/加载快慢/许可），
   * 不写"音质最好"这种没有依据的话。
   */
  reason?: string
}

/** 可切换的高质量音源库列表（加库只需追加一条元数据；两端共用） */
export const HQ_LIBRARIES: HqSampleLibrary[] = [
  {
    id: 'generaluser_gs',
    name: '通用音源（GeneralUser GS）',
    // adj346：SF2 不打包进 Web 产物（规避单文件 25MB 限制），改为远端加载；桌面端由宿主的
    // 内置资源/插件目录文件满足，不走此 source。
    source: 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2',
    fallbackSource: '',
    sizeBytes: 32_319_396,
    format: 'sf2',
    // adj728：用户手动下载的落地页（页面里能直接下到 GeneralUser-GS.sf2）
    downloadPage: 'https://github.com/mrbumpy409/GeneralUser-GS',
    // adj1009：库名（INAM）实测为 `GeneralUser GS 2.0.3 BETA`；v1.471 等老版本也归到同一个库
    sf2NamePattern: 'generaluser',
    license: 'GeneralUser GS License v2.0',
    presetCount: 287,
    reason: '体积适中（32 MB），128 个主音色 + 159 个变体/鼓组；下载一次后离线可用（桌面端可直接下）',
  },
  {
    /**
     * adj1009（用户 2026-10-21 定）：FluidR3 GM —— **不内置、不自动下载**，只给下载页。
     *
     * 为什么 `source` 留空：用户给的是 SourceForge（PianoBooster 1.0.0）的 `/download` 页，
     * 实测它返回的是 126 KB 的 **HTML 页面**（`text/html`），不是文件流；三个相关域名
     * （`sourceforge.net` / `downloads.sourceforge.net` / `master.dl.sourceforge.net`）都
     * **没有 `Access-Control-Allow-Origin`** ⇒ 浏览器里 `fetch()` 必然被 CORS 拦死。
     * 所以只能"打开下载页 → 用户自己下 → 回来导入"。
     */
    id: 'fluidr3_gm',
    name: 'Fluid R3 GM',
    source: '',
    sizeBytes: 148_398_306,
    format: 'sf2',
    downloadPage:
      'https://sourceforge.net/projects/pianobooster/files/pianobooster/1.0.0/FluidR3_GM.sf2/download',
    sf2NamePattern: 'fluid\\s*r3',
    autoDownload: false,
    license: 'MIT',
    presetCount: 189,
    reason: '采样更厚、听感偏"录音室"；体积 141 MB，首次加载明显更慢（低配机器慎选）',
  },
]

/**
 * adj1016：**推荐清单**（只含带 `reason` 的已知库）。
 *
 * 为什么单独导出一个数组：界面上的"推荐"必须和"已安装的库"分开——前者是"你还没有、可以考虑"，
 * 后者是"你已经有、能用"。两者混在一格里，用户分不清"该不该点下载"。
 *
 * adj1023（用户口径「少即是多」）：**应用里不再摆这张清单**（介绍/评价放官网），
 * 应用只用 `BASE_BANK` 这一个"必须有的基础库"做空状态的第一动作。
 */
export const RECOMMENDED_BANKS: HqSampleLibrary[] = HQ_LIBRARIES.filter((l) => !!l.reason)

/**
 * adj1023：**基础音色库**——保证"装好就有一个能出声"的那一个（清单第一条）。
 * 应用里只在"一个库都没有"时出现一个「下载基础音色库」按钮，不做成推荐列表。
 */
export const BASE_BANK: HqSampleLibrary = HQ_LIBRARIES[0]

/**
 * 按 id 查已知库（**找不到返回 `undefined`，不再默默回退默认库**，adj1009）。
 *
 * 为什么不再"回退第一个"：`getHqLibrary(id)` 的旧语义会把"库 id 写错/库被删了"静默变成
 * "用默认库"——用户看到的现象就是"我明明选了另一个库，怎么还是 GeneralUser"。
 * 现在由调用方显式决定回退（并说清回退原因），这条 bug 才不会再复发。
 */
export function findKnownLibrary(id?: string | null): HqSampleLibrary | undefined {
  if (!id) return undefined
  const key = id.trim()
  if (key === '') return undefined
  return HQ_LIBRARIES.find((l) => l.id === key)
}

/**
 * 按 id 查音源库（找不到回退第一个 = 默认库）。
 *
 * @deprecated adj1009：**渐进迁移用**。新代码请用 `findKnownLibrary`（找不到返回 `undefined`，
 * 由调用方决定是否回退）。本函数保留到应用侧所有取用点都改完（Phase 3）再删。
 */
export function getHqLibrary(id?: string | null): HqSampleLibrary {
  return findKnownLibrary(id) ?? HQ_LIBRARIES[0]
}

/** 当前生效的音色库（L1 偏好里的 id → 具体的库条目） */
export interface ActiveLibrary {
  lib: HqSampleLibrary
  /**
   * `true` = 用户选的那个 id **不存在**（库被删了 / 换了台机器 / 偏好串写坏），
   * 已经回退到默认库。界面/提示要如实说一句，否则又回到"选了 A 却在用 B"的老毛病。
   */
  fallback: boolean
}

/**
 * adj1011：**"当前用哪个库"的唯一判据**（试听 / 导出 / 音色库面板共用这一份）。
 *
 * 三种情形分得很清楚，不许再各自 `?? 默认库`：
 *  · 空 id（从没选过）⇒ 默认库，`fallback:false`（这是正常初始态，不是"回退"）；
 *  · id 命中 ⇒ 那个库；
 *  · id 有值但查不到 ⇒ 默认库 + `fallback:true`（**要告知用户**：你选的库不在了）。
 */
export function resolveActiveLibrary(
  id?: string | null,
  libs: readonly HqSampleLibrary[] = HQ_LIBRARIES,
): ActiveLibrary {
  const key = (id ?? '').trim()
  if (key === '') return { lib: libs[0], fallback: false }
  const found = libs.find((l) => l.id === key)
  return found ? { lib: found, fallback: false } : { lib: libs[0], fallback: true }
}

/** 音源取用的**层级**（各宿主按自己的实际情况映射；顺序由 `planHqBankLoad` 统一决定） */
export type HqBankSource = 'host' | 'userFile' | 'cache' | 'builtin' | 'download'

/**
 * **取用顺序策略（唯一口径）**：宿主直供 → **用户自己的文件** → 本机缓存 → 宿主内置资源 → 联网下载。
 *
 * 为什么这样分层而不是简单的"文件 → 缓存"：**"用户导入的音源"在两个宿主里落点不同** ——
 *  · Obsidian 插件：导入即写**插件目录文件**（随文库走）⇒ `userFile` ✓，缓存只是迁移遗留；
 *  · iJipu 应用：导入写的是 IndexedDB ⇒ 那是 `cache` ✓，而 `builtin` 是随包内置的默认音源。
 * 若强行让两端用同一个"文件优先"，应用侧就会**忽略用户自己导入的音色**（回归）。
 * 于是引擎按**层级语义**定序、宿主各自映射：插件传 `{userFile, cache}`、应用传 `{cache, builtin}`，
 * 两边都得到"用户的东西优先、其次内置、最后联网"的结果 ✓。
 */
export function planHqBankLoad(
  available: Partial<Record<Exclude<HqBankSource, 'download'>, boolean>>,
): HqBankSource {
  if (available.host) return 'host'
  if (available.userFile) return 'userFile'
  if (available.cache) return 'cache'
  if (available.builtin) return 'builtin'
  return 'download'
}

/**
 * 自动下载失败时给用户的**可照做**提示（两端同一份措辞）。
 *
 * 为什么强调"不是你的网络差"：实测最常见的失败是**该直链在用户所在网络不可达**，
 * 笼统说"请检查网络"会把用户引到错误方向（adj728 的由来）。
 * @param detail 宿主捕获到的技术细节（可选，附在最后）
 */
export function hqBankFailureText(lib: HqSampleLibrary, detail?: string): string {
  return (
    `音源「${lib.name}」自动下载失败（约 ${(lib.sizeBytes / 1_000_000).toFixed(1)} MB）。` +
    `这通常是**该下载地址在你所在网络不可达**，而不是你网络差——` +
    `可以手动导入一次（**导入后会持久缓存，之后不再联网**）：` +
    `在「设置 → 音色库」点「导入音色文件…」选择本地的 .sf2 文件即可` +
    (lib.downloadPage ? `；还没有这个文件的话，先点那里的「打开下载页」自己下一个。` : `。`) +
    (detail ? `\n技术细节：${detail}` : '')
  )
}

/**
 * adj1009：**本库只能手动下载**时的提示（`autoDownload === false` 或没有直链）。
 *
 * 为什么不能复用 `hqBankFailureText`：那句说的是"自动下载**失败**"，会让人以为"再试一次可能成"，
 * 而这里的事实是"我们**没有**能让它自动下载的地址"（如 FluidR3：源站返回 HTML 且无 CORS 头）。
 * 两句混用会把用户引向反复重试。
 */
export function hqBankManualOnlyText(lib: HqSampleLibrary): string {
  const size = `${(lib.sizeBytes / 1_000_000).toFixed(1)} MB`
  const tail = lib.downloadPage
    ? `请点「打开下载页」自己下一个（约 ${size}），再回到「设置 → 音色库」点「导入音色文件」选它。`
    : `请先下载它的 .sf2 文件（约 ${size}），再回到「设置 → 音色库」点「导入音色文件」选它。`
  return `音源「${lib.name}」不提供应用内自动下载：${tail}`
}
