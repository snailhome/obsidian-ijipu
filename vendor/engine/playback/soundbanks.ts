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
  /** 联网直链（宿主无内置/本地文件时用） */
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
  },
]

/** 按 id 查音源库（找不到回退第一个 = 默认库） */
export function getHqLibrary(id?: string | null): HqSampleLibrary {
  if (id) {
    const found = HQ_LIBRARIES.find((l) => l.id === id)
    if (found) return found
  }
  return HQ_LIBRARIES[0]
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
